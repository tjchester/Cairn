import type { ExportFormat } from '@shared/types'
import type { Repo } from '../db/repo'
import { parseCsvBookmarks, serializeCsv } from './csv'
import { applyImport, type ApplyResult, type ImportFolder } from './importTree'
import { parseJsonBookmarks, serializeJson } from './jsonFormat'
import { parseNetscape, serializeNetscape } from './netscape'

export type ImportFormat = ExportFormat

export function detectFormat(fileName: string, content: string): ImportFormat {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  const head = content.slice(0, 2000).trimStart()
  if (head.startsWith('{')) return 'json'
  if (/NETSCAPE-Bookmark|<DL/i.test(head)) return 'html'
  return 'csv'
}

export function parseByFormat(format: ImportFormat, content: string): ImportFolder {
  switch (format) {
    case 'json':
      return parseJsonBookmarks(content)
    case 'csv':
      return parseCsvBookmarks(content)
    case 'html':
      return parseNetscape(content)
  }
}

export function importText(repo: Repo, fileName: string, content: string): ApplyResult {
  const tree = parseByFormat(detectFormat(fileName, content), content)
  return applyImport(repo, tree, { skipDuplicates: true })
}

export function exportText(repo: Repo, format: ExportFormat): string {
  const collections = repo.listCollections()
  const bookmarks = repo.allActiveBookmarks()
  switch (format) {
    case 'html':
      return serializeNetscape(collections, bookmarks)
    case 'csv':
      return serializeCsv(collections, bookmarks)
    case 'json':
      return serializeJson(collections, bookmarks)
  }
}

export const EXPORT_EXTENSIONS: Record<ExportFormat, { name: string; extension: string }> = {
  html: { name: 'Browser bookmarks (HTML)', extension: 'html' },
  csv: { name: 'CSV spreadsheet', extension: 'csv' },
  json: { name: 'Cairn backup (JSON)', extension: 'json' }
}
