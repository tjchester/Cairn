import type { Collection } from './types'

// Turning the flat list of collections into the tree every list in the app shows, in the order it shows them.
// Pure data work (no DOM), so the renderer, the main process and the tests can all use it.

export interface TreeNode {
  collection: Collection
  children: TreeNode[]
}

/** A–Z the way a person reads it: capitals ignored, accents ignored, "Chapter 2" before "Chapter 10". */
export const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Collections as a tree, with every level sorted A–Z (sub-collections included). */
export function buildTree(collections: Collection[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>(collections.map((c) => [c.id, { collection: c, children: [] }]))
  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.collection.parentId === null ? undefined : nodes.get(node.collection.parentId)
    ;(parent ? parent.children : roots).push(node)
  }
  const order = (list: TreeNode[]): void => {
    list.sort((a, b) => byName.compare(a.collection.name, b.collection.name) || a.collection.id - b.collection.id)
    list.forEach((n) => order(n.children))
  }
  order(roots)
  return roots
}

/** The Archive and everything below it: what the lists leave out unless archived items are asked for. */
export function archivedCollectionIds(collections: readonly Collection[]): Set<number> {
  const archive = collections.find((c) => c.role === 'archive')
  const out = new Set<number>()
  if (!archive) return out
  out.add(archive.id)
  let grew = true
  while (grew) {
    grew = false
    for (const c of collections) {
      if (c.parentId !== null && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id)
        grew = true
      }
    }
  }
  return out
}

/** A collection with its ancestors, outermost first: "Favorites", "Menus", "College". */
export function collectionChain(collections: readonly Collection[], id: number | null): Collection[] {
  const byId = new Map(collections.map((c) => [c.id, c]))
  const chain: Collection[] = []
  const seen = new Set<number>()
  let cursor = id === null ? undefined : byId.get(id)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return chain
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
