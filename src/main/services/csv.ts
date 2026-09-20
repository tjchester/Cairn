import type { Bookmark, Collection } from '@shared/types'
import { insertAtPath, newFolder, newLink, toIsoDate, type ImportFolder } from './importTree'

/** RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF, optional UTF-8 BOM. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((cell) => cell !== '')) rows.push(row)
  return rows
}

// Cells starting with these characters are interpreted as formulas by spreadsheet apps.
const FORMULA_PREFIX = /^[=+\-@\t\r]/

function csvCell(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function unguard(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value
}

const truthy = (value: string): boolean => /^(1|true|yes|y|x)$/i.test(value.trim())

/** Parses a CSV export (header names are matched case-insensitively) into an import tree. */
export function parseCsvBookmarks(text: string): ImportFolder {
  const rows = parseCsv(text)
  const root = newFolder()
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  const col = (...names: string[]): number => header.findIndex((h) => names.includes(h))

  const urlCol = col('url', 'link', 'href')
  if (urlCol < 0) throw new Error('The CSV file needs a "url" column.')
  const titleCol = col('title', 'name')
  const noteCol = col('note', 'notes')
  const excerptCol = col('excerpt', 'description')
  const folderCol = col('folder', 'collection')
  const tagsCol = col('tags', 'tag')
  const createdCol = col('created', 'created_at', 'date', 'add_date')
  const coverCol = col('cover', 'image')
  const favoriteCol = col('favorite', 'favourite')

  const cell = (row: string[], index: number): string => (index >= 0 ? unguard((row[index] ?? '').trim()) : '')

  for (const row of rows.slice(1)) {
    const url = cell(row, urlCol)
    if (!url) continue
    const path = cell(row, folderCol)
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean)
    insertAtPath(
      root,
      path,
      newLink(url, {
        title: cell(row, titleCol),
        note: cell(row, noteCol),
        excerpt: cell(row, excerptCol),
        tags: cell(row, tagsCol)
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean),
        createdAt: toIsoDate(cell(row, createdCol)),
        coverUrl: cell(row, coverCol) || undefined,
        favorite: truthy(cell(row, favoriteCol))
      })
    )
  }
  return root
}

export function serializeCsv(collections: Collection[], bookmarks: Bookmark[]): string {
  const byId = new Map(collections.map((c) => [c.id, c]))
  const pathOf = (id: number | null): string => {
    const parts: string[] = []
    const seen = new Set<number>()
    let cursor = id === null ? undefined : byId.get(id)
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id)
      parts.unshift(cursor.name.replaceAll('/', '∕'))
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    }
    return parts.join('/')
  }

  const lines = ['title,note,excerpt,url,folder,tags,created,cover,favorite']
  for (const b of bookmarks) {
    lines.push(
      [
        b.title,
        b.note,
        b.excerpt,
        b.url,
        pathOf(b.collectionId),
        b.tags.join(','),
        b.createdAt,
        b.coverUrl ?? '',
        b.favorite ? 'true' : 'false'
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return `﻿${lines.join('\r\n')}\r\n`
}
