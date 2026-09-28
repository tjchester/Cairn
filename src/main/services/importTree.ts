import type { Repo } from '../db/repo'
import { coerceUrl } from '@shared/url'

// Every importer (browser HTML, CSV, JSON) produces this tree, and `applyImport` writes it to the database.

export interface ImportLink {
  type: 'link'
  url: string
  title: string
  note: string
  excerpt: string
  tags: string[]
  favorite: boolean
  createdAt?: string
  coverUrl?: string
}

export interface ImportFolder {
  type: 'folder'
  name: string
  color?: string | null
  /** Set by a Cairn backup for the folder that was the Archive, so it is restored as the Archive. */
  role?: 'archive'
  children: ImportNode[]
}

export type ImportNode = ImportLink | ImportFolder

export function newFolder(name = '', color: string | null = null): ImportFolder {
  return { type: 'folder', name, color, children: [] }
}

export function newLink(url: string, partial: Partial<Omit<ImportLink, 'type' | 'url'>> = {}): ImportLink {
  return { type: 'link', url, title: '', note: '', excerpt: '', tags: [], favorite: false, ...partial }
}

/** Returns the folder at `path` below `root`, creating any missing folders on the way. */
export function ensureFolderPath(root: ImportFolder, path: string[]): ImportFolder {
  let folder = root
  for (const name of path) {
    if (!name) continue
    let next = folder.children.find((c): c is ImportFolder => c.type === 'folder' && c.name.toLowerCase() === name.toLowerCase())
    if (!next) {
      next = newFolder(name)
      folder.children.push(next)
    }
    folder = next
  }
  return folder
}

/** Adds `link` to `root`, creating intermediate folders for `path`. */
export function insertAtPath(root: ImportFolder, path: string[], link: ImportLink): void {
  ensureFolderPath(root, path).children.push(link)
}

export interface ApplyResult {
  added: number
  skipped: number
  collectionsCreated: number
}

export function applyImport(repo: Repo, root: ImportFolder, options: { skipDuplicates: boolean }): ApplyResult {
  const result: ApplyResult = { added: 0, skipped: 0, collectionsCreated: 0 }

  const walk = (folder: ImportFolder, collectionId: number | null): void => {
    for (const node of folder.children) {
      if (node.type === 'folder') {
        if (!node.name.trim()) {
          walk(node, collectionId)
          continue
        }
        // A backup says which folder was the Archive; restoring one brings that back, unless there is one already.
        const found = node.role === 'archive' && !repo.archive() ? { id: repo.ensureArchive(node.name).id, created: true } : repo.findOrCreateCollection(collectionId, node.name, node.color ?? null)
        if (found.created) result.collectionsCreated++
        walk(node, found.id)
        continue
      }

      let url: string
      try {
        url = coerceUrl(node.url)
      } catch {
        result.skipped++
        continue
      }
      if (options.skipDuplicates && repo.findByUrl(url)) {
        result.skipped++
        continue
      }
      repo.createBookmark({
        url,
        title: node.title,
        note: node.note,
        excerpt: node.excerpt,
        tags: node.tags,
        favorite: node.favorite,
        coverUrl: node.coverUrl,
        createdAt: node.createdAt,
        collectionId
      })
      result.added++
    }
  }

  repo.tx(() => walk(root, null))
  return result
}

/**
 * The earliest date a bookmark can have: the web is younger. Exports that do not know a date often write 0 (or leave
 * it out), and 0 read as a date is 1 January 1970; such a date is treated as unknown, so the bookmark is dated when it
 * is imported.
 */
export const EARLIEST_BOOKMARK_DATE = Date.UTC(1991, 0, 1)

export function toIsoDate(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let date: Date
  if (typeof value === 'number' || /^\d+$/.test(String(value).trim())) {
    const n = Number(value)
    // Seconds (browser exports) vs. milliseconds; anything below 1e11 is treated as seconds.
    date = new Date(n < 1e11 ? n * 1000 : n)
  } else {
    date = new Date(String(value))
  }
  const time = date.getTime()
  if (Number.isNaN(time) || time < EARLIEST_BOOKMARK_DATE || time > Date.now() + 86_400_000 * 365) return undefined
  return date.toISOString()
}
