import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type {
  Bookmark,
  BookmarkInput,
  BookmarkPage,
  BookmarkPatch,
  BookmarkQuery,
  BulkPatch,
  Collection,
  Counts,
  EmptyCollection,
  LinkStatus,
  PageSignals,
  ProposalGroup,
  ProposalItem,
  Scope,
  SuggestionOrigin,
  TagInfo,
  TagRunInfo,
  TidyLogInfo,
  TidyRequest,
  TidyResult
} from '@shared/types'
import { buildTree, subtreeCounts } from '@shared/collections'
import { coerceUrl, domainOf, isHttpUrl, urlKey } from '@shared/url'
import { canon, GENERIC_TAGS } from '../tagging/text'
import { buildSearchClauses, parseSearch, type SqlValue } from './search'

type Row = Record<string, unknown>

// What "Tidy tags" records so that it can be undone.
interface TidyMergeRow {
  b: number
  from: string
  to: string
  source: string
  runId: number | null
  /** The kept tag's own row on this bookmark before the merge (null: the bookmark did not have it). */
  keeperBefore: { source: string; runId: number | null } | null
}
/** Orders removed collections so that a parent always comes before its children. */
function parentsFirst(rows: readonly TidyCollectionRow[]): TidyCollectionRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out: TidyCollectionRow[] = []
  const done = new Set<number>()
  const visit = (row: TidyCollectionRow): void => {
    if (done.has(row.id)) return
    done.add(row.id)
    const parent = row.parentId === null ? undefined : byId.get(row.parentId)
    if (parent) visit(parent)
    out.push(row)
  }
  rows.forEach(visit)
  return out
}

interface TidyCollectionRow {
  id: number
  parentId: number | null
  name: string
  color: string | null
  position: number
}
interface TidyRemovedRow {
  b: number
  tag: string
  source: string
  runId: number | null
}

const TAG_SEPARATOR = '\x1f'
const MAX_TITLE = 500
const MAX_NOTE = 20_000
const MAX_EXCERPT = 2_000
const MAX_NAME = 100
const MAX_TAG = 50
const MAX_TAGS_PER_BOOKMARK = 50
const CHUNK = 500

// Explicit columns (not b.*) so the bulky search_text and signals never travel with list queries.
const BOOKMARK_SELECT = `
  SELECT b.id, b.collection_id, b.url, b.title, b.note, b.excerpt, b.cover_url, b.favicon_url, b.domain,
    b.favorite, b.status, b.http_status, b.last_checked_at, b.created_at, b.updated_at, b.deleted_at,
    (SELECT group_concat(t.name, char(31))
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
      WHERE bt.bookmark_id = b.id) AS tag_names,
    (SELECT group_concat(t.name, char(31))
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
      WHERE bt.bookmark_id = b.id AND bt.source <> 'user') AS auto_tag_names
  FROM bookmarks b`

type Provenance = { source: SuggestionOrigin; runId: number | null }

/** Parses the stored page signals, tolerating anything unexpected. */
function parseSignals(raw: unknown): PageSignals | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PageSignals> | null
    if (!v || typeof v !== 'object') return null
    return {
      keywords: Array.isArray(v.keywords) ? v.keywords.filter((k): k is string => typeof k === 'string') : [],
      ogType: typeof v.ogType === 'string' ? v.ogType : null,
      siteName: typeof v.siteName === 'string' ? v.siteName : null,
      lang: typeof v.lang === 'string' ? v.lang : null,
      section: typeof v.section === 'string' ? v.section : null,
      text: typeof v.text === 'string' ? v.text : ''
    }
  } catch {
    return null
  }
}

export interface TaggingCandidate {
  id: number
  url: string
  title: string
  excerpt: string
  tags: string[]
  signals: PageSignals | null
}

const SORT_COLUMNS = {
  created: 'b.created_at',
  updated: 'b.updated_at',
  title: 'b.title COLLATE NOCASE',
  domain: 'b.domain'
} as const

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function trimTo(value: string | undefined | null, max: number): string {
  return (value ?? '').replace(/\s+$/g, '').trim().slice(0, max)
}

/** Image URLs come from scraped pages, imports and the renderer: only http(s) is ever stored. */
function safeImageUrl(value: string | null | undefined): string | null {
  return value && value.length <= 4096 && isHttpUrl(value) ? value : null
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',')
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags ?? []) {
    const tag = raw
      .replaceAll(TAG_SEPARATOR, '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TAG)
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS_PER_BOOKMARK) break
  }
  return out
}

function toBookmark(row: Row): Bookmark {
  const tagNames = typeof row.tag_names === 'string' && row.tag_names ? row.tag_names.split(TAG_SEPARATOR) : []
  const autoNames = typeof row.auto_tag_names === 'string' && row.auto_tag_names ? row.auto_tag_names.split(TAG_SEPARATOR) : []
  return {
    id: Number(row.id),
    url: String(row.url),
    title: String(row.title),
    note: String(row.note),
    excerpt: String(row.excerpt),
    coverUrl: (row.cover_url as string | null) ?? null,
    faviconUrl: (row.favicon_url as string | null) ?? null,
    domain: String(row.domain),
    collectionId: row.collection_id === null ? null : Number(row.collection_id),
    tags: tagNames.sort((a, b) => a.localeCompare(b)),
    autoTags: autoNames.sort((a, b) => a.localeCompare(b)),
    favorite: Number(row.favorite) === 1,
    status: row.status as LinkStatus,
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    lastCheckedAt: (row.last_checked_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: (row.deleted_at as string | null) ?? null
  }
}

function toCollection(row: Row): Collection {
  const collection: Collection = {
    id: Number(row.id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    name: String(row.name),
    color: (row.color as string | null) ?? null,
    position: Number(row.position)
  }
  if (row.role === 'archive') collection.role = 'archive'
  return collection
}

/** The Archive and everything filed below it, as a sub-query. */
const ARCHIVE_IDS = `WITH RECURSIVE arc(id) AS (
    SELECT id FROM collections WHERE role = 'archive'
    UNION ALL SELECT c.id FROM collections c JOIN arc ON c.parent_id = arc.id
  ) SELECT id FROM arc`

/** Bookmarks outside the Archive: what the ordinary lists, counts and jobs work on. */
const NOT_ARCHIVED = `(b.collection_id IS NULL OR b.collection_id NOT IN (${ARCHIVE_IDS}))`

export class Repo {
  private readonly statements = new Map<string, StatementSync>()
  private depth = 0

  constructor(private readonly db: DatabaseSync) {}

  // ---------------------------------------------------------------- plumbing

  private prep(sql: string): StatementSync {
    let stmt = this.statements.get(sql)
    if (!stmt) {
      stmt = this.db.prepare(sql)
      this.statements.set(sql, stmt)
    }
    return stmt
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.prep(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.prep(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: SqlValue[]): number {
    return Number(this.prep(sql).run(...params).changes)
  }

  private insert(sql: string, ...params: SqlValue[]): number {
    return Number(this.prep(sql).run(...params).lastInsertRowid)
  }

  /** Runs `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.exec('BEGIN')
    this.depth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth--
    }
  }

  // ------------------------------------------------------------- collections

  listCollections(): Collection[] {
    return this.all('SELECT * FROM collections ORDER BY position, id').map(toCollection)
  }

  getCollection(id: number): Collection | null {
    const row = this.get('SELECT * FROM collections WHERE id = ?', id)
    return row ? toCollection(row) : null
  }

  createCollection(input: { name: string; parentId?: number | null; color?: string | null }): Collection {
    const name = trimTo(input.name, MAX_NAME)
    if (!name) throw new Error('Collection name is required')
    const parentId = input.parentId ?? null
    if (parentId !== null && !this.getCollection(parentId)) throw new Error('Parent collection not found')
    const now = new Date().toISOString()
    const next = this.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM collections WHERE parent_id IS ?', parentId)
    const id = this.insert(
      'INSERT INTO collections (parent_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      parentId,
      name,
      input.color ?? null,
      Number(next?.p ?? 0),
      now,
      now
    )
    return this.getCollection(id) as Collection
  }

  updateCollection(id: number, patch: { name?: string; color?: string | null }): Collection {
    const existing = this.getCollection(id)
    if (!existing) throw new Error('Collection not found')
    const name = patch.name === undefined ? existing.name : trimTo(patch.name, MAX_NAME)
    if (!name) throw new Error('Collection name is required')
    const color = patch.color === undefined ? existing.color : patch.color
    this.run('UPDATE collections SET name = ?, color = ?, updated_at = ? WHERE id = ?', name, color, new Date().toISOString(), id)
    return this.getCollection(id) as Collection
  }

  /** IDs of every collection below `id` (not including `id` itself). */
  descendantIds(id: number): number[] {
    return this.all(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM collections WHERE parent_id = ?
         UNION ALL
         SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id
       ) SELECT id FROM sub`,
      id
    ).map((r) => Number(r.id))
  }

  moveCollection(id: number, parentId: number | null, index: number): void {
    const moving = this.getCollection(id)
    if (!moving) throw new Error('Collection not found')
    if (moving.role === 'archive' && parentId !== null) throw new Error('The Archive stays at the top level.')
    if (parentId !== null) {
      if (!this.getCollection(parentId)) throw new Error('Target collection not found')
      if (parentId === id || this.descendantIds(id).includes(parentId)) {
        throw new Error('A collection cannot be moved into itself')
      }
    }
    this.tx(() => {
      const siblings = this.all('SELECT id FROM collections WHERE parent_id IS ? AND id <> ? ORDER BY position, id', parentId, id).map(
        (r) => Number(r.id)
      )
      const at = Math.max(0, Math.min(index, siblings.length))
      siblings.splice(at, 0, id)
      this.run('UPDATE collections SET parent_id = ?, updated_at = ? WHERE id = ?', parentId, new Date().toISOString(), id)
      siblings.forEach((siblingId, position) => this.run('UPDATE collections SET position = ? WHERE id = ?', position, siblingId))
    })
  }

  /** Deletes a collection and its sub-collections. Their bookmarks are moved to the Trash. */
  deleteCollection(id: number): { trashed: number } {
    const collection = this.getCollection(id)
    if (!collection) throw new Error('Collection not found')
    if (collection.role === 'archive') throw new Error('The Archive cannot be deleted. Empty it instead, or rename it.')
    return this.tx(() => {
      const ids = [id, ...this.descendantIds(id)]
      const now = new Date().toISOString()
      let trashed = 0
      for (const part of chunk(ids)) {
        const marks = placeholders(part.length)
        trashed += this.run(`UPDATE bookmarks SET deleted_at = ? WHERE deleted_at IS NULL AND collection_id IN (${marks})`, now, ...part)
        this.run(`UPDATE bookmarks SET collection_id = NULL WHERE collection_id IN (${marks})`, ...part)
      }
      this.run('DELETE FROM collections WHERE id = ?', id) // sub-collections cascade
      return { trashed }
    })
  }

  /**
   * Collections holding no bookmarks at all, anywhere below them: what "Tidy collections" offers to remove.
   * A bookmark in the Trash still counts as content, so a collection is not swept away while its bookmarks could
   * still be restored into it. Deepest first, so a listing reads from the leaves up.
   */
  emptyCollections(): EmptyCollection[] {
    const collections = this.listCollections()
    const direct: Record<number, number> = {}
    for (const row of this.all('SELECT collection_id AS id, COUNT(*) AS n FROM bookmarks WHERE collection_id IS NOT NULL GROUP BY collection_id')) {
      direct[Number(row.id)] = Number(row.n)
    }
    const totals = subtreeCounts(buildTree(collections), direct)
    return collections
      .filter((c) => c.role !== 'archive' && (totals.get(c.id) ?? 0) === 0)
      .map((c) => {
        const parts = this.collectionPath(c.id, collections)
        return { id: c.id, name: c.name, path: parts.join(' / '), depth: parts.length }
      })
      .sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path))
      .map(({ id, name, path }) => ({ id, name, path }))
  }

  /**
   * Removes the given collections, but only those that are still empty (nothing was added while you looked at the
   * list). Sub-collections go with their parent, so removing a whole empty branch takes one delete.
   */
  removeEmptyCollections(ids: number[]): { removed: number; id: number | null } {
    return this.tx(() => {
      const allowed = new Set(this.emptyCollections().map((c) => c.id))
      const gone: TidyCollectionRow[] = []
      for (const id of ids) {
        if (!allowed.has(id) || !this.getCollection(id)) continue // not empty any more, or already gone with its parent
        // Remember the whole branch so it can be rebuilt in the same shape.
        for (const branchId of [id, ...this.descendantIds(id)]) {
          const c = this.getCollection(branchId)
          if (c) gone.push({ id: c.id, parentId: c.parentId, name: c.name, color: c.color, position: c.position })
        }
        this.run('DELETE FROM collections WHERE id = ?', id) // sub-collections cascade
      }
      if (gone.length === 0) return { removed: 0, id: null }
      return { removed: gone.length, id: this.logTidy('collections', 0, gone.length, { collections: gone }) }
    })
  }

  /**
   * Puts back the collections a tidy removed, with their names, colours and nesting. Each keeps its old id when that
   * is still free, so anything pointing at it lines up again; one taken by a collection made since gets a new id.
   * A collection whose parent has gone in the meantime comes back at the top level.
   */
  undoCollectionTidy(id: number): { restored: number } {
    return this.tx(() => {
      const { collections } = this.readTidy(id, 'collections') as { collections: TidyCollectionRow[] }
      const remap = new Map<number, number>()
      let restored = 0
      // Put a parent back before its children, so each child has somewhere to go.
      for (const c of parentsFirst(collections)) {
        // Everything here was removed, so an id that is in use again belongs to something made since: leave that be
        // and give this one a new id instead.
        const parentId = c.parentId === null ? null : (remap.get(c.parentId) ?? (this.getCollection(c.parentId) ? c.parentId : null))
        const free = this.get('SELECT 1 AS x FROM collections WHERE id = ?', c.id) === undefined
        if (free) {
          const now = new Date().toISOString()
          this.run(
            'INSERT INTO collections (id, parent_id, name, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            c.id,
            parentId,
            c.name,
            c.color,
            c.position,
            now,
            now
          )
          remap.set(c.id, c.id)
        } else {
          remap.set(c.id, this.createCollection({ name: c.name, parentId, color: c.color }).id)
        }
        restored++
      }
      this.run('UPDATE tidy_log SET undone = 1 WHERE id = ?', id)
      return { restored }
    })
  }

  // ---------------------------------------------------------------- archive

  /** The Archive, if there is one yet. */
  archive(): Collection | null {
    const row = this.get("SELECT * FROM collections WHERE role = 'archive'")
    return row ? toCollection(row) : null
  }

  /** The Archive, made the first time something is sent to it. Always at the top level. */
  ensureArchive(name = 'Archive'): Collection {
    const existing = this.archive()
    if (existing) return existing
    return this.tx(() => {
      const made = this.createCollection({ name })
      this.run("UPDATE collections SET role = 'archive' WHERE id = ?", made.id)
      return this.getCollection(made.id) as Collection
    })
  }

  /** The Archive and every collection below it. */
  archivedCollectionIds(): number[] {
    return this.all(ARCHIVE_IDS).map((r) => Number(r.id))
  }

  /** Whether a collection is the Archive or sits inside it (null means Unsorted, which never is). */
  inArchive(collectionId: number | null): boolean {
    if (collectionId === null) return false
    return this.get(`SELECT 1 AS x FROM (${ARCHIVE_IDS}) WHERE id = ?`, collectionId) !== undefined
  }

  /** Finds or makes the path below `parentId`, e.g. ["Menus", "College"] under the Archive. */
  private ensurePathUnder(parentId: number | null, path: readonly string[]): number | null {
    let cursor = parentId
    for (const name of path) {
      if (!trimTo(name, MAX_NAME)) continue
      cursor = this.findOrCreateCollection(cursor, name).id
    }
    return cursor
  }

  /**
   * Moves `sourceId` under `targetParentId`. If a collection of the same name is already there, the two are merged:
   * the bookmarks and sub-collections move across and the empty original goes.
   */
  private mergeUnder(sourceId: number, targetParentId: number | null): number {
    const source = this.getCollection(sourceId)
    if (!source) return sourceId
    const twin = this.get(
      'SELECT id FROM collections WHERE parent_id IS ? AND name = ? COLLATE NOCASE AND id <> ? LIMIT 1',
      targetParentId,
      source.name,
      sourceId
    )
    if (!twin) {
      const next = Number(this.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM collections WHERE parent_id IS ?', targetParentId)?.p ?? 0)
      this.run('UPDATE collections SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?', targetParentId, next, new Date().toISOString(), sourceId)
      return sourceId
    }
    const keepId = Number(twin.id)
    for (const child of this.all('SELECT id FROM collections WHERE parent_id = ?', sourceId)) this.mergeUnder(Number(child.id), keepId)
    this.run('UPDATE bookmarks SET collection_id = ? WHERE collection_id = ?', keepId, sourceId)
    this.run('DELETE FROM collections WHERE id = ?', sourceId)
    return keepId
  }

  /** Where a bookmark or collection would land in the Archive: the same path it has now, made if need be. */
  private archiveTargetFor(collectionId: number | null, archiveId: number): number | null {
    if (collectionId === null) return archiveId
    return this.ensurePathUnder(archiveId, this.collectionPath(collectionId))
  }

  /**
   * Sends bookmarks to the Archive, rebuilding the folders they are in: one from "Menus / College" lands in
   * "Archive / Menus / College". Suggestions waiting on them are dropped, since they are out of the way now.
   */
  archiveBookmarks(ids: number[]): { moved: number } {
    if (ids.length === 0) return { moved: 0 }
    return this.tx(() => {
      const archiveId = this.ensureArchive().id
      let moved = 0
      const targets = new Map<number | null, number | null>()
      for (const id of ids) {
        const bookmark = this.getBookmark(id)
        if (!bookmark || this.inArchive(bookmark.collectionId)) continue
        if (!targets.has(bookmark.collectionId)) targets.set(bookmark.collectionId, this.archiveTargetFor(bookmark.collectionId, archiveId))
        this.updateBookmark(id, { collectionId: targets.get(bookmark.collectionId) ?? archiveId })
        this.run("UPDATE tag_proposals SET status = 'rejected' WHERE bookmark_id = ? AND status IN ('pending', 'held')", id)
        moved++
      }
      return { moved }
    })
  }

  /** Brings bookmarks back out, to the same path in the live tree (the Archive's own root means Unsorted). */
  restoreBookmarks(ids: number[]): { moved: number } {
    if (ids.length === 0) return { moved: 0 }
    return this.tx(() => {
      const archiveId = this.archive()?.id ?? null
      if (archiveId === null) return { moved: 0 }
      let moved = 0
      const targets = new Map<number, number | null>()
      for (const id of ids) {
        const bookmark = this.getBookmark(id)
        if (!bookmark || bookmark.collectionId === null || !this.inArchive(bookmark.collectionId)) continue
        if (!targets.has(bookmark.collectionId)) {
          const path = this.collectionPath(bookmark.collectionId).slice(1) // drop the Archive's own name
          targets.set(bookmark.collectionId, path.length === 0 ? null : this.ensureCollectionPath(path))
        }
        this.updateBookmark(id, { collectionId: targets.get(bookmark.collectionId) ?? null })
        moved++
      }
      return { moved }
    })
  }

  /** Sends whole collections to the Archive, keeping the path they were filed under. */
  archiveCollections(ids: number[]): { moved: number } {
    if (ids.length === 0) return { moved: 0 }
    return this.tx(() => {
      const archiveId = this.ensureArchive().id
      let moved = 0
      for (const id of ids) {
        const collection = this.getCollection(id)
        if (!collection || collection.role === 'archive' || this.inArchive(id)) continue
        const parentPath = collection.parentId === null ? [] : this.collectionPath(collection.parentId)
        this.mergeUnder(id, this.ensurePathUnder(archiveId, parentPath))
        moved++
      }
      return { moved }
    })
  }

  /** Brings whole collections back out of the Archive, to the path they were kept under. */
  restoreCollections(ids: number[]): { moved: number } {
    if (ids.length === 0) return { moved: 0 }
    return this.tx(() => {
      let moved = 0
      for (const id of ids) {
        const collection = this.getCollection(id)
        if (!collection || collection.role === 'archive' || !this.inArchive(id)) continue
        const parentPath = collection.parentId === null ? [] : this.collectionPath(collection.parentId).slice(1)
        this.mergeUnder(id, parentPath.length === 0 ? null : this.ensureCollectionPath(parentPath))
        moved++
      }
      return { moved }
    })
  }

  /** Finds a child collection by name (case-insensitive) or creates it. `created` reports which happened. */
  findOrCreateCollection(
    parentId: number | null,
    rawName: string,
    color: string | null = null
  ): { id: number; created: boolean } {
    const name = trimTo(rawName, MAX_NAME)
    if (!name) throw new Error('Collection name is required')
    const existing = this.get('SELECT id FROM collections WHERE parent_id IS ? AND name = ? COLLATE NOCASE LIMIT 1', parentId, name)
    if (existing) return { id: Number(existing.id), created: false }
    return { id: this.createCollection({ name, parentId, color }).id, created: true }
  }

  /** Finds or creates a nested collection for a path such as ["Dev", "Rust"]. Empty path means Unsorted (null). */
  ensureCollectionPath(path: string[]): number | null {
    let parentId: number | null = null
    for (const name of path) {
      if (!trimTo(name, MAX_NAME)) continue
      parentId = this.findOrCreateCollection(parentId, name).id
    }
    return parentId
  }

  /** Full "A / B / C" style path parts for a collection (root first). */
  collectionPath(id: number | null, collections: Collection[] = this.listCollections()): string[] {
    const byId = new Map(collections.map((c) => [c.id, c]))
    const parts: string[] = []
    let cursor = id === null ? undefined : byId.get(id)
    const guard = new Set<number>()
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id)
      parts.unshift(cursor.name)
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    return parts
  }

  // --------------------------------------------------------------- bookmarks

  getBookmark(id: number): Bookmark | null {
    const row = this.get(`${BOOKMARK_SELECT} WHERE b.id = ?`, id)
    return row ? toBookmark(row) : null
  }

  findByUrl(url: string, includeTrashed = false): Bookmark | null {
    let key: string
    try {
      key = urlKey(coerceUrl(url))
    } catch {
      return null
    }
    const row = this.get(
      `${BOOKMARK_SELECT} WHERE b.url_key = ? ${includeTrashed ? '' : 'AND b.deleted_at IS NULL'} ORDER BY b.id LIMIT 1`,
      key
    )
    return row ? toBookmark(row) : null
  }

  createBookmark(input: BookmarkInput): Bookmark {
    const url = coerceUrl(input.url)
    const domain = domainOf(url)
    const now = new Date().toISOString()
    const collectionId = this.validCollectionId(input.collectionId)
    const id = this.tx(() => {
      const newId = this.insert(
        `INSERT INTO bookmarks
           (collection_id, url, url_key, title, note, excerpt, cover_url, favicon_url, domain, favorite, created_at, updated_at, signals)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        collectionId,
        url,
        urlKey(url),
        trimTo(input.title, MAX_TITLE) || domain || url,
        trimTo(input.note, MAX_NOTE),
        trimTo(input.excerpt, MAX_EXCERPT),
        safeImageUrl(input.coverUrl),
        safeImageUrl(input.faviconUrl),
        domain,
        input.favorite ? 1 : 0,
        input.createdAt ?? now,
        now,
        input.signals ? JSON.stringify(input.signals) : null
      )
      const provenance: Record<string, Provenance> = {}
      for (const [tag, source] of Object.entries(input.tagSources ?? {})) provenance[tag.replace(/^#+/, '').trim().toLowerCase()] = { source, runId: null }
      this.setTags(newId, input.tags, provenance)
      this.refreshSearchText([newId])
      return newId
    })
    return this.getBookmark(id) as Bookmark
  }

  updateBookmark(id: number, patch: BookmarkPatch): Bookmark {
    const existing = this.getBookmark(id)
    if (!existing) throw new Error('Bookmark not found')
    this.tx(() => {
      const sets: string[] = []
      const params: SqlValue[] = []
      const set = (column: string, value: SqlValue): void => {
        sets.push(`${column} = ?`)
        params.push(value)
      }

      if (patch.url !== undefined) {
        const url = coerceUrl(patch.url)
        if (url !== existing.url) {
          set('url', url)
          set('url_key', urlKey(url))
          set('domain', domainOf(url))
          set('status', 'unknown')
          set('http_status', null)
          set('last_checked_at', null)
        }
      }
      if (patch.title !== undefined) set('title', trimTo(patch.title, MAX_TITLE) || existing.domain || existing.url)
      if (patch.note !== undefined) set('note', trimTo(patch.note, MAX_NOTE))
      if (patch.excerpt !== undefined) set('excerpt', trimTo(patch.excerpt, MAX_EXCERPT))
      if (patch.coverUrl !== undefined) set('cover_url', safeImageUrl(patch.coverUrl))
      if (patch.faviconUrl !== undefined) set('favicon_url', safeImageUrl(patch.faviconUrl))
      if (patch.favorite !== undefined) set('favorite', patch.favorite ? 1 : 0)
      if (patch.collectionId !== undefined) set('collection_id', this.validCollectionId(patch.collectionId))

      set('updated_at', new Date().toISOString())
      this.run(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
      if (patch.tags !== undefined) this.setTags(id, patch.tags)
      this.refreshSearchText([id])
    })
    return this.getBookmark(id) as Bookmark
  }

  bulkUpdate(ids: number[], patch: BulkPatch): void {
    if (ids.length === 0) return
    const collectionId = patch.collectionId === undefined ? undefined : this.validCollectionId(patch.collectionId)
    const add = normalizeTags(patch.addTags)
    const remove = new Set(normalizeTags(patch.removeTags).map((t) => t.toLowerCase()))
    const now = new Date().toISOString()
    this.tx(() => {
      for (const part of chunk(ids)) {
        const marks = placeholders(part.length)
        if (collectionId !== undefined) {
          this.run(`UPDATE bookmarks SET collection_id = ?, updated_at = ? WHERE id IN (${marks})`, collectionId, now, ...part)
        }
        if (patch.favorite !== undefined) {
          this.run(`UPDATE bookmarks SET favorite = ?, updated_at = ? WHERE id IN (${marks})`, patch.favorite ? 1 : 0, now, ...part)
        }
      }
      if (add.length > 0 || remove.size > 0) {
        for (const id of ids) {
          const current = this.tagNamesFor(id)
          const next = normalizeTags([...current.filter((t) => !remove.has(t.toLowerCase())), ...add])
          this.setTags(id, next)
          this.run('UPDATE bookmarks SET updated_at = ? WHERE id = ?', now, id)
        }
      }
      this.refreshSearchText(ids)
    })
  }

  trash(ids: number[]): void {
    const now = new Date().toISOString()
    this.tx(() => {
      for (const part of chunk(ids)) {
        this.run(`UPDATE bookmarks SET deleted_at = ? WHERE deleted_at IS NULL AND id IN (${placeholders(part.length)})`, now, ...part)
      }
    })
  }

  restore(ids: number[]): void {
    this.tx(() => {
      for (const part of chunk(ids)) {
        this.run(`UPDATE bookmarks SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND id IN (${placeholders(part.length)})`, ...part)
      }
    })
  }

  /** Permanently deletes bookmarks that are already in the Trash. */
  purge(ids: number[]): void {
    this.tx(() => {
      for (const part of chunk(ids)) {
        this.run(`DELETE FROM bookmarks WHERE deleted_at IS NOT NULL AND id IN (${placeholders(part.length)})`, ...part)
      }
      this.pruneTags()
    })
  }

  emptyTrash(): number {
    return this.tx(() => {
      const removed = this.run('DELETE FROM bookmarks WHERE deleted_at IS NOT NULL')
      this.pruneTags()
      return removed
    })
  }

  private validCollectionId(id: number | null | undefined): number | null {
    if (id === null || id === undefined) return null
    if (!this.getCollection(id)) throw new Error('Collection not found')
    return id
  }

  // ------------------------------------------------------------------- query

  /** The WHERE clause (and its parameters) for a scope and search box: what "the list you are looking at" means. */
  private filterFor(q: { scope: Scope; search?: string; includeArchived?: boolean; directOnly?: boolean }): { where: string; params: SqlValue[] } {
    const clauses: string[] = []
    const params: SqlValue[] = []
    this.applyScope(q.scope, clauses, params, q.directOnly === true)

    const parsed = parseSearch(q.search ?? '')
    const search = buildSearchClauses(parsed)
    clauses.push(...search.clauses)
    params.push(...search.params)

    // What is in the Archive stays out of the way, unless you ask for it, search for it, or are looking inside it.
    // The Trash is the one exception: it shows everything you deleted, wherever it was kept.
    const lookingInside = q.scope.kind === 'trash' || (q.scope.kind === 'collection' && this.inArchive(q.scope.id))
    if (parsed.archived) clauses.push(`b.collection_id IN (${ARCHIVE_IDS})`)
    else if (!q.includeArchived && !lookingInside) clauses.push(NOT_ARCHIVED)
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
  }

  /**
   * Every bookmark the current list would show, however far it has been scrolled: what "select all" means.
   * Ids only, so a selection of thousands costs little.
   */
  matchingIds(q: { scope: Scope; search?: string; includeArchived?: boolean; directOnly?: boolean }, limit = 200_000): number[] {
    const { where, params } = this.filterFor(q)
    return this.all(`SELECT b.id FROM bookmarks b ${where} ORDER BY b.id LIMIT ?`, ...params, Math.max(1, limit)).map((r) => Number(r.id))
  }

  query(q: BookmarkQuery): BookmarkPage {
    const { where, params } = this.filterFor(q)
    const dir = q.direction === 'asc' ? 'ASC' : 'DESC'
    const order = `${SORT_COLUMNS[q.sort]} ${dir}, b.id ${dir}`
    const limit = Math.max(1, Math.min(q.limit, 1000))
    const offset = Math.max(0, q.offset)

    const total = Number(this.get(`SELECT COUNT(*) AS n FROM bookmarks b ${where}`, ...params)?.n ?? 0)
    const items = this.all(`${BOOKMARK_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(toBookmark)
    return { items, total }
  }

  /** `directOnly` narrows a collection to what is filed in it, rather than everything below it as well. */
  private applyScope(scope: Scope, clauses: string[], params: SqlValue[], directOnly = false): void {
    if (scope.kind === 'trash') {
      clauses.push('b.deleted_at IS NOT NULL')
      return
    }
    clauses.push('b.deleted_at IS NULL')
    switch (scope.kind) {
      case 'all':
        break
      case 'unsorted':
        clauses.push('b.collection_id IS NULL')
        break
      case 'favorites':
        clauses.push('b.favorite = 1')
        break
      case 'broken':
        clauses.push("b.status = 'broken'")
        break
      case 'collection':
        clauses.push(
          directOnly
            ? 'b.collection_id = ?'
            : `b.collection_id IN (
             WITH RECURSIVE sub(id) AS (
               SELECT ? UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id
             ) SELECT id FROM sub)`
        )
        params.push(scope.id)
        break
      case 'tag':
        clauses.push(
          'EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND t.name = ?)'
        )
        params.push(scope.name)
        break
    }
  }

  counts(): Counts {
    const totals = this.get(
      `SELECT
         COALESCE(SUM(deleted_at IS NULL AND ${NOT_ARCHIVED}), 0)                          AS total,
         COALESCE(SUM(deleted_at IS NULL AND collection_id IS NULL), 0)                    AS unsorted,
         COALESCE(SUM(deleted_at IS NULL AND favorite = 1 AND ${NOT_ARCHIVED}), 0)         AS favorites,
         COALESCE(SUM(deleted_at IS NULL AND status = 'broken' AND ${NOT_ARCHIVED}), 0)    AS broken,
         COALESCE(SUM(deleted_at IS NOT NULL), 0)                                          AS trash,
         COALESCE(SUM(deleted_at IS NULL AND NOT ${NOT_ARCHIVED}), 0)                      AS archived
       FROM bookmarks b`
    ) as Row
    const byCollection: Record<number, number> = {}
    for (const row of this.all(
      'SELECT collection_id AS id, COUNT(*) AS n FROM bookmarks WHERE deleted_at IS NULL AND collection_id IS NOT NULL GROUP BY collection_id'
    )) {
      byCollection[Number(row.id)] = Number(row.n)
    }
    return {
      all: Number(totals.total),
      unsorted: Number(totals.unsorted),
      favorites: Number(totals.favorites),
      broken: Number(totals.broken),
      trash: Number(totals.trash),
      archived: Number(totals.archived),
      byCollection
    }
  }

  // -------------------------------------------------------------------- tags

  private tagNamesFor(bookmarkId: number): string[] {
    return this.all(
      'SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ? ORDER BY t.name COLLATE NOCASE',
      bookmarkId
    ).map((r) => String(r.name))
  }

  /**
   * Replaces a bookmark's tags. Tags that stay keep their origin (user / builtin / llm); new ones are the
   * user's unless `provenance` (keyed by lower-cased tag) says they were added automatically.
   */
  private setTags(bookmarkId: number, tags: readonly string[] | undefined, provenance: Record<string, Provenance> = {}): void {
    const names = normalizeTags(tags)
    const previous = new Map<string, { source: string; runId: number | null }>()
    for (const r of this.all(
      'SELECT t.name AS name, bt.source AS source, bt.run_id AS run_id FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = ?',
      bookmarkId
    )) {
      previous.set(String(r.name).toLowerCase(), { source: String(r.source), runId: r.run_id === null ? null : Number(r.run_id) })
    }
    this.run('DELETE FROM bookmark_tags WHERE bookmark_id = ?', bookmarkId)
    for (const name of names) {
      const key = name.toLowerCase()
      const origin = provenance[key] ?? previous.get(key) ?? { source: 'user', runId: null }
      this.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', name)
      const tag = this.get('SELECT id FROM tags WHERE name = ?', name) as Row
      this.run(
        'INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, run_id) VALUES (?, ?, ?, ?)',
        bookmarkId,
        Number(tag.id),
        origin.source,
        origin.runId
      )
    }
    this.pruneTags()
  }

  private pruneTags(): void {
    this.run('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM bookmark_tags)')
  }

  listTags(): TagInfo[] {
    return this.all(
      `SELECT t.name AS name, COUNT(*) AS n
         FROM tags t
         JOIN bookmark_tags bt ON bt.tag_id = t.id
         JOIN bookmarks b ON b.id = bt.bookmark_id
        WHERE b.deleted_at IS NULL AND ${NOT_ARCHIVED}
        GROUP BY t.id
        ORDER BY t.name COLLATE NOCASE`
    ).map((r) => ({ name: String(r.name), count: Number(r.n) }))
  }

  private bookmarkIdsWithTag(name: string): number[] {
    return this.all(
      'SELECT bt.bookmark_id AS id FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name = ?',
      name
    ).map((r) => Number(r.id))
  }

  /** Renames a tag; if the new name already exists the two tags are merged. */
  renameTag(from: string, to: string): void {
    const target = normalizeTags([to])[0]
    if (!target) throw new Error('Tag name is required')
    const source = this.get('SELECT id, name FROM tags WHERE name = ?', from)
    if (!source) throw new Error('Tag not found')
    this.tx(() => {
      const affected = this.bookmarkIdsWithTag(from)
      const existing = this.get('SELECT id FROM tags WHERE name = ?', target)
      if (existing && Number(existing.id) !== Number(source.id)) {
        this.run(
          'INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) SELECT bookmark_id, ? FROM bookmark_tags WHERE tag_id = ?',
          Number(existing.id),
          Number(source.id)
        )
        this.run('DELETE FROM tags WHERE id = ?', Number(source.id))
      } else {
        this.run('UPDATE tags SET name = ? WHERE id = ?', target, Number(source.id))
      }
      this.refreshSearchText(affected)
    })
  }

  removeTag(name: string): void {
    this.tx(() => {
      const affected = this.bookmarkIdsWithTag(name)
      this.run('DELETE FROM tags WHERE name = ?', name)
      this.refreshSearchText(affected)
    })
  }

  // ------------------------------------------------------------- tidying tags

  /** Every tag with how many (non-trashed) bookmarks use it, and how many of those uses are the user's own. */
  tagStats(): { name: string; uses: number; userUses: number }[] {
    return this.all(
      `SELECT t.name AS name, COUNT(*) AS uses, COALESCE(SUM(bt.source = 'user'), 0) AS user_uses
         FROM tags t
         JOIN bookmark_tags bt ON bt.tag_id = t.id
         JOIN bookmarks b ON b.id = bt.bookmark_id
        WHERE b.deleted_at IS NULL AND ${NOT_ARCHIVED}
        GROUP BY t.id
        ORDER BY t.name COLLATE NOCASE`
    ).map((r) => ({ name: String(r.name), uses: Number(r.uses), userUses: Number(r.user_uses) }))
  }

  /** The tags of every (non-trashed) bookmark. */
  tagsByBookmark(): Map<number, string[]> {
    const map = new Map<number, string[]>()
    for (const r of this.all(
      `SELECT bt.bookmark_id AS id, t.name AS name
         FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id JOIN bookmarks b ON b.id = bt.bookmark_id
        WHERE b.deleted_at IS NULL AND ${NOT_ARCHIVED}`
    )) {
      const id = Number(r.id)
      const list = map.get(id)
      if (list) list.push(String(r.name))
      else map.set(id, [String(r.name)])
    }
    return map
  }

  private tagId(name: string): number {
    this.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', name)
    return Number((this.get('SELECT id FROM tags WHERE name = ?', name) as Row).id)
  }

  /**
   * Merges look-alike tags and removes rare or vague automatic ones, as one step that can be undone.
   * Safety rules, enforced here whatever the caller asks: a tag you added yourself is never removed; when two tags are
   * merged the result counts as yours if either was; automatic tags keep the run they came from; and (optionally) a
   * rare tag stays on a bookmark whose only tag it is.
   */
  applyTidy(request: TidyRequest): TidyResult {
    return this.tx(() => {
      const merges: TidyMergeRow[] = []
      const removed: TidyRemovedRow[] = []
      const affected = new Set<number>()
      let mergedTags = 0
      let keptAsOnlyTag = 0

      for (const merge of request.merges) {
        const keeper = this.get('SELECT id, name FROM tags WHERE name = ?', merge.keep)
        if (!keeper) continue
        for (const from of merge.from) {
          const source = this.get('SELECT id, name FROM tags WHERE name = ?', from)
          if (!source || Number(source.id) === Number(keeper.id)) continue
          for (const row of this.all('SELECT bookmark_id, source, run_id FROM bookmark_tags WHERE tag_id = ?', Number(source.id))) {
            const bookmarkId = Number(row.bookmark_id)
            const rowSource = String(row.source)
            const keeperRow = this.get('SELECT source, run_id FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?', bookmarkId, Number(keeper.id))
            merges.push({
              b: bookmarkId,
              from: String(source.name),
              to: String(keeper.name),
              source: rowSource,
              runId: row.run_id === null ? null : Number(row.run_id),
              keeperBefore: keeperRow ? { source: String(keeperRow.source), runId: keeperRow.run_id === null ? null : Number(keeperRow.run_id) } : null
            })
            if (keeperRow) {
              if (rowSource === 'user' && String(keeperRow.source) !== 'user') {
                this.run("UPDATE bookmark_tags SET source = 'user', run_id = NULL WHERE bookmark_id = ? AND tag_id = ?", bookmarkId, Number(keeper.id))
              }
              this.run('DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?', bookmarkId, Number(source.id))
            } else {
              this.run('UPDATE bookmark_tags SET tag_id = ? WHERE bookmark_id = ? AND tag_id = ?', Number(keeper.id), bookmarkId, Number(source.id))
            }
            affected.add(bookmarkId)
          }
          // Suggestions still waiting under the old name follow it.
          this.run("UPDATE OR IGNORE tag_proposals SET tag = ? WHERE tag = ? AND status IN ('pending', 'held')", String(keeper.name), String(source.name))
          this.run("DELETE FROM tag_proposals WHERE tag = ? AND status IN ('pending', 'held')", String(source.name))
          this.run('DELETE FROM tags WHERE id = ?', Number(source.id))
          mergedTags++
        }
      }

      // Removal: only automatic-only tags that are rare (or vague), never the user's.
      const stats = new Map(this.tagStats().map((s) => [s.name.toLowerCase(), s]))
      const eligible = new Map<string, { name: string; uses: number }>()
      for (const name of request.remove) {
        const stat = stats.get(name.toLowerCase())
        if (!stat || stat.userUses > 0) continue
        if (stat.uses > request.rareMaxUses && !GENERIC_TAGS.has(canon(stat.name))) continue
        eligible.set(stat.name.toLowerCase(), { name: stat.name, uses: stat.uses })
      }
      if (eligible.size > 0) {
        const perBookmark = new Map<number, { tag: string; source: string; runId: number | null }[]>()
        for (const { name } of eligible.values()) {
          for (const row of this.all('SELECT bt.bookmark_id AS b, bt.source AS source, bt.run_id AS run_id FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name = ?', name)) {
            const list = perBookmark.get(Number(row.b)) ?? []
            list.push({ tag: name, source: String(row.source), runId: row.run_id === null ? null : Number(row.run_id) })
            perBookmark.set(Number(row.b), list)
          }
        }
        const tagCount = new Map(this.all('SELECT bookmark_id AS b, COUNT(*) AS n FROM bookmark_tags GROUP BY bookmark_id').map((r) => [Number(r.b), Number(r.n)]))
        for (const [bookmarkId, list] of perBookmark) {
          let toRemove = list
          if (request.keepOnlyTag && (tagCount.get(bookmarkId) ?? 0) - list.length <= 0) {
            // Everything this bookmark has is going: keep its most used tag.
            const keep = [...list].sort((a, b) => (eligible.get(b.tag.toLowerCase())?.uses ?? 0) - (eligible.get(a.tag.toLowerCase())?.uses ?? 0) || a.tag.localeCompare(b.tag))[0]
            toRemove = list.filter((entry) => entry !== keep)
            keptAsOnlyTag++
          }
          for (const entry of toRemove) {
            this.run('DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)', bookmarkId, entry.tag)
            removed.push({ b: bookmarkId, tag: entry.tag, source: entry.source, runId: entry.runId })
            affected.add(bookmarkId)
          }
        }
      }

      this.pruneTags()
      this.refreshSearchText([...affected])

      if (merges.length === 0 && removed.length === 0) return { id: null, merged: 0, removed: 0, keptAsOnlyTag }
      const id = this.logTidy('tags', mergedTags, removed.length, { merges, removed })
      return { id, merged: mergedTags, removed: removed.length, keptAsOnlyTag }
    })
  }

  /** The latest tidy that has not been undone. */
  lastTidy(kind: TidyLogInfo['kind'] = 'tags'): TidyLogInfo | null {
    const r = this.get('SELECT id, created_at, merged, removed FROM tidy_log WHERE undone = 0 AND kind = ? ORDER BY id DESC LIMIT 1', kind)
    return r ? { id: Number(r.id), createdAt: String(r.created_at), kind, merged: Number(r.merged), removed: Number(r.removed) } : null
  }

  /** Records what a tidy changed so it can be undone, keeping only the latest few of each kind. */
  private logTidy(kind: TidyLogInfo['kind'], merged: number, removed: number, payload: unknown): number {
    const logId = this.insert(
      'INSERT INTO tidy_log (created_at, kind, merged, removed, payload) VALUES (?, ?, ?, ?, ?)',
      new Date().toISOString(),
      kind,
      merged,
      removed,
      JSON.stringify(payload)
    )
    this.run('DELETE FROM tidy_log WHERE kind = ? AND id NOT IN (SELECT id FROM tidy_log WHERE kind = ? ORDER BY id DESC LIMIT 3)', kind, kind)
    return logId
  }

  /** What a tidy recorded, if it can still be undone. */
  private readTidy(logId: number, kind: TidyLogInfo['kind']): unknown {
    const row = this.get('SELECT kind, payload, undone FROM tidy_log WHERE id = ?', logId)
    if (!row || String(row.kind) !== kind) throw new Error('That tidy is no longer available to undo.')
    if (Number(row.undone) === 1) throw new Error('That tidy was already undone.')
    return JSON.parse(String(row.payload))
  }

  /** Puts back exactly what a tidy changed (merged tags come apart again, removed tags return). */
  undoTidy(id: number): TidyResult {
    return this.tx(() => {
      const payload = this.readTidy(id, 'tags') as { merges: TidyMergeRow[]; removed: TidyRemovedRow[] }
      const affected = new Set<number>()
      const exists = (bookmarkId: number): boolean => this.get('SELECT 1 AS x FROM bookmarks WHERE id = ?', bookmarkId) !== undefined

      // Newest change first, so a bookmark that took part in several merges unwinds in the right order.
      for (const entry of payload.removed) {
        if (!exists(entry.b)) continue
        this.run('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, run_id) VALUES (?, ?, ?, ?)', entry.b, this.tagId(entry.tag), entry.source, entry.runId)
        affected.add(entry.b)
      }
      for (const entry of [...payload.merges].reverse()) {
        if (!exists(entry.b)) continue
        this.run('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id, source, run_id) VALUES (?, ?, ?, ?)', entry.b, this.tagId(entry.from), entry.source, entry.runId)
        const keeper = this.get('SELECT id FROM tags WHERE name = ?', entry.to)
        if (keeper) {
          if (entry.keeperBefore === null) {
            this.run('DELETE FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?', entry.b, Number(keeper.id))
          } else {
            this.run('UPDATE bookmark_tags SET source = ?, run_id = ? WHERE bookmark_id = ? AND tag_id = ?', entry.keeperBefore.source, entry.keeperBefore.runId, entry.b, Number(keeper.id))
          }
        }
        affected.add(entry.b)
      }
      this.run('UPDATE tidy_log SET undone = 1 WHERE id = ?', id)
      this.pruneTags()
      this.refreshSearchText([...affected])
      return { id, merged: payload.merges.length, removed: payload.removed.length, keptAsOnlyTag: 0 }
    })
  }

  // ------------------------------------------------------- derived / metadata

  private refreshSearchText(ids: number[]): void {
    for (const id of ids) {
      const row = this.get(`${BOOKMARK_SELECT} WHERE b.id = ?`, id)
      if (!row) continue
      const bookmark = toBookmark(row)
      const text = [bookmark.title, bookmark.url, bookmark.note, bookmark.excerpt, ...bookmark.tags].join(' ').toLowerCase()
      this.run('UPDATE bookmarks SET search_text = ? WHERE id = ?', text, id)
    }
  }

  /**
   * Applies freshly scraped metadata. Title and description only fill blanks (or the auto-generated
   * title); cover and favicon are replaced whenever a new one was found.
   */
  applyMetadata(
    id: number,
    meta: { title?: string; excerpt?: string; coverUrl?: string | null; faviconUrl?: string | null; signals?: PageSignals | null }
  ): Bookmark {
    const existing = this.getBookmark(id)
    if (!existing) throw new Error('Bookmark not found')
    if (meta.signals) this.setSignals(id, meta.signals)
    const autoTitle = !existing.title || existing.title === existing.domain || existing.title === existing.url
    const patch: BookmarkPatch = {}
    if (meta.title && autoTitle) patch.title = meta.title
    if (meta.excerpt && !existing.excerpt) patch.excerpt = meta.excerpt
    if (meta.coverUrl) patch.coverUrl = meta.coverUrl
    if (meta.faviconUrl) patch.faviconUrl = meta.faviconUrl
    return Object.keys(patch).length ? this.updateBookmark(id, patch) : existing
  }

  setLinkStatus(id: number, status: LinkStatus, httpStatus: number | null): void {
    this.run('UPDATE bookmarks SET status = ?, http_status = ?, last_checked_at = ? WHERE id = ?', status, httpStatus, new Date().toISOString(), id)
  }

  /** Groups of active bookmarks that point at the same (normalised) URL. */
  findDuplicateGroups(): Bookmark[][] {
    const keys = this.all(
      `SELECT url_key FROM bookmarks b WHERE deleted_at IS NULL AND ${NOT_ARCHIVED} GROUP BY url_key HAVING COUNT(*) > 1 ORDER BY url_key`
    ).map((r) => String(r.url_key))
    return keys.map((key) =>
      this.all(`${BOOKMARK_SELECT} WHERE b.url_key = ? AND b.deleted_at IS NULL AND ${NOT_ARCHIVED} ORDER BY b.created_at, b.id`, key).map(toBookmark)
    )
  }

  /**
   * IDs and URLs of active bookmarks for a bulk job. `missing-metadata` means "never successfully fetched"
   * (no stored page signals): pages that answered but have no cover image are not asked again, while failed
   * lookups stay in the list until they succeed.
   */
  listForJob(kind: 'all' | 'missing-metadata', collectionId?: number): { id: number; url: string }[] {
    const extra = kind === 'missing-metadata' ? 'AND signals IS NULL' : ''
    // A job over one collection covers everything below it as well. Nothing is skipped for being archived:
    // the collection was named on purpose, and it may be one inside the Archive.
    const where =
      collectionId === undefined
        ? NOT_ARCHIVED
        : `b.collection_id IN (
             WITH RECURSIVE sub(id) AS (
               SELECT ? UNION ALL SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id
             ) SELECT id FROM sub)`
    const params: SqlValue[] = collectionId === undefined ? [] : [collectionId]
    return this.all(`SELECT b.id, b.url FROM bookmarks b WHERE deleted_at IS NULL AND ${where} ${extra} ORDER BY id`, ...params).map((r) => ({
      id: Number(r.id),
      url: String(r.url)
    }))
  }

  /** Every bookmark that is not in the Trash. `includeArchived` is for backups, which must hold everything. */
  allActiveBookmarks(includeArchived = true): Bookmark[] {
    const where = includeArchived ? '' : ` AND ${NOT_ARCHIVED}`
    return this.all(`${BOOKMARK_SELECT} WHERE b.deleted_at IS NULL${where} ORDER BY b.id`).map(toBookmark)
  }

  // ------------------------------------------------------------- auto-tagging

  getSignals(id: number): PageSignals | null {
    return parseSignals(this.get('SELECT signals FROM bookmarks WHERE id = ?', id)?.signals)
  }

  setSignals(id: number, signals: PageSignals | null): void {
    this.run('UPDATE bookmarks SET signals = ? WHERE id = ?', signals ? JSON.stringify(signals) : null, id)
  }

  private static readonly CANDIDATE_SELECT =
    'SELECT b.id, b.url, b.title, b.excerpt, b.signals,' +
    ' (SELECT group_concat(t.name, char(31)) FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id) AS tag_names' +
    ' FROM bookmarks b'

  private toCandidate(row: Row): TaggingCandidate {
    return {
      id: Number(row.id),
      url: String(row.url),
      title: String(row.title),
      excerpt: String(row.excerpt),
      tags: typeof row.tag_names === 'string' && row.tag_names ? row.tag_names.split(TAG_SEPARATOR) : [],
      signals: parseSignals(row.signals)
    }
  }

  getTaggingCandidate(id: number): TaggingCandidate | null {
    const row = this.get(Repo.CANDIDATE_SELECT + ' WHERE b.id = ?', id)
    return row ? this.toCandidate(row) : null
  }

  /** The conditions that pick the bookmarks a tagging run looks at. */
  private taggingFilter(scope: 'untagged' | 'all' | 'ids', options: { skipLlmSeen?: boolean }): string {
    const parts = ['b.deleted_at IS NULL', NOT_ARCHIVED]
    if (scope === 'untagged') parts.push('NOT EXISTS (SELECT 1 FROM bookmark_tags x WHERE x.bookmark_id = b.id)')
    // A long run with the (slow) local model can be stopped and continued: what the model has handled is skipped.
    if (options.skipLlmSeen) parts.push('NOT EXISTS (SELECT 1 FROM llm_seen s WHERE s.bookmark_id = b.id)')
    return parts.join(' AND ')
  }

  /** Bookmarks to consider for auto-tagging: those with no tags, everything, or a given set. Oldest first. */
  listForTagging(scope: 'untagged' | 'all' | 'ids', ids: number[] = [], options: { skipLlmSeen?: boolean } = {}): TaggingCandidate[] {
    const where = this.taggingFilter(scope, options)
    const rows: Row[] = []
    if (scope === 'ids') {
      for (const part of chunk(ids)) {
        rows.push(...this.all(Repo.CANDIDATE_SELECT + ' WHERE ' + where + ' AND b.id IN (' + placeholders(part.length) + ') ORDER BY b.id', ...part))
      }
    } else {
      rows.push(...this.all(Repo.CANDIDATE_SELECT + ' WHERE ' + where + ' ORDER BY b.id'))
    }
    return rows.map((row) => this.toCandidate(row))
  }

  /** How many bookmarks a run would look at, without loading them. */
  countForTagging(scope: 'untagged' | 'all' | 'ids', ids: number[] = [], options: { skipLlmSeen?: boolean } = {}): number {
    const where = this.taggingFilter(scope, options)
    if (scope !== 'ids') return Number(this.get('SELECT COUNT(*) AS n FROM bookmarks b WHERE ' + where)?.n ?? 0)
    let total = 0
    for (const part of chunk(ids)) {
      total += Number(this.get('SELECT COUNT(*) AS n FROM bookmarks b WHERE ' + where + ' AND b.id IN (' + placeholders(part.length) + ')', ...part)?.n ?? 0)
    }
    return total
  }

  /** Records that the local model has classified a bookmark (so a resumed run does not ask again). */
  markLlmSeen(bookmarkId: number, model: string): void {
    this.run(
      'INSERT INTO llm_seen (bookmark_id, model, at) VALUES (?, ?, ?) ON CONFLICT(bookmark_id) DO UPDATE SET model = excluded.model, at = excluded.at',
      bookmarkId,
      model,
      new Date().toISOString()
    )
  }

  /** How many of your bookmarks the local model has already classified. */
  llmProgress(): { seen: number; total: number } {
    const total = Number(this.get('SELECT COUNT(*) AS n FROM bookmarks WHERE deleted_at IS NULL')?.n ?? 0)
    const seen = Number(this.get('SELECT COUNT(*) AS n FROM llm_seen s JOIN bookmarks b ON b.id = s.bookmark_id WHERE b.deleted_at IS NULL')?.n ?? 0)
    return { seen, total }
  }

  /**
   * Adds tags to a bookmark (keeping the ones it has), recording that they were added automatically and by
   * which run. Returns the tags that were actually new. Does not touch the bookmark's "updated" date.
   */
  addAutoTags(bookmarkId: number, tags: readonly string[], source: SuggestionOrigin, runId: number | null): string[] {
    const current = this.tagNamesFor(bookmarkId)
    const have = new Set(current.map((t) => t.toLowerCase()))
    const added = normalizeTags(tags).filter((t) => !have.has(t.toLowerCase()))
    if (added.length === 0) return []
    this.tx(() => {
      const provenance: Record<string, Provenance> = {}
      for (const tag of added) provenance[tag.toLowerCase()] = { source, runId }
      this.setTags(bookmarkId, [...current, ...added], provenance)
      this.refreshSearchText([bookmarkId])
    })
    return added
  }

  // -- runs (one per auto-tag job or review action, so it can be undone as a unit)

  createRun(kind: string, mode: string): number {
    return this.insert('INSERT INTO tag_runs (kind, mode, created_at) VALUES (?, ?, ?)', kind, mode, new Date().toISOString())
  }

  finishRun(id: number, tagsApplied: number, bookmarksTouched: number): void {
    this.run('UPDATE tag_runs SET tags_applied = ?, bookmarks_touched = ? WHERE id = ?', tagsApplied, bookmarksTouched, id)
  }

  /**
   * The most recent run that added tags and has not been undone. Single bookmarks saved through the local API
   * (kind 'capture') are not offered here: "undo last run" is about bulk runs.
   */
  lastRun(): TagRunInfo | null {
    // Counted from the tags themselves, not from the totals a run writes when it ends: a run that was interrupted
    // (the app was closed part-way) never wrote them, but its tags are there and can be undone.
    const r = this.get(
      `SELECT r.*,
              (SELECT COUNT(*) FROM bookmark_tags t WHERE t.run_id = r.id AND t.source <> 'user') AS live_tags,
              (SELECT COUNT(DISTINCT t.bookmark_id) FROM bookmark_tags t WHERE t.run_id = r.id AND t.source <> 'user') AS live_bookmarks
         FROM tag_runs r
        WHERE r.undone = 0 AND r.kind <> 'capture'
          AND EXISTS (SELECT 1 FROM bookmark_tags t WHERE t.run_id = r.id AND t.source <> 'user')
        ORDER BY r.id DESC LIMIT 1`
    )
    if (!r) return null
    return {
      id: Number(r.id),
      kind: String(r.kind),
      mode: String(r.mode),
      createdAt: String(r.created_at),
      tagsApplied: Number(r.live_tags),
      bookmarksTouched: Number(r.live_bookmarks),
      undone: Number(r.undone) === 1
    }
  }

  /** Removes the automatic tags a run added (tags the user added themselves are never touched). */
  undoRun(runId: number): number {
    return this.tx(() => {
      const affected = this.all("SELECT DISTINCT bookmark_id AS id FROM bookmark_tags WHERE run_id = ? AND source <> 'user'", runId).map((r) => Number(r.id))
      const removed = this.run("DELETE FROM bookmark_tags WHERE run_id = ? AND source <> 'user'", runId)
      this.run('UPDATE tag_runs SET undone = 1 WHERE id = ?', runId)
      this.pruneTags()
      this.refreshSearchText(affected)
      return removed
    })
  }

  /** Removes every automatically added tag from every bookmark. */
  removeAutoTags(): number {
    return this.tx(() => {
      const affected = this.all("SELECT DISTINCT bookmark_id AS id FROM bookmark_tags WHERE source <> 'user'").map((r) => Number(r.id))
      const removed = this.run("DELETE FROM bookmark_tags WHERE source <> 'user'")
      this.pruneTags()
      this.refreshSearchText(affected)
      return removed
    })
  }

  // -- proposals (suggestions waiting for review)

  /**
   * Records suggestions for a bookmark. "held" ones are tag ideas that are not shown yet: a brand-new tag that only the
   * model came up with waits until a second bookmark wants it too (see releaseHeld / heldToPending).
   */
  addProposals(
    runId: number | null,
    bookmarkId: number,
    items: { tag: string; score: number; origin: SuggestionOrigin; reason: string }[],
    status: 'pending' | 'held' = 'pending'
  ): number {
    let added = 0
    for (const item of items) {
      added += this.run(
        'INSERT OR IGNORE INTO tag_proposals (run_id, bookmark_id, tag, score, origin, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        runId,
        bookmarkId,
        item.tag,
        item.score,
        item.origin,
        item.reason,
        status
      )
    }
    return added
  }

  /** Bookmarks that wanted this (new) tag but were held back. */
  heldBookmarkIds(tag: string): number[] {
    return this.all(
      "SELECT p.bookmark_id AS id FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id WHERE p.tag = ? AND p.status = 'held' AND b.deleted_at IS NULL ORDER BY p.bookmark_id",
      tag
    ).map((r) => Number(r.id))
  }

  /** Whether some other bookmark already has this tag waiting for review. */
  pendingElsewhere(tag: string, bookmarkId: number): boolean {
    return (
      Number(
        this.get("SELECT COUNT(*) AS n FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id WHERE p.tag = ? AND p.status = 'pending' AND p.bookmark_id <> ? AND b.deleted_at IS NULL", tag, bookmarkId)?.n ?? 0
      ) > 0
    )
  }

  /** Every tag idea currently held back (one bookmark each so far). */
  heldTags(): string[] {
    return this.all("SELECT DISTINCT tag FROM tag_proposals WHERE status = 'held' ORDER BY tag COLLATE NOCASE").map((r) => String(r.tag))
  }

  heldCount(): number {
    return Number(this.get("SELECT COUNT(DISTINCT tag) AS n FROM tag_proposals WHERE status = 'held'")?.n ?? 0)
  }

  /** A held tag now has a second bookmark: the earlier ones become ordinary suggestions (for review). */
  heldToPending(tag: string): number {
    return this.run("UPDATE tag_proposals SET status = 'pending' WHERE tag = ? AND status = 'held'", tag)
  }

  /** A held tag now has a second bookmark: hands back the earlier bookmarks (and forgets the held rows) so the tag can be applied. */
  releaseHeld(tag: string): { bookmarkId: number; origin: SuggestionOrigin }[] {
    return this.tx(() => {
      const rows = this.all(
        "SELECT p.bookmark_id AS id, p.origin AS origin FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id WHERE p.tag = ? AND p.status = 'held' AND b.deleted_at IS NULL",
        tag
      ).map((r) => ({ bookmarkId: Number(r.id), origin: (r.origin === 'llm' ? 'llm' : 'builtin') as SuggestionOrigin }))
      this.run("DELETE FROM tag_proposals WHERE tag = ? AND status = 'held'", tag)
      return rows
    })
  }

  /** Whether any bookmark currently has a tag of this name. */
  tagExists(name: string): boolean {
    return this.get('SELECT 1 AS x FROM tags WHERE name = ?', name) !== undefined
  }

  pendingProposalCount(): number {
    const row = this.get(
      "SELECT COUNT(*) AS n FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id WHERE p.status = 'pending' AND b.deleted_at IS NULL"
    )
    return Number(row?.n ?? 0)
  }

  proposalGroups(): ProposalGroup[] {
    return this.all(
      `SELECT p.tag AS tag, COUNT(*) AS n, AVG(p.score) AS avg_score, GROUP_CONCAT(DISTINCT p.origin) AS origins,
              EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name = p.tag) AS existing
         FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id
        WHERE p.status = 'pending' AND b.deleted_at IS NULL
        GROUP BY p.tag
        ORDER BY n DESC, p.tag COLLATE NOCASE`
    ).map((r) => ({
      tag: String(r.tag),
      count: Number(r.n),
      avgScore: Number(r.avg_score),
      existing: Number(r.existing) === 1,
      origins: String(r.origins).split(',').filter((o): o is SuggestionOrigin => o === 'builtin' || o === 'llm')
    }))
  }

  /** Suggestions still waiting for review on one bookmark, best first. */
  pendingProposalsFor(bookmarkId: number): { tag: string; score: number; origin: SuggestionOrigin }[] {
    return this.all("SELECT tag, score, origin FROM tag_proposals WHERE bookmark_id = ? AND status = 'pending' ORDER BY score DESC, tag", bookmarkId).map((r) => ({
      tag: String(r.tag),
      score: Number(r.score),
      origin: (r.origin === 'llm' ? 'llm' : 'builtin') as SuggestionOrigin
    }))
  }

  proposalItems(tag: string): ProposalItem[] {
    return this.all(
      `SELECT p.id AS id, p.bookmark_id AS bookmark_id, b.title AS title, b.url AS url, p.score AS score, p.reason AS reason, p.origin AS origin
         FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id
        WHERE p.tag = ? AND p.status = 'pending' AND b.deleted_at IS NULL
        ORDER BY p.score DESC, b.id`,
      tag
    ).map((r) => ({
      proposalId: Number(r.id),
      bookmarkId: Number(r.bookmark_id),
      title: String(r.title),
      url: String(r.url),
      score: Number(r.score),
      reason: String(r.reason),
      origin: (r.origin === 'llm' ? 'llm' : 'builtin') as SuggestionOrigin
    }))
  }

  private pendingRows(tag: string, bookmarkIds?: number[]): { id: number; bookmarkId: number; origin: SuggestionOrigin }[] {
    const base =
      "SELECT p.id AS id, p.bookmark_id AS bookmark_id, p.origin AS origin FROM tag_proposals p JOIN bookmarks b ON b.id = p.bookmark_id WHERE p.tag = ? AND p.status = 'pending' AND b.deleted_at IS NULL"
    const rows: Row[] = []
    if (bookmarkIds) {
      for (const part of chunk(bookmarkIds)) rows.push(...this.all(base + ' AND p.bookmark_id IN (' + placeholders(part.length) + ')', tag, ...part))
    } else {
      rows.push(...this.all(base, tag))
    }
    return rows.map((r) => ({ id: Number(r.id), bookmarkId: Number(r.bookmark_id), origin: (r.origin === 'llm' ? 'llm' : 'builtin') as SuggestionOrigin }))
  }

  /**
   * Applies the pending proposals for a tag (all of them, or just the given bookmarks) as one undoable run.
   * Pass `sharedRunId` to fold the result into a run that is already open (used by "apply everything").
   */
  applyProposals(tag: string, bookmarkIds?: number[], sharedRunId?: number): { applied: number; runId: number | null } {
    return this.tx(() => {
      const rows = this.pendingRows(tag, bookmarkIds)
      if (rows.length === 0) return { applied: 0, runId: null }
      const runId = sharedRunId ?? this.createRun('review', 'suggest')
      let applied = 0
      for (const row of rows) {
        applied += this.addAutoTags(row.bookmarkId, [tag], row.origin, runId).length
        this.run('DELETE FROM tag_proposals WHERE id = ?', row.id)
      }
      if (sharedRunId === undefined) this.finishRun(runId, applied, applied)
      return { applied, runId }
    })
  }

  /** Applies every pending proposal as a single undoable run. */
  applyAllProposals(): { applied: number; runId: number | null } {
    return this.tx(() => {
      const groups = this.proposalGroups()
      if (groups.length === 0) return { applied: 0, runId: null }
      const runId = this.createRun('review-all', 'suggest')
      let applied = 0
      for (const group of groups) applied += this.applyProposals(group.tag, undefined, runId).applied
      this.finishRun(runId, applied, applied)
      return { applied, runId }
    })
  }

  /** Tags already rejected for this bookmark (lower-cased), so they are not suggested again. */
  rejectedProposalTags(bookmarkId: number): Set<string> {
    return new Set(this.all("SELECT tag FROM tag_proposals WHERE bookmark_id = ? AND status = 'rejected'", bookmarkId).map((r) => String(r.tag).toLowerCase()))
  }

  /** Marks proposals as rejected; they are remembered so a later run does not suggest them again. */
  rejectProposals(tag: string, bookmarkIds?: number[]): number {
    return this.tx(() => {
      let changed = 0
      if (bookmarkIds) {
        for (const part of chunk(bookmarkIds)) {
          changed += this.run(
            "UPDATE tag_proposals SET status = 'rejected' WHERE tag = ? AND status = 'pending' AND bookmark_id IN (" + placeholders(part.length) + ')',
            tag,
            ...part
          )
        }
      } else {
        changed = this.run("UPDATE tag_proposals SET status = 'rejected' WHERE tag = ? AND status = 'pending'", tag)
      }
      return changed
    })
  }

  /** Never suggest this tag again, and drop its pending proposals. */
  neverSuggest(tag: string): number {
    return this.tx(() => {
      const name = normalizeTags([tag])[0]
      if (!name) return 0
      this.run('INSERT OR IGNORE INTO tag_blocklist (tag) VALUES (?)', name)
      return this.rejectProposals(name)
    })
  }

  discardPendingProposals(): number {
    return this.run("UPDATE tag_proposals SET status = 'rejected' WHERE status = 'pending'")
  }

  blockedTags(): string[] {
    return this.all('SELECT tag FROM tag_blocklist ORDER BY tag COLLATE NOCASE').map((r) => String(r.tag))
  }

  unblockTag(tag: string): void {
    this.run('DELETE FROM tag_blocklist WHERE tag = ?', tag)
  }

  // ---------------------------------------------------------------- settings

  getSettingsRaw(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const row of this.all('SELECT key, value FROM settings')) out[String(row.key)] = String(row.value)
    return out
  }

  getSettingRaw(key: string): string | null {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key)
    return row ? String(row.value) : null
  }

  setSettingRaw(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
}
