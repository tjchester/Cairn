import type { Scope } from '@shared/types'

export const COLLECTION_COLORS = [
  { name: 'Red', value: '#e5484d' },
  { name: 'Orange', value: '#f76b15' },
  { name: 'Yellow', value: '#e0a800' },
  { name: 'Green', value: '#30a46c' },
  { name: 'Teal', value: '#12a594' },
  { name: 'Blue', value: '#3e63dd' },
  { name: 'Purple', value: '#8e4ec6' },
  { name: 'Pink', value: '#d6409f' }
]

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Never'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Electron prefixes IPC errors with "Error invoking remote method '...': Error:" - strip it for display. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

export function scopeKey(scope: Scope): string {
  return scope.kind === 'collection' ? `collection:${scope.id}` : scope.kind === 'tag' ? `tag:${scope.name}` : scope.kind
}

export function sameScope(a: Scope, b: Scope): boolean {
  return scopeKey(a) === scopeKey(b)
}

export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export const BOOKMARK_DRAG_TYPE = 'application/x-cairn-bookmarks'
export const COLLECTION_DRAG_TYPE = 'application/x-cairn-collection'
