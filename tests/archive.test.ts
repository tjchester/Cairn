import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase } from '../src/main/db/database'
import { Repo } from '../src/main/db/repo'
import { parseSearch } from '../src/main/db/search'
import { exportText, importText } from '../src/main/services/importExport'
import { makeRepo, q } from './helpers'

// The Archive: one collection for what you keep but do not use. It holds sub-collections and bookmarks like any
// other, but is left out of the everyday lists, searches, exports and jobs unless it is asked for.

const dir = mkdtempSync(join(tmpdir(), 'cairn-archive-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Menus / College holds a menu; Menus holds a stray; Recipes is untouched. */
function library() {
  const repo = makeRepo()
  const menus = repo.createCollection({ name: 'Menus' })
  const college = repo.createCollection({ name: 'College', parentId: menus.id })
  const recipes = repo.createCollection({ name: 'Recipes' })
  const dinner = repo.createBookmark({ url: 'https://college.example/dinner', title: 'Dinner menu', collectionId: college.id, tags: ['menus'] })
  const stray = repo.createBookmark({ url: 'https://menus.example/stray', title: 'Stray menu', collectionId: menus.id })
  const soup = repo.createBookmark({ url: 'https://recipes.example/soup', title: 'Soup', collectionId: recipes.id, tags: ['cooking'], favorite: true })
  const loose = repo.createBookmark({ url: 'https://loose.example/', title: 'Loose end' })
  return { repo, menus, college, recipes, dinner, stray, soup, loose }
}

const pathOf = (repo: Repo, id: number | null): string => (id === null ? '(unsorted)' : repo.collectionPath(id).join(' / '))

describe('sending things to the Archive', () => {
  it('is made the first time it is needed, at the top level', () => {
    const { repo, dinner } = library()
    expect(repo.archive()).toBeNull()

    repo.archiveBookmarks([dinner.id])
    const archive = repo.archive()
    expect(archive).toMatchObject({ name: 'Archive', parentId: null, role: 'archive' })
    expect(repo.archive()?.id).toBe(archive?.id) // and only one is ever made
  })

  it('rebuilds the folders a bookmark was in', () => {
    const { repo, dinner, stray, loose } = library()
    repo.archiveBookmarks([dinner.id, stray.id, loose.id])

    expect(pathOf(repo, repo.getBookmark(dinner.id)?.collectionId ?? null)).toBe('Archive / Menus / College')
    expect(pathOf(repo, repo.getBookmark(stray.id)?.collectionId ?? null)).toBe('Archive / Menus')
    expect(pathOf(repo, repo.getBookmark(loose.id)?.collectionId ?? null)).toBe('Archive') // it was unsorted
    expect(repo.collectionPath(repo.getBookmark(dinner.id)?.collectionId ?? 0)).toEqual(['Archive', 'Menus', 'College'])
    // The live folders stay where they are, now empty.
    expect(repo.listCollections().filter((c) => c.name === 'Menus')).toHaveLength(2)
  })

  it('reuses the folders it already made, rather than making them twice', () => {
    const { repo, dinner, stray } = library()
    repo.archiveBookmarks([dinner.id])
    const after = repo.listCollections().length
    repo.archiveBookmarks([stray.id])
    expect(repo.listCollections().length).toBe(after)
    expect(repo.listCollections().filter((c) => c.name === 'College')).toHaveLength(2) // the live one and the archived one
  })

  it('sends a whole collection, keeping the path it was filed under, and merges with what is there', () => {
    const { repo, college, dinner } = library()
    repo.archiveBookmarks([dinner.id]) // makes Archive / Menus / College first
    const archived = repo.getBookmark(dinner.id)?.collectionId

    const extra = repo.createBookmark({ url: 'https://college.example/lunch', title: 'Lunch menu', collectionId: college.id })
    repo.archiveCollections([college.id])

    expect(repo.getCollection(college.id)).toBeNull() // merged into the one already in the Archive
    expect(repo.getBookmark(extra.id)?.collectionId).toBe(archived)
    expect(repo.listCollections().filter((c) => c.name === 'College')).toHaveLength(1)
    expect(repo.query(q({ scope: { kind: 'collection', id: archived as number } })).total).toBe(2)
  })

  it('brings bookmarks and collections back where they came from', () => {
    const { repo, dinner, loose, menus } = library()
    repo.archiveBookmarks([dinner.id, loose.id])
    expect(repo.restoreBookmarks([dinner.id, loose.id])).toEqual({ moved: 2 })
    expect(pathOf(repo, repo.getBookmark(dinner.id)?.collectionId ?? null)).toBe('Menus / College')
    expect(repo.getBookmark(loose.id)?.collectionId).toBeNull() // from the Archive's own root, back to Unsorted

    repo.archiveCollections([menus.id])
    const archivedMenus = repo.listCollections().find((c) => c.name === 'Menus' && c.parentId === repo.archive()?.id)
    expect(archivedMenus).toBeDefined()
    repo.restoreCollections([archivedMenus?.id as number])
    expect(repo.listCollections().find((c) => c.name === 'Menus')?.parentId).toBeNull()
    expect(pathOf(repo, repo.getBookmark(dinner.id)?.collectionId ?? null)).toBe('Menus / College')
  })

  it('leaves alone what is already there, and never archives the Archive', () => {
    const { repo, dinner } = library()
    repo.archiveBookmarks([dinner.id])
    expect(repo.archiveBookmarks([dinner.id])).toEqual({ moved: 0 })
    const archive = repo.archive() as { id: number }
    expect(repo.archiveCollections([archive.id])).toEqual({ moved: 0 })
    expect(repo.archive()?.parentId).toBeNull()
  })

  it('cannot be deleted or filed under another collection, but can be renamed', () => {
    const { repo, dinner, menus } = library()
    repo.archiveBookmarks([dinner.id])
    const archive = repo.archive() as { id: number }

    expect(() => repo.deleteCollection(archive.id)).toThrow(/Archive cannot be deleted/)
    expect(() => repo.moveCollection(archive.id, menus.id, 0)).toThrow(/stays at the top level/)
    repo.updateCollection(archive.id, { name: 'Attic' })
    expect(repo.archive()).toMatchObject({ name: 'Attic', role: 'archive' })
    expect(repo.emptyCollections().map((c) => c.name)).not.toContain('Attic') // nor tidied away when empty
  })
})

describe('what the Archive is left out of', () => {
  /** Soup is archived; everything else stays where it is. */
  function archived() {
    const made = library()
    made.repo.archiveBookmarks([made.soup.id])
    return made
  }

  it('the ordinary lists and their counts', () => {
    const { repo, soup } = archived()
    expect(repo.query(q()).total).toBe(3)
    expect(repo.query(q()).items.map((b) => b.id)).not.toContain(soup.id)
    expect(repo.query(q({ search: 'soup' })).total).toBe(0)
    expect(repo.query(q({ scope: { kind: 'favorites' } })).total).toBe(0)
    expect(repo.matchingIds({ scope: { kind: 'all' } })).toHaveLength(3)

    const counts = repo.counts()
    expect(counts).toMatchObject({ all: 3, favorites: 0, archived: 1 })
  })

  it('...unless you ask for it, search for it, or look inside it', () => {
    const { repo, soup } = archived()
    expect(repo.query(q({ includeArchived: true })).total).toBe(4)
    expect(repo.query(q({ search: 'soup', includeArchived: true })).items[0]?.id).toBe(soup.id)
    expect(repo.query(q({ search: 'is:archived' })).items.map((b) => b.id)).toEqual([soup.id])
    expect(parseSearch('is:archived').archived).toBe(true)

    const archive = repo.archive() as { id: number }
    expect(repo.query(q({ scope: { kind: 'collection', id: archive.id } })).total).toBe(1)
    const inside = repo.listCollections().find((c) => c.name === 'Recipes' && c.parentId === archive.id)
    expect(repo.query(q({ scope: { kind: 'collection', id: inside?.id as number } })).total).toBe(1)
  })

  it('the tag list, the duplicate finder and the bulk jobs', () => {
    const { repo, soup } = archived()
    expect(repo.listTags().map((t) => t.name)).toEqual(['menus'])
    expect(repo.tagStats().map((t) => t.name)).toEqual(['menus'])

    repo.createBookmark({ url: 'https://recipes.example/soup', title: 'Soup again' }) // same address as the archived one
    expect(repo.findDuplicateGroups()).toEqual([])

    expect(repo.listForJob('all').map((j) => j.id)).not.toContain(soup.id)
    expect(repo.listForTagging('all').map((c) => c.id)).not.toContain(soup.id)
  })

  it('but the Trash still shows everything you deleted, wherever it was kept', () => {
    const { repo, soup } = archived()
    repo.trash([soup.id])
    expect(repo.query(q({ scope: { kind: 'trash' } })).items.map((b) => b.id)).toEqual([soup.id])
    expect(repo.counts().trash).toBe(1)
  })
})

describe('exports and backups', () => {
  it('leaves the Archive out of an export for another program, unless asked', () => {
    const { repo, soup } = library()
    repo.archiveBookmarks([soup.id])

    for (const format of ['html', 'csv'] as const) {
      expect(exportText(repo, format), format).not.toContain('recipes.example/soup')
      expect(exportText(repo, format, { includeArchived: true }), format).toContain('recipes.example/soup')
      expect(exportText(repo, format)).toContain('college.example/dinner')
    }
  })

  it('always keeps everything in a backup, and restores the Archive as the Archive', () => {
    const { repo, soup, dinner } = library()
    repo.archiveBookmarks([soup.id, dinner.id])
    repo.updateCollection((repo.archive() as { id: number }).id, { name: 'Attic' })
    const backup = exportText(repo, 'json')
    expect(backup).toContain('recipes.example/soup')
    expect(JSON.parse(backup).archivePath).toEqual(['Attic'])

    const restored = makeRepo()
    importText(restored, 'backup.json', backup)
    expect(restored.archive()).toMatchObject({ name: 'Attic', role: 'archive', parentId: null })
    expect(restored.query(q()).total).toBe(2) // the two archived ones stay out of the way
    expect(restored.query(q({ includeArchived: true })).total).toBe(4)
    expect(pathOf(restored, restored.query(q({ search: 'soup', includeArchived: true })).items[0]?.collectionId ?? null)).toBe('Attic / Recipes')
  })
})

describe('schema upgrade (v6 -> v7)', () => {
  it('adds the role and leaves a library without an Archive working as before', () => {
    const file = join(dir, 'v6.db')
    const old = new DatabaseSync(file)
    old.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    for (const step of MIGRATIONS.slice(0, 6)) {
      if (typeof step === 'string') old.exec(step)
      else step(old)
    }
    old.exec('PRAGMA user_version = 6')
    old.exec("INSERT INTO collections (id, parent_id, name, position, created_at, updated_at) VALUES (1, NULL, 'Menus', 0, '2026-01-01', '2026-01-01')")
    old.exec("INSERT INTO bookmarks (url, url_key, title, domain, collection_id, created_at, updated_at) VALUES ('https://a.example/', 'a.example', 'A', 'a.example', 1, '2026-01-01', '2026-01-01')")
    old.close()

    const db = openDatabase(file)
    const repo = new Repo(db)
    expect(repo.archive()).toBeNull()
    expect(repo.query(q()).total).toBe(1)
    expect(repo.counts()).toMatchObject({ all: 1, archived: 0 })
    db.close()
    expect(existsSync(file + '.v6.bak')).toBe(true)
  })
})
