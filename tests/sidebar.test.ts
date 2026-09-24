import { describe, expect, it } from 'vitest'
import type { Collection } from '../src/shared/types'
import { buildTree, flattenTree } from '../src/shared/collections'

// How the sidebar orders things. The tree is what the sidebar, the "move to collection" menus and the
// collection pickers all render, so sorting it once sorts every list of collections in the app.

let nextId = 1
const make = (name: string, parentId: number | null = null, position = 0): Collection => ({
  id: nextId++,
  parentId,
  name,
  color: null,
  position
})

describe('collection order', () => {
  it('sorts every level A-Z, whatever order they were created or dragged into', () => {
    const zebra = make('zebra', null, 0)
    const apple = make('Apple', null, 1)
    const middle = make('middle', null, 2)
    const collections = [
      zebra,
      apple,
      middle,
      make('rust', apple.id, 0),
      make('Ansible', apple.id, 1),
      make('deep', apple.id, 2)
    ]

    const tree = buildTree(collections)
    expect(tree.map((n) => n.collection.name)).toEqual(['Apple', 'middle', 'zebra']) // capitals do not come first
    expect(tree[0]?.children.map((n) => n.collection.name)).toEqual(['Ansible', 'deep', 'rust'])
    expect(flattenTree(tree).map((n) => n.collection.name)).toEqual(['Apple', 'Ansible', 'deep', 'rust', 'middle', 'zebra'])
  })

  it('reads numbers as numbers, and ignores accents', () => {
    const tree = buildTree([make('Chapter 10'), make('Chapter 2'), make('Éclairs'), make('Eggs'), make('Zoo')])
    expect(tree.map((n) => n.collection.name)).toEqual(['Chapter 2', 'Chapter 10', 'Éclairs', 'Eggs', 'Zoo'])
  })

  it('keeps a stable order for two collections with the same name', () => {
    const first = make('Same')
    const second = make('Same')
    expect(buildTree([second, first]).map((n) => n.collection.id)).toEqual([first.id, second.id])
  })
})
