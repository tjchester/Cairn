import { z } from 'zod'
import type { Bookmark, Collection } from '@shared/types'
import { ensureFolderPath, insertAtPath, newFolder, newLink, toIsoDate, type ImportFolder } from './importTree'

// Cairn's own lossless-ish backup format. Collections are stored as paths so the file is
// independent of database ids.

const fileSchema = z.object({
  app: z.string().optional(),
  version: z.number().optional(),
  /** The path of the Archive collection, so restoring a backup brings it back as the Archive. */
  archivePath: z.array(z.string()).optional(),
  collections: z
    .array(z.object({ path: z.array(z.string()), color: z.string().nullish() }))
    .default([]),
  bookmarks: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().optional(),
        note: z.string().optional(),
        excerpt: z.string().optional(),
        coverUrl: z.string().nullish(),
        collectionPath: z.array(z.string()).default([]),
        tags: z.array(z.string()).default([]),
        favorite: z.boolean().optional(),
        createdAt: z.string().optional()
      })
    )
    .default([])
})

export function serializeJson(collections: Collection[], bookmarks: Bookmark[], archive: Collection | null = null): string {
  const byId = new Map(collections.map((c) => [c.id, c]))
  const pathOf = (id: number | null): string[] => {
    const parts: string[] = []
    const seen = new Set<number>()
    let cursor = id === null ? undefined : byId.get(id)
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      parts.unshift(cursor.name)
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    return parts
  }

  return JSON.stringify(
    {
      app: 'cairn',
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(archive ? { archivePath: pathOf(archive.id) } : {}),
      collections: collections.map((c) => ({ path: pathOf(c.id), color: c.color })),
      bookmarks: bookmarks.map((b) => ({
        url: b.url,
        title: b.title,
        note: b.note,
        excerpt: b.excerpt,
        coverUrl: b.coverUrl,
        collectionPath: pathOf(b.collectionId),
        tags: b.tags,
        favorite: b.favorite,
        createdAt: b.createdAt
      }))
    },
    null,
    2
  )
}

export function parseJsonBookmarks(text: string): ImportFolder {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new Error('The file is not valid JSON.')
  }
  const parsed = fileSchema.safeParse(data)
  if (!parsed.success) throw new Error('The file is not a Cairn JSON export.')

  const root = newFolder()
  for (const c of parsed.data.collections) {
    if (c.path.length === 0) continue
    const folder = ensureFolderPath(root, c.path)
    if (c.color) folder.color = c.color
  }
  const archivePath = parsed.data.archivePath
  if (archivePath && archivePath.length > 0) ensureFolderPath(root, archivePath).role = 'archive'
  for (const b of parsed.data.bookmarks) {
    insertAtPath(
      root,
      b.collectionPath,
      newLink(b.url, {
        title: b.title ?? '',
        note: b.note ?? '',
        excerpt: b.excerpt ?? '',
        coverUrl: b.coverUrl ?? undefined,
        tags: b.tags,
        favorite: b.favorite ?? false,
        createdAt: toIsoDate(b.createdAt)
      })
    )
  }
  return root
}
