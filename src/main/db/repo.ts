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
  LinkStatus,
  Scope,
  TagInfo
} from '@shared/types'
import { coerceUrl, domainOf, isHttpUrl, urlKey } from '@shared/url'
import { buildSearchClauses, parseSearch, type SqlValue } from './search'

type Row = Record<string, unknown>

const TAG_SEPARATOR = '\x1f'
const MAX_TITLE = 500
const MAX_NOTE = 20_000
const MAX_EXCERPT = 2_000
const MAX_NAME = 100
const MAX_TAG = 50
const MAX_TAGS_PER_BOOKMARK = 50
const CHUNK = 500

const BOOKMARK_SELECT = `
  SELECT b.*,
    (SELECT group_concat(t.name, char(31))
       FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
      WHERE bt.bookmark_id = b.id) AS tag_names
  FROM bookmarks b`

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
  return {
    id: Number(row.id),
    parentId: row.parent_id === null ? null : Number(row.parent_id),
    name: String(row.name),
    color: (row.color as string | null) ?? null,
    position: Number(row.position)
  }
}

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
    if (!this.getCollection(id)) throw new Error('Collection not found')
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
    if (!this.getCollection(id)) throw new Error('Collection not found')
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
           (collection_id, url, url_key, title, note, excerpt, cover_url, favicon_url, domain, favorite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now
      )
      this.setTags(newId, input.tags)
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

  query(q: BookmarkQuery): BookmarkPage {
    const clauses: string[] = []
    const params: SqlValue[] = []
    this.applyScope(q.scope, clauses, params)

    const search = buildSearchClauses(parseSearch(q.search ?? ''))
    clauses.push(...search.clauses)
    params.push(...search.params)

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const dir = q.direction === 'asc' ? 'ASC' : 'DESC'
    const order = `${SORT_COLUMNS[q.sort]} ${dir}, b.id ${dir}`
    const limit = Math.max(1, Math.min(q.limit, 1000))
    const offset = Math.max(0, q.offset)

    const total = Number(this.get(`SELECT COUNT(*) AS n FROM bookmarks b ${where}`, ...params)?.n ?? 0)
    const items = this.all(`${BOOKMARK_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(toBookmark)
    return { items, total }
  }

  private applyScope(scope: Scope, clauses: string[], params: SqlValue[]): void {
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
          `b.collection_id IN (
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
         COALESCE(SUM(deleted_at IS NULL), 0)                          AS total,
         COALESCE(SUM(deleted_at IS NULL AND collection_id IS NULL), 0) AS unsorted,
         COALESCE(SUM(deleted_at IS NULL AND favorite = 1), 0)          AS favorites,
         COALESCE(SUM(deleted_at IS NULL AND status = 'broken'), 0)     AS broken,
         COALESCE(SUM(deleted_at IS NOT NULL), 0)                       AS trash
       FROM bookmarks`
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

  private setTags(bookmarkId: number, tags: readonly string[] | undefined): void {
    const names = normalizeTags(tags)
    this.run('DELETE FROM bookmark_tags WHERE bookmark_id = ?', bookmarkId)
    for (const name of names) {
      this.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', name)
      const tag = this.get('SELECT id FROM tags WHERE name = ?', name) as Row
      this.run('INSERT OR IGNORE INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)', bookmarkId, Number(tag.id))
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
        WHERE b.deleted_at IS NULL
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
  applyMetadata(id: number, meta: { title?: string; excerpt?: string; coverUrl?: string | null; faviconUrl?: string | null }): Bookmark {
    const existing = this.getBookmark(id)
    if (!existing) throw new Error('Bookmark not found')
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
      'SELECT url_key FROM bookmarks WHERE deleted_at IS NULL GROUP BY url_key HAVING COUNT(*) > 1 ORDER BY url_key'
    ).map((r) => String(r.url_key))
    return keys.map((key) =>
      this.all(`${BOOKMARK_SELECT} WHERE b.url_key = ? AND b.deleted_at IS NULL ORDER BY b.created_at, b.id`, key).map(toBookmark)
    )
  }

  /** IDs and URLs of active bookmarks, optionally restricted to those matching a predicate SQL fragment. */
  listForJob(kind: 'all' | 'missing-metadata'): { id: number; url: string }[] {
    const extra = kind === 'missing-metadata' ? "AND (cover_url IS NULL OR cover_url = '' OR favicon_url IS NULL OR favicon_url = '')" : ''
    return this.all(`SELECT id, url FROM bookmarks WHERE deleted_at IS NULL ${extra} ORDER BY id`).map((r) => ({
      id: Number(r.id),
      url: String(r.url)
    }))
  }

  allActiveBookmarks(): Bookmark[] {
    return this.all(`${BOOKMARK_SELECT} WHERE b.deleted_at IS NULL ORDER BY b.id`).map(toBookmark)
  }

  // ---------------------------------------------------------------- settings

  getSettingsRaw(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const row of this.all('SELECT key, value FROM settings')) out[String(row.key)] = String(row.value)
    return out
  }

  setSettingRaw(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
}
