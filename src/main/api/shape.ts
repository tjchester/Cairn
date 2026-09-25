import type { Bookmark } from '@shared/types'
import type { Repo } from '../db/repo'

/** What the API tells callers about a bookmark. A stable public shape, separate from the app's internal one. */
export function toApiBookmark(repo: Repo, b: Bookmark): Record<string, unknown> {
  const path = repo.collectionPath(b.collectionId)
  return {
    id: b.id,
    url: b.url,
    title: b.title,
    description: b.excerpt,
    note: b.note,
    tags: b.tags,
    autoTags: b.autoTags,
    favorite: b.favorite,
    collectionId: b.collectionId,
    collection: b.collectionId === null ? null : path.join('/'),
    domain: b.domain,
    coverUrl: b.coverUrl,
    faviconUrl: b.faviconUrl,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    inTrash: b.deletedAt !== null
  }
}
