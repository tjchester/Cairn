import type { Scope, SortDirection, SortKey } from '@shared/types'
import type { Repo } from '../db/repo'
import { ApiError } from './errors'
import { toApiBookmark } from './shape'

// The read side of the local API: searching and listing, for scripts and the command-line tool. It answers only to
// the read key, which is not the one inside the bookmarklet, so a page that captures that key cannot read anything.

const SORTS: SortKey[] = ['created', 'updated', 'title', 'domain']

function integer(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'invalid-request', '"' + name + '" must be a whole number between ' + min + ' and ' + max + '.')
  }
  return value
}

/** `?archived`, `?archived=1` and `?archived=true` all mean yes. */
function flag(params: URLSearchParams, name: string): boolean {
  if (!params.has(name)) return false
  const raw = (params.get(name) ?? '').toLowerCase()
  return raw === '' || raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * The part of the library to look at: "all" (the default), "unsorted", "favorites", "broken", "trash",
 * "collection:12" or "tag:rust".
 */
export function parseScope(raw: string | null, repo: Repo): Scope {
  const value = (raw ?? 'all').trim()
  const [kind, rest] = value.includes(':') ? [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)] : [value, '']
  switch (kind.toLowerCase()) {
    case '':
    case 'all':
      return { kind: 'all' }
    case 'unsorted':
      return { kind: 'unsorted' }
    case 'favorites':
    case 'favourites':
      return { kind: 'favorites' }
    case 'broken':
      return { kind: 'broken' }
    case 'trash':
      return { kind: 'trash' }
    case 'tag':
      if (!rest) throw new ApiError(400, 'invalid-request', 'Say which tag, as "tag:rust".')
      return { kind: 'tag', name: rest }
    case 'collection': {
      if (!rest) throw new ApiError(400, 'invalid-request', 'Say which collection, as "collection:12" or "collection:Dev/Rust".')
      const found = /^\d+$/.test(rest) ? repo.getCollection(Number(rest)) : findByPath(repo, rest)
      if (!found) throw new ApiError(400, 'unknown-collection', 'There is no collection "' + rest + '".')
      return { kind: 'collection', id: found.id }
    }
    default:
      throw new ApiError(400, 'invalid-request', 'Unknown scope "' + value + '". Use all, unsorted, favorites, broken, trash, tag:<name> or collection:<id or path>.')
  }
}

function findByPath(repo: Repo, path: string): { id: number } | null {
  const parts = path.split('/').map((p) => p.trim()).filter(Boolean)
  const all = repo.listCollections()
  let parent: number | null = null
  let found: { id: number } | null = null
  for (const part of parts) {
    const match = all.find((c) => c.parentId === parent && c.name.toLowerCase() === part.toLowerCase())
    if (!match) return null
    parent = match.id
    found = match
  }
  return found
}

/** GET /api/v1/bookmarks: the same search the app's own list uses. */
export function searchBookmarks(repo: Repo, params: URLSearchParams): Record<string, unknown> {
  const sortRaw = (params.get('sort') ?? 'created') as SortKey
  if (!SORTS.includes(sortRaw)) throw new ApiError(400, 'invalid-request', '"sort" must be one of ' + SORTS.join(', ') + '.')
  const direction: SortDirection = (params.get('direction') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
  const limit = integer(params, 'limit', 50, 1, 1000)
  const offset = integer(params, 'offset', 0, 0, 1_000_000)

  const page = repo.query({
    scope: parseScope(params.get('scope'), repo),
    search: params.get('q') ?? params.get('search') ?? '',
    includeArchived: flag(params, 'archived') || flag(params, 'includeArchived'),
    directOnly: flag(params, 'direct') || flag(params, 'directOnly'),
    sort: sortRaw,
    direction,
    limit,
    offset
  })
  return {
    total: page.total,
    limit,
    offset,
    bookmarks: page.items.map((b) => toApiBookmark(repo, b))
  }
}

/** GET /api/v1/bookmarks/:id */
export function oneBookmark(repo: Repo, id: number): Record<string, unknown> {
  const bookmark = repo.getBookmark(id)
  if (!bookmark) throw new ApiError(404, 'not-found', 'There is no bookmark with id ' + id + '.')
  return { bookmark: toApiBookmark(repo, bookmark) }
}

/** GET /api/v1/collections */
export function listCollections(repo: Repo): Record<string, unknown> {
  const all = repo.listCollections()
  const counts = repo.counts().byCollection
  return {
    collections: all.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
      path: repo.collectionPath(c.id, all).join('/'),
      color: c.color,
      bookmarks: counts[c.id] ?? 0,
      ...(c.role ? { role: c.role } : {})
    }))
  }
}

/** GET /api/v1/tags */
export function listTags(repo: Repo): Record<string, unknown> {
  return { tags: repo.listTags().map((t) => ({ name: t.name, bookmarks: t.count })) }
}

/** GET /api/v1/stats */
export function stats(repo: Repo): Record<string, unknown> {
  const counts = repo.counts()
  return {
    bookmarks: counts.all,
    unsorted: counts.unsorted,
    favorites: counts.favorites,
    broken: counts.broken,
    archived: counts.archived,
    trash: counts.trash,
    collections: repo.listCollections().length,
    tags: repo.listTags().length
  }
}
