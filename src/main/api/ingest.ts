import type { Bookmark, CaptureEvent, SuggestionOrigin, TagSuggestion } from '@shared/types'
import type { Repo } from '../db/repo'
import { EMPTY_SIGNALS, fetchMetadata, isTransientStatus, type MetadataResult } from '../services/metadata'
import { describeNetworkError } from '../services/net'
import type { TaggingService } from '../tagging/service'
import { ApiError } from './errors'
import type { CaptureRequest } from './schema'

// Takes a URL that arrived through the local API and does what the "New bookmark" dialog does: save it, look the
// page up for its details, and tag it. The bookmark is saved first so the caller gets an answer straight away;
// the slow parts run in the background and the window is told when they finish.

export type CaptureStatus = 'created' | 'exists' | 'restored'

export interface Enrichment {
  /** "done": details and tags were handled. "failed": the page could not be read (the bookmark is saved anyway). "none": nothing was asked for. */
  state: 'done' | 'failed' | 'none'
  note?: string
  /** The bookmark as it is now (null only if it was deleted in the meantime). */
  bookmark: Bookmark | null
  /** Tags waiting for the user's review (Suggest mode). */
  suggestions: { tag: string; score: number; origin: SuggestionOrigin }[]
}

export interface CaptureOutcome {
  status: CaptureStatus
  bookmark: Bookmark
  /** Whether details/tags are being filled in in the background. */
  enrichment: 'queued' | 'none'
  /** Resolves (never rejects) when the background work has finished. */
  done: Promise<Enrichment>
}

export interface IngestDeps {
  repo: Repo
  tagging: TaggingService
  fetcher?: (url: string) => Promise<MetadataResult>
  notify?: (event: CaptureEvent) => void
  /** Pause before the single retry of a failed page lookup. */
  retryDelayMs?: number
  /** How many pages are looked up at once. */
  concurrency?: number
}

/** More than this many waiting is a runaway caller, not a person clicking a bookmarklet. */
const MAX_WAITING = 500

class Limiter {
  private running = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly max: number) {}

  get waiting(): number {
    return this.waiters.length
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    // When full, wait for a finishing job to hand its slot over (the running count stays as it is).
    if (this.running >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve))
    else this.running++
    try {
      return await job()
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.running--
    }
  }
}

export function resolveCollection(repo: Repo, request: Pick<CaptureRequest, 'collection' | 'collectionId'>): number | null {
  if (request.collectionId !== undefined) {
    if (!repo.getCollection(request.collectionId)) throw new ApiError(400, 'unknown-collection', 'There is no collection with id ' + request.collectionId + '.')
    return request.collectionId
  }
  if (request.collection === undefined) return null
  const parts = request.collection.split('/').map((part) => part.trim()).filter(Boolean)
  const all = repo.listCollections()
  let parent: number | null = null
  for (const part of parts) {
    const match = all.find((c) => c.parentId === parent && c.name.toLowerCase() === part.toLowerCase())
    if (!match) throw new ApiError(400, 'unknown-collection', 'There is no collection "' + request.collection + '". Create it in Cairn first.')
    parent = match.id
  }
  return parent
}

export class IngestService {
  private readonly limiter: Limiter
  private readonly fetcher: (url: string) => Promise<MetadataResult>

  constructor(private readonly deps: IngestDeps) {
    this.limiter = new Limiter(deps.concurrency ?? 3)
    this.fetcher = deps.fetcher ?? ((url) => fetchMetadata(url))
  }

  capture(request: CaptureRequest): CaptureOutcome {
    const { repo } = this.deps
    const collectionId = resolveCollection(repo, request)
    const existing = repo.findByUrl(request.url, true)

    if (existing) {
      let restored = false
      if (existing.deletedAt) {
        repo.restore([existing.id])
        restored = true
      }
      if (request.onDuplicate === 'merge') this.merge(existing, request)
      const bookmark = repo.getBookmark(existing.id) as Bookmark
      this.deps.notify?.({ stage: 'exists', id: bookmark.id, title: bookmark.title })
      return { status: restored ? 'restored' : 'exists', bookmark, enrichment: 'none', done: Promise.resolve({ state: 'none', bookmark, suggestions: [] }) }
    }

    if (this.limiter.waiting >= MAX_WAITING) throw new ApiError(503, 'busy', 'Cairn is still working through earlier requests. Try again in a little while.')

    const bookmark = repo.createBookmark({
      url: request.url,
      title: request.title,
      note: request.note,
      excerpt: request.description,
      coverUrl: request.coverUrl,
      faviconUrl: request.faviconUrl,
      collectionId,
      tags: request.tags,
      favorite: request.favorite
    })
    this.deps.notify?.({ stage: 'saved', id: bookmark.id, title: bookmark.title })

    const taggingMode = request.autoTag ?? this.deps.tagging.mode()
    if (!request.fetch && taggingMode === 'off') {
      return { status: 'created', bookmark, enrichment: 'none', done: Promise.resolve({ state: 'none', bookmark, suggestions: [] }) }
    }
    const done = this.limiter
      .run(() => this.enrich(bookmark.id, request, taggingMode))
      .catch((error: unknown): Enrichment => ({
        state: 'failed',
        note: error instanceof Error ? error.message : String(error),
        bookmark: repo.getBookmark(bookmark.id) ?? bookmark,
        suggestions: []
      }))
    return { status: 'created', bookmark, enrichment: 'queued', done }
  }

  /** "Add it again" with `onDuplicate: merge`: keep what is there, add the new tags, and fill in a missing note. */
  private merge(existing: Bookmark, request: CaptureRequest): void {
    const { repo } = this.deps
    if (request.tags.length > 0) repo.bulkUpdate([existing.id], { addTags: request.tags })
    if (request.note && !existing.note) repo.updateBookmark(existing.id, { note: request.note })
  }

  private async lookUp(url: string): Promise<{ ok: true; meta: MetadataResult } | { ok: false; error: string }> {
    const attempts = 2
    let error = ''
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const meta = await this.fetcher(url)
        if (meta.status === null || meta.status < 400) return { ok: true, meta }
        error = 'The site answered with HTTP ' + meta.status + '.'
        if (!isTransientStatus(meta.status)) break
      } catch (caught) {
        error = 'Could not reach the site (' + describeNetworkError(caught) + ').'
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, this.deps.retryDelayMs ?? 3000))
    }
    return { ok: false, error }
  }

  private async enrich(id: number, request: CaptureRequest, mode: 'off' | 'suggest' | 'auto'): Promise<Enrichment> {
    const { repo, tagging } = this.deps
    const notes: string[] = []
    let detailsFailed = false

    const start = repo.getBookmark(id)
    if (!start) return { state: 'failed', note: 'The bookmark was removed before its details arrived.', bookmark: null, suggestions: [] }

    if (request.fetch) {
      const found = await this.lookUp(start.url)
      if (found.ok) {
        // A title you supplied is kept: applyMetadata only replaces a title that was just the address.
        repo.applyMetadata(id, { ...found.meta, signals: found.meta.signals ?? EMPTY_SIGNALS })
      } else {
        detailsFailed = true
        notes.push(found.error + ' The bookmark is saved; "Fetch missing details" in Tools will try again.')
      }
    }

    if (mode !== 'off') {
      try {
        const candidate = repo.getTaggingCandidate(id)
        if (candidate) {
          const context = tagging.context()
          let suggestions: TagSuggestion[]
          if (request.useLlm && tagging.llmEnabled()) {
            try {
              suggestions = await tagging.suggestForCandidateWithLlm(candidate, context)
            } catch (error) {
              notes.push('The local model was not used: ' + (error instanceof Error ? error.message : String(error)))
              suggestions = tagging.suggestForCandidate(candidate, context)
            }
          } else {
            suggestions = tagging.suggestForCandidate(candidate, context)
          }
          if (suggestions.length > 0) {
            // Each capture gets its own run, kept apart from bulk runs ("Undo last run" is about those).
            const runId = repo.createRun('capture', mode)
            const result = tagging.deliver(id, suggestions, mode, runId)
            repo.finishRun(runId, mode === 'auto' ? result.added : 0, result.added > 0 ? 1 : 0)
          }
        }
      } catch (error) {
        notes.push('Tag suggestions failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }

    const bookmark = repo.getBookmark(id)
    if (!bookmark) return { state: 'failed', note: 'The bookmark was removed while it was being filled in.', bookmark: null, suggestions: [] }
    this.deps.notify?.({ stage: 'enriched', id, title: bookmark.title })
    return {
      state: detailsFailed ? 'failed' : 'done',
      note: notes.length > 0 ? notes.join(' ') : undefined,
      bookmark,
      suggestions: repo.pendingProposalsFor(id)
    }
  }
}
