import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { Settings } from '@shared/types'
import { isHttpUrl } from '@shared/url'
import type { ApiController } from './api/controller'
import type { Repo } from './db/repo'
import { applySettingsPatch, llmSchema, readSettings, settingsPatchSchema } from './settings'
import { EXPORT_EXTENSIONS, exportText, importText } from './services/importExport'
import type { JobRunner } from './services/jobs'
import { fetchMetadata } from './services/metadata'
import { refreshBookmarkMetadata } from './services/refresh'
import type { TaggingService } from './tagging/service'
import { buildTidyPlan } from './tagging/tidy'
import { showLegalDocs } from './window'

const MAX_IMPORT_BYTES = 100 * 1024 * 1024

// ------------------------------------------------------------------ schemas
// Everything that crosses the IPC boundary is validated here; the renderer is treated as untrusted.

const id = z.number().int().positive()
const ids = z.array(id).max(200_000)
const text = (max: number) => z.string().max(max)
const imageUrl = z.string().max(4096).nullish()

const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('unsorted') }),
  z.object({ kind: z.literal('favorites') }),
  z.object({ kind: z.literal('broken') }),
  z.object({ kind: z.literal('trash') }),
  z.object({ kind: z.literal('collection'), id }),
  z.object({ kind: z.literal('tag'), name: text(200) })
])

const sortKey = z.enum(['created', 'updated', 'title', 'domain'])
const direction = z.enum(['asc', 'desc'])

const query = z.object({
  scope,
  search: text(500).optional(),
  includeArchived: z.boolean().optional(),
  directOnly: z.boolean().optional(),
  sort: sortKey,
  direction,
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0)
})

const tags = z.array(text(200)).max(200)
const signalsSchema = z.object({
  keywords: z.array(text(80)).max(30),
  ogType: text(80).nullable(),
  siteName: text(100).nullable(),
  lang: text(12).nullable(),
  section: text(80).nullable(),
  text: text(5000)
})

const bookmarkFields = {
  title: text(2000).optional(),
  note: text(50_000).optional(),
  excerpt: text(10_000).optional(),
  coverUrl: imageUrl,
  faviconUrl: imageUrl,
  collectionId: id.nullish(),
  tags: tags.optional(),
  tagSources: z.record(text(200), z.enum(['builtin', 'llm'])).optional(),
  signals: signalsSchema.nullish(),
  favorite: z.boolean().optional()
}
const bookmarkInput = z.object({ url: text(4096), ...bookmarkFields })
const bookmarkPatch = z.object({ url: text(4096).optional(), ...bookmarkFields })
const bulkPatch = z.object({
  collectionId: id.nullable().optional(),
  favorite: z.boolean().optional(),
  addTags: tags.optional(),
  removeTags: tags.optional()
})

const startJobOptions = z.object({
  scope: z.enum(['untagged', 'all', 'ids']).optional(),
  ids: ids.optional(),
  collectionId: id.optional(),
  useLlm: z.boolean().optional(),
  redo: z.boolean().optional()
})

const taggingTarget = z.union([
  z.object({ bookmarkId: id }),
  z.object({
    draft: z.object({
      url: text(4096),
      title: text(2000),
      excerpt: text(10_000),
      signals: signalsSchema.nullish(),
      tags: tags.optional()
    })
  })
])

const tidyRequest = z.object({
  merges: z.array(z.object({ keep: text(200), from: z.array(text(200)).max(200) })).max(20_000),
  remove: z.array(text(200)).max(50_000),
  rareMaxUses: z.number().int().min(1).max(50),
  keepOnlyTag: z.boolean()
})

const noArgs = z.tuple([])

// ------------------------------------------------------------------ helpers

export interface IpcContext {
  repo: Repo
  jobs: JobRunner
  tagging: TaggingService
  api: ApiController
  isTrustedUrl: (url: string) => boolean
  getWindow: () => BrowserWindow | null
}

export { readSettings }

export function applyTheme(settings: Settings): void {
  nativeTheme.themeSource = settings.theme
}

export function registerIpc(ctx: IpcContext): void {
  const { repo, jobs, tagging, api } = ctx

  function handle<S extends z.ZodType>(channel: string, schema: S, fn: (args: z.output<S>, event: IpcMainInvokeEvent) => unknown): void {
    ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
      const senderUrl = event.senderFrame?.url ?? ''
      if (!ctx.isTrustedUrl(senderUrl)) throw new Error('Untrusted sender')
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw new Error(`Invalid request for ${channel}`)
      return fn(parsed.data, event)
    })
  }

  // collections
  handle('collections:list', noArgs, () => repo.listCollections())
  handle(
    'collections:create',
    z.tuple([z.object({ name: text(200), parentId: id.nullish(), color: text(32).nullish() })]),
    ([input]) => repo.createCollection(input)
  )
  handle(
    'collections:update',
    z.tuple([id, z.object({ name: text(200).optional(), color: text(32).nullable().optional() })]),
    ([collectionId, patch]) => repo.updateCollection(collectionId, patch)
  )
  handle('collections:move', z.tuple([id, id.nullable(), z.number().int().min(0)]), ([collectionId, parentId, index]) =>
    repo.moveCollection(collectionId, parentId, index)
  )
  handle('collections:remove', z.tuple([id]), ([collectionId]) => repo.deleteCollection(collectionId))

  // the Archive: what you keep but do not use
  handle('archive:get', noArgs, () => repo.archive())
  handle('archive:bookmarks', z.tuple([ids]), ([bookmarkIds]) => repo.archiveBookmarks(bookmarkIds).moved)
  handle('archive:restoreBookmarks', z.tuple([ids]), ([bookmarkIds]) => repo.restoreBookmarks(bookmarkIds).moved)
  handle('archive:collections', z.tuple([ids]), ([collectionIds]) => repo.archiveCollections(collectionIds).moved)
  handle('archive:restoreCollections', z.tuple([ids]), ([collectionIds]) => repo.restoreCollections(collectionIds).moved)

  // bookmarks
  handle('bookmarks:query', z.tuple([query]), ([q]) => repo.query(q))
  handle('bookmarks:matchingIds', z.tuple([z.object({ scope, search: text(500).optional(), includeArchived: z.boolean().optional(), directOnly: z.boolean().optional() })]), ([q]) => repo.matchingIds(q))
  handle('bookmarks:get', z.tuple([id]), ([bookmarkId]) => repo.getBookmark(bookmarkId))
  handle('bookmarks:findByUrl', z.tuple([text(4096)]), ([url]) => repo.findByUrl(url))
  handle('bookmarks:create', z.tuple([bookmarkInput]), ([input]) => repo.createBookmark(input))
  handle('bookmarks:createMany', z.tuple([z.array(bookmarkInput).max(5000)]), ([inputs]) => {
    let skipped = 0
    const created: number[] = []
    repo.tx(() => {
      for (const input of inputs) {
        try {
          if (repo.findByUrl(input.url)) {
            skipped++
            continue
          }
          created.push(repo.createBookmark(input).id)
        } catch {
          skipped++
        }
      }
    })
    return { created: created.length, skipped, ids: created }
  })
  handle('bookmarks:update', z.tuple([id, bookmarkPatch]), ([bookmarkId, patch]) => repo.updateBookmark(bookmarkId, patch))
  handle('bookmarks:bulk', z.tuple([ids, bulkPatch]), ([bookmarkIds, patch]) => repo.bulkUpdate(bookmarkIds, patch))
  handle('bookmarks:trash', z.tuple([ids]), ([bookmarkIds]) => repo.trash(bookmarkIds))
  handle('bookmarks:restore', z.tuple([ids]), ([bookmarkIds]) => repo.restore(bookmarkIds))
  handle('bookmarks:purge', z.tuple([ids]), ([bookmarkIds]) => repo.purge(bookmarkIds))
  handle('bookmarks:emptyTrash', noArgs, () => repo.emptyTrash())
  handle('bookmarks:refreshMetadata', z.tuple([id]), ([bookmarkId]) => refreshBookmarkMetadata(repo, bookmarkId))

  // tags
  handle('tags:list', noArgs, () => repo.listTags())
  handle('tags:rename', z.tuple([text(200), text(200)]), ([from, to]) => repo.renameTag(from, to))
  handle('tags:remove', z.tuple([text(200)]), ([name]) => repo.removeTag(name))

  // metadata + tools
  handle('metadata:fetch', z.tuple([text(4096)]), ([url]) => fetchMetadata(url))
  handle('tools:findDuplicates', noArgs, () => repo.findDuplicateGroups())
  handle('tools:emptyCollections', noArgs, () => repo.emptyCollections())
  handle('tools:removeEmptyCollections', z.tuple([ids]), ([collectionIds]) => repo.removeEmptyCollections(collectionIds))
  handle('tools:lastCollectionTidy', noArgs, () => repo.lastTidy('collections'))
  handle('tools:undoCollectionTidy', z.tuple([id]), ([tidyId]) => repo.undoCollectionTidy(tidyId))
  handle('tools:startJob', z.tuple([z.enum(['check-links', 'fetch-metadata', 'auto-tag']), startJobOptions.optional()]), ([kind, options]) => jobs.start(kind, options ?? {}))
  handle('tools:cancelJob', z.tuple([text(100)]), ([jobId]) => jobs.cancel(jobId))

  // data
  handle('data:counts', noArgs, () => repo.counts())
  handle('data:import', noArgs, async () => {
    const win = ctx.getWindow()
    const options = {
      title: 'Import bookmarks',
      properties: ['openFile' as const],
      filters: [
        { name: 'Bookmarks (HTML, CSV, JSON)', extensions: ['html', 'htm', 'csv', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    if ((await stat(file)).size > MAX_IMPORT_BYTES) throw new Error('That file is too large to import (limit 100 MB).')
    const content = await readFile(file, 'utf8')
    const fileName = basename(file)
    return { ...importText(repo, fileName, content), fileName }
  })
  handle('data:export', z.tuple([z.enum(['html', 'csv', 'json']), z.boolean().optional()]), async ([format, includeArchived]) => {
    const win = ctx.getWindow()
    const { name, extension } = EXPORT_EXTENSIONS[format]
    const stamp = new Date().toISOString().slice(0, 10)
    const options = {
      title: 'Export bookmarks',
      defaultPath: join(app.getPath('documents'), `cairn-bookmarks-${stamp}.${extension}`),
      filters: [{ name, extensions: [extension] }]
    }
    const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    await writeFile(picked.filePath, exportText(repo, format, { includeArchived }), 'utf8')
    return picked.filePath
  })

  // settings
  handle('settings:get', noArgs, () => readSettings(repo))
  handle('settings:set', z.tuple([settingsPatchSchema]), async ([patch]) => {
    const settings = applySettingsPatch(repo, patch)
    applyTheme(settings)
    if (patch.api) await api.apply() // start, stop or move the local API
    return settings
  })

  // local API (the secret key stays in the main process)
  handle('api:status', noArgs, () => api.status())
  handle('api:copyBookmarklet', noArgs, () => {
    const status = api.status()
    if (!status.running) throw new Error(status.error ?? 'The local API is turned off. Turn it on in Settings first.')
    clipboard.writeText(api.bookmarklet())
  })
  handle('api:copyKey', noArgs, () => clipboard.writeText(api.key()))
  handle('api:resetKey', noArgs, () => api.resetKey())

  // tagging
  handle('tagging:suggest', z.tuple([taggingTarget, z.boolean()]), ([target, withLlm]) => tagging.suggestResult(target, withLlm))
  handle('tagging:ollama:status', z.tuple([llmSchema.partial().optional()]), ([overrides]) => tagging.llmStatus(overrides ?? {}))
  handle('tagging:ollama:progress', noArgs, () => tagging.llmProgress())
  handle('tagging:review:count', noArgs, () => repo.pendingProposalCount())
  handle('tagging:review:groups', noArgs, () => repo.proposalGroups())
  handle('tagging:review:items', z.tuple([text(200)]), ([tag]) => repo.proposalItems(tag))
  handle('tagging:review:apply', z.tuple([text(200), ids.optional()]), ([tag, bookmarkIds]) => repo.applyProposals(tag, bookmarkIds).applied)
  handle('tagging:review:reject', z.tuple([text(200), ids.optional()]), ([tag, bookmarkIds]) => repo.rejectProposals(tag, bookmarkIds))
  handle('tagging:review:never', z.tuple([text(200)]), ([tag]) => repo.neverSuggest(tag))
  handle('tagging:review:applyAll', noArgs, () => repo.applyAllProposals().applied)
  handle('tagging:review:discardAll', noArgs, () => repo.discardPendingProposals())
  handle('tagging:runs:last', noArgs, () => repo.lastRun())
  handle('tagging:runs:undo', z.tuple([id]), ([runId]) => repo.undoRun(runId))
  handle('tagging:runs:removeAuto', noArgs, () => repo.removeAutoTags())
  handle('tagging:tidy:plan', z.tuple([z.number().int().min(1).max(50)]), ([rareMaxUses]) => buildTidyPlan(repo.tagStats(), repo.tagsByBookmark(), rareMaxUses))
  handle('tagging:tidy:apply', z.tuple([tidyRequest]), ([request]) => repo.applyTidy(request))
  handle('tagging:tidy:last', noArgs, () => repo.lastTidy())
  handle('tagging:tidy:undo', z.tuple([id]), ([tidyId]) => repo.undoTidy(tidyId))

  // app
  handle('app:version', noArgs, () => app.getVersion())
  handle('app:openExternal', z.tuple([text(4096)]), async ([url]) => {
    if (!isHttpUrl(url)) throw new Error('Only http and https links can be opened')
    await shell.openExternal(url)
  })
  handle('app:copyText', z.tuple([text(200_000)]), ([value]) => clipboard.writeText(value))
  handle('app:showLegal', noArgs, () => showLegalDocs())
}
