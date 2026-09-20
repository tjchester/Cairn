import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { isHttpUrl } from '@shared/url'
import type { Repo } from './db/repo'
import { EXPORT_EXTENSIONS, exportText, importText } from './services/importExport'
import type { JobRunner } from './services/jobs'
import { fetchMetadata } from './services/metadata'
import { refreshBookmarkMetadata } from './services/refresh'
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
  sort: sortKey,
  direction,
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0)
})

const tags = z.array(text(200)).max(200)
const bookmarkFields = {
  title: text(2000).optional(),
  note: text(50_000).optional(),
  excerpt: text(10_000).optional(),
  coverUrl: imageUrl,
  faviconUrl: imageUrl,
  collectionId: id.nullish(),
  tags: tags.optional(),
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

const settingsPatch = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    view: z.enum(['list', 'grid', 'headlines']),
    sort: sortKey,
    direction,
    sidebarWidth: z.number().int().min(180).max(480)
  })
  .partial()
  .strict()

const noArgs = z.tuple([])

// ------------------------------------------------------------------ helpers

export interface IpcContext {
  repo: Repo
  jobs: JobRunner
  isTrustedUrl: (url: string) => boolean
  getWindow: () => BrowserWindow | null
}

export function readSettings(repo: Repo): Settings {
  const raw = repo.getSettingsRaw()
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'sidebarWidth') merged[key] = Number(value)
    else merged[key] = value
  }
  const parsed = settingsPatch.safeParse(merged)
  return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) }
}

export function applyTheme(settings: Settings): void {
  nativeTheme.themeSource = settings.theme
}

export function registerIpc(ctx: IpcContext): void {
  const { repo, jobs } = ctx

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

  // bookmarks
  handle('bookmarks:query', z.tuple([query]), ([q]) => repo.query(q))
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
  handle('tools:startJob', z.tuple([z.enum(['check-links', 'fetch-metadata'])]), ([kind]) => jobs.start(kind))
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
  handle('data:export', z.tuple([z.enum(['html', 'csv', 'json'])]), async ([format]) => {
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
    await writeFile(picked.filePath, exportText(repo, format), 'utf8')
    return picked.filePath
  })

  // settings
  handle('settings:get', noArgs, () => readSettings(repo))
  handle('settings:set', z.tuple([settingsPatch]), ([patch]) => {
    for (const [key, value] of Object.entries(patch)) repo.setSettingRaw(key, String(value))
    const settings = readSettings(repo)
    applyTheme(settings)
    return settings
  })

  // app
  handle('app:version', noArgs, () => app.getVersion())
  handle('app:openExternal', z.tuple([text(4096)]), async ([url]) => {
    if (!isHttpUrl(url)) throw new Error('Only http and https links can be opened')
    await shell.openExternal(url)
  })
  handle('app:copyText', z.tuple([text(200_000)]), ([value]) => clipboard.writeText(value))
  handle('app:showLegal', noArgs, () => showLegalDocs())
}
