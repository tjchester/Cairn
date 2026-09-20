import type { Collection, Scope } from '@shared/types'

export interface TreeNode {
  collection: Collection
  children: TreeNode[]
}

export function buildTree(collections: Collection[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>(collections.map((c) => [c.id, { collection: c, children: [] }]))
  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.collection.parentId === null ? undefined : nodes.get(node.collection.parentId)
    ;(parent ? parent.children : roots).push(node)
  }
  const order = (list: TreeNode[]): void => {
    list.sort((a, b) => a.collection.position - b.collection.position || a.collection.id - b.collection.id)
    list.forEach((n) => order(n.children))
  }
  order(roots)
  return roots
}

export function flattenTree(nodes: TreeNode[], depth = 0): { collection: Collection; depth: number }[] {
  return nodes.flatMap((n) => [{ collection: n.collection, depth }, ...flattenTree(n.children, depth + 1)])
}

/** Bookmark count per collection including everything nested below it. */
export function subtreeCounts(tree: TreeNode[], direct: Record<number, number>): Map<number, number> {
  const totals = new Map<number, number>()
  const visit = (node: TreeNode): number => {
    const sum = node.children.reduce((acc, child) => acc + visit(child), direct[node.collection.id] ?? 0)
    totals.set(node.collection.id, sum)
    return sum
  }
  tree.forEach(visit)
  return totals
}

export function descendantIds(tree: TreeNode[], id: number): Set<number> {
  const out = new Set<number>()
  const find = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) {
      if (n.collection.id === id) return n
      const hit = find(n.children)
      if (hit) return hit
    }
    return undefined
  }
  const collect = (node: TreeNode): void => node.children.forEach((c) => (out.add(c.collection.id), collect(c)))
  const start = find(tree)
  if (start) collect(start)
  return out
}

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
