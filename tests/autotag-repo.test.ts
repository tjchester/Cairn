import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDatabase } from '../src/main/db/database'
import { Repo } from '../src/main/db/repo'
import { makeRepo, q } from './helpers'

const dir = mkdtempSync(join(tmpdir(), 'cairn-db-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('schema upgrade (v1 -> v2)', () => {
  it('keeps every existing row, adds the new columns, and backs the old database up first', () => {
    const file = join(dir, 'old.db')
    // A database exactly as v1 of the app left it.
    const old = new DatabaseSync(file)
    old.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    old.exec(MIGRATIONS[0] as string)
    old.exec('PRAGMA user_version = 1')
    old.exec("INSERT INTO bookmarks (url, url_key, title, domain, created_at, updated_at) VALUES ('https://a.com/', 'a.com', 'A', 'a.com', '2026-01-01', '2026-01-01')")
    old.exec("INSERT INTO tags (name) VALUES ('keep')")
    old.exec('INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (1, 1)')
    old.close()

    const db = openDatabase(file)
    const repo = new Repo(db)
    const b = repo.getBookmark(1)
    expect(b).toMatchObject({ title: 'A', tags: ['keep'], autoTags: [] }) // existing tags count as the user's own
    expect(repo.getSignals(1)).toBeNull()
    expect(repo.listForJob('missing-metadata')).toHaveLength(1)
    db.close()

    expect(existsSync(file + '.v1.bak')).toBe(true)
    const backup = new DatabaseSync(file + '.v1.bak', { readOnly: true })
    expect((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1) // untouched
    expect((backup.prepare('SELECT COUNT(*) AS n FROM bookmarks').get() as { n: number }).n).toBe(1)
    backup.close()
  })

  it('does not make a backup for a brand-new database, or when already up to date', () => {
    const file = join(dir, 'new.db')
    openDatabase(file).close()
    openDatabase(file).close()
    expect(existsSync(file + '.v1.bak')).toBe(false)
    expect(existsSync(file + '.v2.bak')).toBe(false)
  })
})

describe('tag provenance', () => {
  it('records which tags were added automatically, and keeps that when the bookmark is edited', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://a.com', tags: ['mine', 'suggested'], tagSources: { Suggested: 'builtin' } })
    expect(b.tags).toEqual(['mine', 'suggested'])
    expect(b.autoTags).toEqual(['suggested'])

    const edited = repo.updateBookmark(b.id, { tags: ['mine', 'suggested', 'extra'] })
    expect(edited.autoTags).toEqual(['suggested']) // still automatic; 'extra' is the user's
    const removed = repo.updateBookmark(b.id, { tags: ['mine', 'extra'] })
    expect(removed.autoTags).toEqual([])
  })

  it('addAutoTags keeps existing tags, skips duplicates, and does not touch the updated date', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://a.com', tags: ['Docker'] })
    const added = repo.addAutoTags(b.id, ['docker', 'code', 'Code'], 'builtin', null)
    expect(added).toEqual(['code'])
    const after = repo.getBookmark(b.id)
    expect(after).toMatchObject({ tags: ['code', 'Docker'], autoTags: ['code'], updatedAt: b.updatedAt })
    expect(repo.query(q({ search: '#code' })).total).toBe(1) // searchable straight away
  })

  it('undoes a run without touching tags the user added, and can remove all automatic tags', () => {
    const repo = makeRepo()
    const a = repo.createBookmark({ url: 'https://a.com', tags: ['mine'] })
    const b = repo.createBookmark({ url: 'https://b.com' })
    const run = repo.createRun('auto-tag', 'auto')
    repo.addAutoTags(a.id, ['auto1'], 'builtin', run)
    repo.addAutoTags(b.id, ['auto1', 'auto2'], 'llm', run)
    repo.finishRun(run, 3, 2)
    expect(repo.lastRun()).toMatchObject({ id: run, tagsApplied: 3, bookmarksTouched: 2, undone: false })

    expect(repo.undoRun(run)).toBe(3)
    expect(repo.getBookmark(a.id)?.tags).toEqual(['mine'])
    expect(repo.getBookmark(b.id)?.tags).toEqual([])
    expect(repo.listTags().map((t) => t.name)).toEqual(['mine']) // orphaned tags are cleaned up
    expect(repo.lastRun()).toBeNull()

    repo.addAutoTags(a.id, ['later'], 'builtin', null)
    expect(repo.removeAutoTags()).toBe(1)
    expect(repo.getBookmark(a.id)?.tags).toEqual(['mine'])
  })
})

describe('signals and job selection', () => {
  it('stores page signals and treats "never fetched" as missing', () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://a.com' })
    expect(repo.listForJob('missing-metadata')).toHaveLength(1)
    const signals = { keywords: ['x'], ogType: 'article', siteName: null, lang: 'en', section: null, text: 'hello' }
    repo.applyMetadata(b.id, { title: 'T', signals })
    expect(repo.getSignals(b.id)).toEqual(signals)
    expect(repo.listForJob('missing-metadata')).toHaveLength(0)
  })

  it('lists bookmarks for tagging by scope, with their tags and signals', () => {
    const repo = makeRepo()
    const tagged = repo.createBookmark({ url: 'https://a.com', tags: ['t'] })
    const bare = repo.createBookmark({ url: 'https://b.com' })
    const gone = repo.createBookmark({ url: 'https://c.com' })
    repo.trash([gone.id])
    expect(repo.listForTagging('untagged').map((c) => c.id)).toEqual([bare.id])
    expect(repo.listForTagging('all').map((c) => c.id)).toEqual([tagged.id, bare.id])
    expect(repo.listForTagging('ids', [tagged.id]).map((c) => [c.id, c.tags])).toEqual([[tagged.id, ['t']]])
    expect(repo.getTaggingCandidate(bare.id)).toMatchObject({ url: 'https://b.com/', tags: [], signals: null })
  })
})

describe('proposals (review queue)', () => {
  const setup = () => {
    const repo = makeRepo()
    const a = repo.createBookmark({ url: 'https://a.com', title: 'A' })
    const b = repo.createBookmark({ url: 'https://b.com', title: 'B' })
    repo.createBookmark({ url: 'https://c.com', title: 'C', tags: ['docker'] })
    const run = repo.createRun('auto-tag', 'suggest')
    for (const id of [a.id, b.id]) repo.addProposals(run, id, [{ tag: 'docker', score: 0.8, origin: 'builtin', reason: 'Title mentions docker' }])
    repo.addProposals(run, a.id, [{ tag: 'code', score: 0.7, origin: 'builtin', reason: 'Site: github.com' }])
    return { repo, a, b, run }
  }

  it('groups pending proposals by tag, flagging tags that already exist in the library', () => {
    const { repo } = setup()
    expect(repo.pendingProposalCount()).toBe(3)
    const groups = repo.proposalGroups()
    expect(groups.map((g) => [g.tag, g.count, g.existing])).toEqual([
      ['docker', 2, true],
      ['code', 1, false]
    ])
    expect(repo.proposalItems('docker').map((i) => i.title)).toEqual(['A', 'B'])
  })

  it('applies a tag for everyone or just for chosen bookmarks, as one undoable run', () => {
    const { repo, a, b } = setup()
    const first = repo.applyProposals('docker', [a.id])
    expect(first.applied).toBe(1)
    expect(repo.getBookmark(a.id)).toMatchObject({ tags: ['docker'], autoTags: ['docker'] })
    expect(repo.getBookmark(b.id)?.tags).toEqual([])
    expect(repo.pendingProposalCount()).toBe(2)

    const rest = repo.applyProposals('docker')
    expect(rest.applied).toBe(1)
    expect(repo.undoRun(rest.runId as number)).toBe(1)
    expect(repo.getBookmark(b.id)?.tags).toEqual([])
    expect(repo.getBookmark(a.id)?.tags).toEqual(['docker']) // the earlier run is unaffected
  })

  it('remembers rejections so the same tag is not proposed again, and blocks a tag for good on request', () => {
    const { repo, a, run } = setup()
    expect(repo.rejectProposals('code')).toBe(1)
    expect(repo.addProposals(run, a.id, [{ tag: 'code', score: 0.9, origin: 'builtin', reason: 'again' }])).toBe(0)
    expect(repo.pendingProposalCount()).toBe(2)

    repo.neverSuggest('docker')
    expect(repo.blockedTags()).toEqual(['docker'])
    expect(repo.pendingProposalCount()).toBe(0)
    repo.unblockTag('docker')
    expect(repo.blockedTags()).toEqual([])
  })

  it('drops proposals for deleted bookmarks and can discard everything pending', () => {
    const { repo, a } = setup()
    repo.trash([a.id])
    expect(repo.pendingProposalCount()).toBe(1)
    expect(repo.discardPendingProposals()).toBe(3) // includes the trashed bookmark's rows
    expect(repo.pendingProposalCount()).toBe(0)
  })
})
