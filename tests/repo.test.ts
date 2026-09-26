import { describe, expect, it } from 'vitest'
import { makeRepo, q } from './helpers'

describe('bookmarks', () => {
  it('creates with defaults, normalizes tags and derives the domain', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'www.Example.com/a', tags: ['  #Dev ', 'dev', 'Tools', ''] })
    expect(b.url).toBe('https://www.example.com/a')
    expect(b.domain).toBe('example.com')
    expect(b.title).toBe('example.com')
    expect(b.tags).toEqual(['Dev', 'Tools'])
    expect(b.collectionId).toBeNull()
    expect(b.status).toBe('unknown')
  })

  it('rejects unsafe URLs and unknown collections', () => {
    const repo = makeRepo()
    expect(() => repo.createBookmark({ url: 'javascript:alert(1)' })).toThrow()
    expect(() => repo.createBookmark({ url: 'https://a.com', collectionId: 999 })).toThrow('Collection not found')
  })

  it('updates fields, resets link status when the URL changes and keeps search text current', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://a.com', title: 'Old' })
    repo.setLinkStatus(b.id, 'broken', 404)
    const same = repo.updateBookmark(b.id, { title: 'New title', tags: ['x'], favorite: true })
    expect(same.status).toBe('broken')
    expect(same.tags).toEqual(['x'])
    const moved = repo.updateBookmark(b.id, { url: 'https://b.com/page' })
    expect(moved.status).toBe('unknown')
    expect(moved.domain).toBe('b.com')
    expect(repo.query(q({ search: 'b.com/page' })).total).toBe(1)
    expect(repo.query(q({ search: 'old' })).total).toBe(0)
  })

  it('finds existing bookmarks by normalized URL', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://example.com/a' })
    expect(repo.findByUrl('http://www.example.com/a/?utm_source=x')?.id).toBe(b.id)
    expect(repo.findByUrl('https://example.com/other')).toBeNull()
    expect(repo.findByUrl('nonsense ://')).toBeNull()
  })

  it('bulk-updates collection, favorite and tags', () => {
    const repo = makeRepo()
    const col = repo.createCollection({ name: 'Reading' })
    const a = repo.createBookmark({ url: 'https://a.com', tags: ['one', 'two'] })
    const b = repo.createBookmark({ url: 'https://b.com' })
    repo.bulkUpdate([a.id, b.id], { collectionId: col.id, favorite: true, addTags: ['three'], removeTags: ['ONE'] })
    expect(repo.getBookmark(a.id)).toMatchObject({ collectionId: col.id, favorite: true, tags: ['three', 'two'] })
    expect(repo.getBookmark(b.id)).toMatchObject({ collectionId: col.id, favorite: true, tags: ['three'] })
  })

  it('sorts, pages and reports totals', () => {
    const repo = makeRepo()
    for (const t of ['banana', 'Apple', 'cherry']) repo.createBookmark({ url: `https://${t}.com`, title: t })
    const asc = repo.query(q({ sort: 'title', direction: 'asc' }))
    expect(asc.items.map((b) => b.title)).toEqual(['Apple', 'banana', 'cherry'])
    const page = repo.query(q({ sort: 'title', direction: 'asc', limit: 2, offset: 2 }))
    expect(page.total).toBe(3)
    expect(page.items.map((b) => b.title)).toEqual(['cherry'])
  })
})

describe('selecting everything a filtered list shows', () => {
  /** 12 GitHub bookmarks and 3 others, so a "page" of 5 is nowhere near the whole list. */
  function library() {
    const repo = makeRepo()
    for (let i = 0; i < 12; i++) repo.createBookmark({ url: 'https://github.com/org/repo' + i, title: 'Repo ' + i, tags: i % 2 === 0 ? ['code'] : [] })
    for (const url of ['https://example.com/a', 'https://example.com/b', 'https://news.example/c']) repo.createBookmark({ url })
    return repo
  }

  it('returns every id the filter matches, not just the first page', () => {
    const repo = library()
    const page = repo.query(q({ search: 'site:github.com', limit: 5 }))
    expect(page.items).toHaveLength(5)
    expect(page.total).toBe(12)

    const ids = repo.matchingIds({ scope: { kind: 'all' }, search: 'site:github.com' })
    expect(ids).toHaveLength(12)
    expect(new Set(ids).size).toBe(12)
    expect(repo.matchingIds({ scope: { kind: 'all' } })).toHaveLength(15)
    expect(repo.matchingIds({ scope: { kind: 'all' }, search: '#code' })).toHaveLength(6)
  })

  it('follows the same rules as the list itself: collection, trash, and no match', () => {
    const repo = library()
    const dev = repo.createCollection({ name: 'Dev' })
    const ids = repo.matchingIds({ scope: { kind: 'all' }, search: 'site:github.com' })
    repo.bulkUpdate(ids.slice(0, 4), { collectionId: dev.id })
    expect(repo.matchingIds({ scope: { kind: 'collection', id: dev.id } })).toHaveLength(4)

    repo.trash(ids.slice(0, 2))
    expect(repo.matchingIds({ scope: { kind: 'all' }, search: 'site:github.com' })).toHaveLength(10) // trashed ones are gone
    expect(repo.matchingIds({ scope: { kind: 'trash' } })).toHaveLength(2)
    expect(repo.matchingIds({ scope: { kind: 'all' }, search: 'site:nothing.example' })).toEqual([])
  })

  it('will not hand back an unbounded list', () => {
    const repo = library()
    expect(repo.matchingIds({ scope: { kind: 'all' } }, 4)).toHaveLength(4)
  })
})

describe('trash', () => {
  it('moves to trash, restores and purges only trashed items', () => {
    const repo = makeRepo()
    const a = repo.createBookmark({ url: 'https://a.com', tags: ['t'] })
    const b = repo.createBookmark({ url: 'https://b.com' })
    repo.purge([a.id]) // not trashed: must be a no-op
    expect(repo.getBookmark(a.id)).not.toBeNull()

    repo.trash([a.id])
    expect(repo.query(q()).total).toBe(1)
    expect(repo.query(q({ scope: { kind: 'trash' } })).items.map((x) => x.id)).toEqual([a.id])
    expect(repo.counts()).toMatchObject({ all: 1, trash: 1 })
    expect(repo.listTags()).toEqual([]) // tags of trashed bookmarks are not counted

    repo.restore([a.id])
    expect(repo.query(q()).total).toBe(2)

    repo.trash([a.id, b.id])
    expect(repo.emptyTrash()).toBe(2)
    expect(repo.counts()).toMatchObject({ all: 0, trash: 0 })
    expect(repo.listTags()).toEqual([])
  })
})

describe('collections', () => {
  it('nests, counts descendants in scope queries and reorders', () => {
    const repo = makeRepo()
    const dev = repo.createCollection({ name: 'Dev' })
    const rust = repo.createCollection({ name: 'Rust', parentId: dev.id })
    const misc = repo.createCollection({ name: 'Misc' })
    repo.createBookmark({ url: 'https://a.com', collectionId: dev.id })
    repo.createBookmark({ url: 'https://b.com', collectionId: rust.id })
    repo.createBookmark({ url: 'https://c.com', collectionId: misc.id })
    repo.createBookmark({ url: 'https://d.com' })

    expect(repo.query(q({ scope: { kind: 'collection', id: dev.id } })).total).toBe(2)
    expect(repo.query(q({ scope: { kind: 'collection', id: rust.id } })).total).toBe(1)
    expect(repo.query(q({ scope: { kind: 'unsorted' } })).total).toBe(1)
    expect(repo.counts().byCollection).toEqual({ [dev.id]: 1, [rust.id]: 1, [misc.id]: 1 })

    repo.moveCollection(misc.id, null, 0)
    expect(repo.listCollections().filter((c) => c.parentId === null).map((c) => c.name)).toEqual(['Misc', 'Dev'])
    repo.moveCollection(rust.id, misc.id, 0)
    expect(repo.getCollection(rust.id)?.parentId).toBe(misc.id)
  })

  it('can leave the sub-collections out of a collection', () => {
    const repo = makeRepo()
    const dev = repo.createCollection({ name: 'Dev' })
    const rust = repo.createCollection({ name: 'Rust', parentId: dev.id })
    const async_ = repo.createCollection({ name: 'Async', parentId: rust.id })
    repo.createBookmark({ url: 'https://a.com', collectionId: dev.id })
    repo.createBookmark({ url: 'https://b.com', collectionId: rust.id })
    repo.createBookmark({ url: 'https://c.com', collectionId: async_.id })
    repo.createBookmark({ url: 'https://d.com' })

    const inDev = (directOnly?: boolean) => repo.query(q({ scope: { kind: 'collection', id: dev.id }, directOnly }))
    expect(inDev().total).toBe(3)
    expect(inDev(false).total).toBe(3)
    expect(inDev(true).total).toBe(1)
    expect(inDev(true).items.map((b) => b.url)).toEqual(['https://a.com/'])
    expect(repo.query(q({ scope: { kind: 'collection', id: rust.id }, directOnly: true })).items.map((b) => b.url)).toEqual(['https://b.com/'])
    expect(repo.query(q({ scope: { kind: 'collection', id: async_.id }, directOnly: true })).total).toBe(1) // no children of its own

    // Selecting everything the list shows follows the same rule, and a search still applies.
    expect(repo.matchingIds({ scope: { kind: 'collection', id: dev.id } })).toHaveLength(3)
    expect(repo.matchingIds({ scope: { kind: 'collection', id: dev.id }, directOnly: true })).toHaveLength(1)
    expect(repo.query(q({ scope: { kind: 'collection', id: dev.id }, directOnly: true, search: 'site:b.com' })).total).toBe(0)

    // It says nothing about the other scopes.
    expect(repo.query(q({ directOnly: true })).total).toBe(4)
    expect(repo.query(q({ scope: { kind: 'unsorted' }, directOnly: true })).total).toBe(1)
  })

  it('refuses to move a collection into itself or a descendant', () => {
    const repo = makeRepo()
    const a = repo.createCollection({ name: 'A' })
    const b = repo.createCollection({ name: 'B', parentId: a.id })
    expect(() => repo.moveCollection(a.id, a.id, 0)).toThrow()
    expect(() => repo.moveCollection(a.id, b.id, 0)).toThrow()
  })

  it('deleting a collection trashes its bookmarks (including nested) instead of destroying them', () => {
    const repo = makeRepo()
    const a = repo.createCollection({ name: 'A' })
    const b = repo.createCollection({ name: 'B', parentId: a.id })
    const inA = repo.createBookmark({ url: 'https://a.com', collectionId: a.id })
    const inB = repo.createBookmark({ url: 'https://b.com', collectionId: b.id })
    const keep = repo.createBookmark({ url: 'https://keep.com' })

    expect(repo.deleteCollection(a.id)).toEqual({ trashed: 2 })
    expect(repo.listCollections()).toEqual([])
    expect(repo.getBookmark(inA.id)?.deletedAt).not.toBeNull()
    expect(repo.getBookmark(inB.id)?.deletedAt).not.toBeNull()
    expect(repo.getBookmark(keep.id)?.deletedAt).toBeNull()

    repo.restore([inA.id])
    expect(repo.getBookmark(inA.id)).toMatchObject({ deletedAt: null, collectionId: null })
  })

  it('finds or creates by path case-insensitively', () => {
    const repo = makeRepo()
    const id = repo.ensureCollectionPath(['Dev', 'Rust'])
    expect(repo.ensureCollectionPath(['dev', 'rust'])).toBe(id)
    expect(repo.listCollections()).toHaveLength(2)
    expect(repo.ensureCollectionPath([])).toBeNull()
  })
})

describe('tidying empty collections', () => {
  /** Dev > Rust > Old (all empty), Dev > Used (has a bookmark), Recipes (empty), Binned (its bookmark is in the Trash). */
  function library() {
    const repo = makeRepo()
    const dev = repo.createCollection({ name: 'Dev' })
    const rust = repo.createCollection({ name: 'Rust', parentId: dev.id })
    const old = repo.createCollection({ name: 'Old', parentId: rust.id })
    const used = repo.createCollection({ name: 'Used', parentId: dev.id })
    const recipes = repo.createCollection({ name: 'Recipes' })
    const binned = repo.createCollection({ name: 'Binned' })
    repo.createBookmark({ url: 'https://keep.example/', collectionId: used.id })
    const trashed = repo.createBookmark({ url: 'https://gone.example/', collectionId: binned.id })
    repo.trash([trashed.id])
    return { repo, dev, rust, old, used, recipes, binned, trashed }
  }

  it('finds the collections with no bookmarks below them, deepest first, and leaves the rest alone', () => {
    const { repo, rust, old, recipes } = library()
    const empty = repo.emptyCollections()
    expect(empty.map((c) => c.path)).toEqual(['Dev / Rust / Old', 'Dev / Rust', 'Recipes'])
    expect(empty.map((c) => c.id)).toEqual([old.id, rust.id, recipes.id])
    expect(empty[0]).toMatchObject({ name: 'Old' })
  })

  it('keeps a collection whose bookmarks are only in the Trash, so they can still be restored into it', () => {
    const { repo, binned, trashed } = library()
    expect(repo.emptyCollections().map((c) => c.name)).not.toContain('Binned')

    repo.purge([trashed.id])
    expect(repo.emptyCollections().map((c) => c.name)).toContain('Binned')
  })

  it('removes a whole empty branch in one go and keeps everything else', () => {
    const { repo, dev, rust, old, used, recipes, binned } = library()
    const before = repo.counts().all
    const result = repo.removeEmptyCollections(repo.emptyCollections().map((c) => c.id))

    expect(result.removed).toBe(3) // Old, Rust and Recipes
    expect(repo.listCollections().map((c) => c.name).sort()).toEqual(['Binned', 'Dev', 'Used'])
    expect(repo.getCollection(rust.id)).toBeNull()
    expect(repo.getCollection(old.id)).toBeNull()
    expect(repo.getCollection(dev.id)).not.toBeNull() // it still holds "Used"
    expect(repo.getBookmark(repo.query(q({ scope: { kind: 'collection', id: used.id } })).items[0]?.id ?? 0)?.collectionId).toBe(used.id)
    expect(repo.counts().all).toBe(before)
    expect([recipes.id, binned.id].map((id) => repo.getCollection(id) === null)).toEqual([true, false])
  })

  it('removes a parent and its empty children with a single delete, counting them all', () => {
    const repo = makeRepo()
    const a = repo.createCollection({ name: 'A' })
    const b = repo.createCollection({ name: 'B', parentId: a.id })
    repo.createCollection({ name: 'C', parentId: b.id })
    expect(repo.removeEmptyCollections([a.id]).removed).toBe(3) // the children go with it
    expect(repo.listCollections()).toEqual([])
  })

  it('refuses anything that is not empty, whatever it is asked to remove', () => {
    const { repo, dev, used, binned } = library()
    expect(repo.removeEmptyCollections([dev.id, used.id, binned.id, 9999]).removed).toBe(0)
    expect(repo.listCollections().map((c) => c.name).sort()).toEqual(['Binned', 'Dev', 'Old', 'Recipes', 'Rust', 'Used'])
  })

  it('checks again at the moment it removes, so a bookmark added meanwhile keeps its collection', () => {
    const { repo, recipes, rust, old } = library()
    const stale = repo.emptyCollections().map((c) => c.id)
    repo.createBookmark({ url: 'https://late.example/', collectionId: recipes.id })

    expect(repo.removeEmptyCollections(stale).removed).toBe(2) // Old and Rust
    expect(repo.getCollection(recipes.id)).not.toBeNull()
    expect(repo.getCollection(rust.id)).toBeNull()
    expect(repo.getCollection(old.id)).toBeNull()
  })

it('can be undone: the branch comes back with its names, colours, nesting and ids', () => {
    const { repo, dev, rust, old, recipes } = library()
    repo.updateCollection(rust.id, { color: '#3e63dd' })
    const before = JSON.stringify(repo.listCollections())

    const result = repo.removeEmptyCollections(repo.emptyCollections().map((c) => c.id))
    expect(result).toMatchObject({ removed: 3 })
    expect(repo.lastTidy('collections')).toMatchObject({ id: result.id, kind: 'collections', removed: 3, merged: 0 })

    expect(repo.undoCollectionTidy(result.id as number)).toEqual({ restored: 3 })
    expect(JSON.stringify(repo.listCollections())).toBe(before) // same rows, same ids
    expect(repo.getCollection(rust.id)).toMatchObject({ name: 'Rust', parentId: dev.id, color: '#3e63dd' })
    expect(repo.getCollection(old.id)).toMatchObject({ name: 'Old', parentId: rust.id })
    expect(repo.getCollection(recipes.id)).toMatchObject({ name: 'Recipes', parentId: null })
    expect(repo.lastTidy('collections')).toBeNull()
    expect(() => repo.undoCollectionTidy(result.id as number)).toThrow(/already undone/)
  })

  it('gives a restored collection a new id when something made since has taken its old one', () => {
    const repo = makeRepo()
    const gone = repo.createCollection({ name: 'Gone' })
    const result = repo.removeEmptyCollections([gone.id])
    const squatter = repo.createCollection({ name: 'Newcomer' }) // takes the id that was just freed
    expect(squatter.id).toBe(gone.id)

    expect(repo.undoCollectionTidy(result.id as number)).toEqual({ restored: 1 })
    const names = repo.listCollections().map((c) => c.name).sort()
    expect(names).toEqual(['Gone', 'Newcomer'])
    expect(repo.getCollection(squatter.id)?.name).toBe('Newcomer') // untouched
  })

  it('brings a collection back at the top level when its parent has gone in the meantime', () => {
    const repo = makeRepo()
    const parent = repo.createCollection({ name: 'Parent' })
    const child = repo.createCollection({ name: 'Child', parentId: parent.id })
    const keep = repo.createCollection({ name: 'Keeps', parentId: parent.id })
    repo.createBookmark({ url: 'https://a.example/', collectionId: keep.id })

    const result = repo.removeEmptyCollections([child.id]) // only the child is empty
    repo.trash([repo.query(q({ scope: { kind: 'collection', id: keep.id } })).items[0]?.id ?? 0])
    repo.emptyTrash()
    repo.deleteCollection(parent.id) // the parent goes as well, taking "Keeps" with it

    expect(repo.undoCollectionTidy(result.id as number)).toEqual({ restored: 1 })
    expect(repo.getCollection(child.id)).toMatchObject({ name: 'Child', parentId: null })
  })

  it('refuses to undo something that is not a collection tidy', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://a.example/', tags: ['Foo', 'Foos'] })
    const tags = repo.applyTidy({ merges: [{ keep: 'Foo', from: ['Foos'] }], remove: [], rareMaxUses: 2, keepOnlyTag: false })
    expect(repo.lastTidy('collections')).toBeNull() // a tag tidy is not offered here
    expect(() => repo.undoCollectionTidy(tags.id as number)).toThrow(/no longer available/)
    expect(() => repo.undoTidy(tags.id as number)).not.toThrow()
    expect(repo.getBookmark(b.id)?.tags).toEqual(['Foo', 'Foos'])
  })

  it('keeps the latest few tidies of each kind, without one crowding out the other', () => {
    const repo = makeRepo()
    repo.createBookmark({ url: 'https://a.example/', tags: ['Bar', 'Bars'] })
    const tags = repo.applyTidy({ merges: [{ keep: 'Bar', from: ['Bars'] }], remove: [], rareMaxUses: 2, keepOnlyTag: false })
    for (let i = 0; i < 4; i++) {
      const c = repo.createCollection({ name: 'Empty ' + i })
      repo.removeEmptyCollections([c.id])
    }
    expect(repo.lastTidy('tags')).toMatchObject({ id: tags.id }) // still there to undo
    const kept = (repo as unknown as { all(sql: string): { kind: string }[] }).all("SELECT kind FROM tidy_log ORDER BY id")
    expect(kept.filter((r) => r.kind === 'collections')).toHaveLength(3)
    expect(kept.filter((r) => r.kind === 'tags')).toHaveLength(1)
  })

  it('says there is nothing to do for a library with no collections', () => {
    const repo = makeRepo()
    repo.createBookmark({ url: 'https://a.example/' })
    expect(repo.emptyCollections()).toEqual([])
    expect(repo.removeEmptyCollections([]).removed).toBe(0)
  })
})

describe('tags', () => {
  it('lists counts, renames, merges and removes', () => {
    const repo = makeRepo()
    const a = repo.createBookmark({ url: 'https://a.com', tags: ['js', 'web'] })
    const b = repo.createBookmark({ url: 'https://b.com', tags: ['javascript'] })
    expect(repo.listTags()).toEqual([
      { name: 'javascript', count: 1 },
      { name: 'js', count: 1 },
      { name: 'web', count: 1 }
    ])

    repo.renameTag('js', 'javascript') // merge
    expect(repo.getBookmark(a.id)?.tags).toEqual(['javascript', 'web'])
    expect(repo.query(q({ search: '#js' })).total).toBe(0)
    expect(repo.query(q({ search: '#javascript' })).total).toBe(2)

    repo.renameTag('web', 'Web') // casing only
    expect(repo.getBookmark(a.id)?.tags).toContain('Web')

    repo.removeTag('javascript')
    expect(repo.getBookmark(b.id)?.tags).toEqual([])
    expect(repo.getBookmark(a.id)?.tags).toEqual(['Web'])
  })
})

describe('duplicates and metadata', () => {
  it('groups duplicate URLs and ignores trashed ones', () => {
    const repo = makeRepo()
    const a = repo.createBookmark({ url: 'https://example.com/p' })
    const b = repo.createBookmark({ url: 'http://www.example.com/p/?utm_medium=x' })
    repo.createBookmark({ url: 'https://example.com/other' })
    const groups = repo.findDuplicateGroups()
    expect(groups).toHaveLength(1)
    expect(groups[0]?.map((x) => x.id)).toEqual([a.id, b.id])
    repo.trash([b.id])
    expect(repo.findDuplicateGroups()).toHaveLength(0)
  })

  it('applies metadata without clobbering user-edited fields', () => {
    const repo = makeRepo()
    const auto = repo.createBookmark({ url: 'https://a.com' })
    const edited = repo.createBookmark({ url: 'https://b.com', title: 'My title', excerpt: 'mine' })
    const meta = { title: 'Scraped', excerpt: 'scraped', coverUrl: 'https://a.com/c.png', faviconUrl: 'https://a.com/f.ico' }
    expect(repo.applyMetadata(auto.id, meta)).toMatchObject({ title: 'Scraped', excerpt: 'scraped', coverUrl: meta.coverUrl })
    expect(repo.applyMetadata(edited.id, meta)).toMatchObject({ title: 'My title', excerpt: 'mine', coverUrl: meta.coverUrl })
  })
})

describe('database', () => {
  it('rolls back a failed transaction', () => {
    const repo = makeRepo()
    expect(() =>
      repo.tx(() => {
        repo.createBookmark({ url: 'https://a.com' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(repo.counts().all).toBe(0)
  })
})
