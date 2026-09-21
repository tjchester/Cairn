import { describe, expect, it } from 'vitest'
import { DEFAULT_TAGGING, type OllamaStatus, type TagSuggestion, type TaggingMode } from '../src/shared/types'
import type { Repo } from '../src/main/db/repo'
import { mergeCandidates, type Candidate } from '../src/main/tagging/engine'
import type { LlmClient, LlmInput } from '../src/main/tagging/llm'
import { TaggingService } from '../src/main/tagging/service'
import { buildTidyPlan, chooseKeeper } from '../src/main/tagging/tidy'
import { canon, GENERIC_TAGS, variantKey } from '../src/main/tagging/text'
import { Vocabulary } from '../src/main/tagging/vocabulary'
import { makeRepo } from './helpers'

// Keeping the tag list tidy: look-alike tags are folded together as they are created, brand-new tags that only the
// model thought of wait for a second bookmark, vague ones are refused, and "Tidy tags" cleans up what already exists.

describe('look-alike forms of a tag', () => {
  it('folds -ing / -er endings and plurals, but only when a real stem is left', () => {
    for (const same of [
      ['ad-blocker', 'ad-blockers', 'ad-blocking', 'adblock', 'AdBlock'],
      ['debugging', 'debugger', 'debuggers', 'debug'],
      ['programmer', 'programmers'],
      ['building', 'builder', 'builds', 'build'],
      ['learning', 'learn'],
      ['how-to', 'how-tos', 'How To'],
      ['network', 'networking', 'networks']
    ]) {
      expect(new Set(same.map(variantKey)), same.join(' / ')).toHaveProperty('size', 1)
    }
    for (const different of [
      ['server', 'serving'], // "serv" is too short a stem to fold anything onto
      ['router', 'routing'],
      ['string', 'strong'],
      ['c++', 'c#'],
      ['editor', 'editing'],
      ['gaming', 'games'],
      ['accounting', 'account'], // a subject of its own
      ['printing', 'printers'],
      ['programming', 'program']
    ]) {
      expect(new Set(different.map(variantKey)), different.join(' / ')).toHaveProperty('size', 2)
    }
    expect(variantKey('servers')).toBe(canon('server'))
  })

  it('a vocabulary maps a new spelling onto the tag that exists, and remembers tags as they are created', () => {
    const vocabulary = new Vocabulary([{ name: 'ad-blocker', count: 3 }, { name: 'JS', count: 10 }])
    expect(vocabulary.resolve('ad-blockers')).toEqual({ name: 'ad-blocker', existing: true })
    expect(vocabulary.resolve('Ad Blocking')).toEqual({ name: 'ad-blocker', existing: true })
    expect(vocabulary.resolve('adblock')).toEqual({ name: 'ad-blocker', existing: true })
    expect(vocabulary.resolve('javascript', ['js'])).toEqual({ name: 'JS', existing: true })
    expect(vocabulary.resolve('privacy')).toEqual({ name: 'privacy', existing: false })

    vocabulary.add('privacy') // created during the run: the rest of the run reuses it
    expect(vocabulary.resolve('Privacies')).toEqual({ name: 'privacy', existing: true })
    vocabulary.add('privacy')
    expect(vocabulary.entries().find((e) => e.name === 'privacy')?.count).toBe(2)

    vocabulary.noteHeld('minio') // an idea nobody has used yet: same spelling, but not "existing"
    expect(vocabulary.resolve('MinIO')).toEqual({ name: 'minio', existing: false })
    expect(vocabulary.relevant('object storage with minio', 5)).toContain('minio')
    expect(vocabulary.entries().some((e) => e.name === 'minio')).toBe(false) // never matched against page text
    vocabulary.add('minio')
    expect(vocabulary.resolve('minio')).toEqual({ name: 'minio', existing: true })
  })
})

describe('what the model may invent', () => {
  const input = { url: 'https://example.org/a', title: 'A page', excerpt: '' }
  const context = (tags: { name: string; count: number }[] = []) => ({
    vocabulary: new Vocabulary(tags),
    rules: { domains: new Map(), tlds: new Map(), hostPrefixes: new Map(), pathSegments: new Map(), extensions: new Map(), ogTypes: new Map(), phraseToTag: new Map(), aliases: new Map() } as never,
    blocked: new Set<string>(),
    maxTags: 5
  })
  const fromModel = (...tags: string[]): Candidate[] => tags.map((tag) => ({ tag, score: 0.75, source: 'llm' as const, reason: 'model', trusted: true }))

  it('refuses vague new tags, but keeps ones you already have', () => {
    expect(GENERIC_TAGS.has('system')).toBe(true)
    const fresh = mergeCandidates(fromModel('system', 'service', 'raspberry-pi'), input, context())
    expect(fresh.map((s) => s.tag)).toEqual(['raspberry-pi'])
    const known = mergeCandidates(fromModel('system', 'service'), input, context([{ name: 'system', count: 40 }]))
    expect(known.map((s) => s.tag)).toEqual(['system'])
  })

  it('maps its variants onto your tag instead of creating another', () => {
    const suggestions = mergeCandidates(fromModel('ad-blocking'), input, context([{ name: 'ad-blocker', count: 4 }]))
    expect(suggestions).toMatchObject([{ tag: 'ad-blocker', existing: true }])
  })
})

// ---------------------------------------------------------------- delivering

class ScriptedLlm implements LlmClient {
  calls = 0
  constructor(private readonly answers: string[][]) {}
  async suggest(_input: LlmInput): Promise<string[]> {
    return this.answers[this.calls++] ?? []
  }
  async status(): Promise<OllamaStatus> {
    return { ok: true, models: ['m'], modelReady: true, message: 'ok' }
  }
}

function setup(mode: TaggingMode, answers: string[][]) {
  const repo = makeRepo()
  const config = { ...DEFAULT_TAGGING, mode, llm: { ...DEFAULT_TAGGING.llm, enabled: true, model: 'm' } }
  const tagging = new TaggingService(repo, () => config, new ScriptedLlm(answers))
  return { repo, tagging }
}

/** What the bulk job does for one bookmark, on the run's own context. */
async function classify(repo: Repo, tagging: TaggingService, context: ReturnType<TaggingService['context']>, bookmarkId: number, mode: 'suggest' | 'auto', runId: number) {
  const candidate = repo.getTaggingCandidate(bookmarkId)
  if (!candidate) throw new Error('missing bookmark')
  const suggestions: TagSuggestion[] = await tagging.suggestForCandidateWithLlm(candidate, context)
  return tagging.deliver(bookmarkId, suggestions, mode, runId, context)
}

describe('bulk delivery of the model\'s tags', () => {
  it('holds a brand-new tag until a second bookmark wants it, then gives it to both (Auto mode)', async () => {
    const { repo, tagging } = setup('auto', [['minio'], ['minio'], ['minio']])
    const [a, b, c] = ['a', 'b', 'c'].map((n) => repo.createBookmark({ url: `https://${n}.example.org/`, title: 'Object storage ' + n }))
    const context = tagging.context()
    const run = repo.createRun('auto-tag', 'auto')

    expect(await classify(repo, tagging, context, a!.id, 'auto', run)).toMatchObject({ added: 0, held: 1 })
    expect(repo.getBookmark(a!.id)?.tags).toEqual([]) // one bookmark alone does not create a tag
    expect(repo.heldTags()).toEqual(['minio'])

    const second = await classify(repo, tagging, context, b!.id, 'auto', run)
    expect(second).toMatchObject({ added: 2, held: 0, promoted: 1 })
    expect(repo.getBookmark(a!.id)).toMatchObject({ tags: ['minio'], autoTags: ['minio'] }) // the earlier one gets it now
    expect(repo.getBookmark(b!.id)?.tags).toEqual(['minio'])
    expect(repo.heldTags()).toEqual([])

    expect(await classify(repo, tagging, context, c!.id, 'auto', run)).toMatchObject({ added: 1, held: 0 }) // an ordinary tag from now on
    expect(repo.listTags().filter((t) => t.name === 'minio')).toEqual([{ name: 'minio', count: 3 }])
  })

  it('in Suggest mode, held ideas only appear for review once a second bookmark wants them', async () => {
    const { repo, tagging } = setup('suggest', [['minio'], ['minio'], ['minio']])
    const [a, b, c] = ['a', 'b', 'c'].map((n) => repo.createBookmark({ url: `https://${n}.example.org/`, title: 'Object storage ' + n }))
    const context = tagging.context()
    const run = repo.createRun('auto-tag', 'suggest')

    await classify(repo, tagging, context, a!.id, 'suggest', run)
    expect(repo.pendingProposalCount()).toBe(0) // nothing to review yet
    const second = await classify(repo, tagging, context, b!.id, 'suggest', run)
    expect(second).toMatchObject({ proposed: 2, promoted: 1 })
    expect(repo.proposalGroups()).toMatchObject([{ tag: 'minio', count: 2 }])
    await classify(repo, tagging, context, c!.id, 'suggest', run)
    expect(repo.proposalGroups()).toMatchObject([{ tag: 'minio', count: 3 }]) // not held again
  })

  it('does not hold tags you already have, or ones the built-in engine agrees with', async () => {
    const { repo, tagging } = setup('auto', [['docker'], ['kubernetes']])
    repo.createBookmark({ url: 'https://old.example.org/', tags: ['docker'] })
    const a = repo.createBookmark({ url: 'https://a.example.org/', title: 'Learning docker' })
    const b = repo.createBookmark({ url: 'https://b.example.org/', title: 'Kubernetes cluster basics' }) // "kubernetes" is a built-in topic too
    const context = tagging.context()
    const run = repo.createRun('auto-tag', 'auto')
    expect(await classify(repo, tagging, context, a.id, 'auto', run)).toMatchObject({ held: 0 })
    expect(await classify(repo, tagging, context, b.id, 'auto', run)).toMatchObject({ held: 0 })
    expect(repo.getBookmark(b.id)?.tags).toContain('kubernetes')
  })

  it('reuses what the run has just created, so variants do not pile up (the "ad-blocker" problem)', async () => {
    const answers = [['ad-blocker'], ['ad-blockers'], ['ad-blocking'], ['adblock'], ['Ad Blockers']]
    const { repo, tagging } = setup('auto', answers)
    const ids = answers.map((_, i) => repo.createBookmark({ url: `https://s${i}.example.org/`, title: 'Blocking ads ' + i }).id)
    const context = tagging.context() // one context for the whole run, as the job does
    const run = repo.createRun('auto-tag', 'auto')
    for (const id of ids) await classify(repo, tagging, context, id, 'auto', run)

    const names = repo.listTags().map((t) => t.name)
    expect(names).toEqual(['ad-blocker'])
    expect(repo.listTags()[0]?.count).toBe(5)
  })

  it('remembers held ideas across runs (a new run starts with them)', async () => {
    const first = setup('auto', [['minio']])
    const a = first.repo.createBookmark({ url: 'https://a.example.org/', title: 'Object storage' })
    await classify(first.repo, first.tagging, first.tagging.context(), a.id, 'auto', first.repo.createRun('auto-tag', 'auto'))
    expect(first.tagging.context().vocabulary.resolve('MinIO')).toEqual({ name: 'minio', existing: false })
  })
})

// ------------------------------------------------------------------- tidying

/** Builds a library like the one that prompted this: a few families of look-alike tags plus lots of one-offs. */
function messyLibrary() {
  const repo = makeRepo()
  const mk = (n: number, tags: string[], sources: Record<string, 'builtin' | 'llm'> = {}) => repo.createBookmark({ url: `https://s${n}.example.org/`, title: 'B' + n, tags, tagSources: sources })
  const llm = (...tags: string[]) => Object.fromEntries(tags.map((t) => [t, 'llm' as const]))
  const runId = repo.createRun('auto-tag', 'auto')
  const b = [
    mk(1, ['ad-blocking', 'Gaming'], llm('ad-blocking')),
    mk(2, ['ad-blocking', 'privacy'], llm('ad-blocking', 'privacy')),
    mk(3, ['ad-blockers', 'adblock'], llm('ad-blockers', 'adblock')),
    mk(4, ['Gaming'], {}),
    mk(5, ['games'], llm('games')),
    mk(6, ['heap-dumps'], llm('heap-dumps')), // only tag, used once
    mk(7, ['barcode', 'privacy'], llm('barcode', 'privacy')), // barcode used once, privacy stays
    mk(8, ['system', 'privacy'], llm('system', 'privacy')),
    mk(9, ['system'], llm('system')),
    mk(10, ['Walkthroughs'], {}),
    mk(11, ['Walkthrough'], {}) // two of the user's own tags that look alike
  ]
  return { repo, b, runId }
}

describe('Tidy tags: the plan', () => {
  it('groups look-alike tags, offers rare and vague automatic ones, and never offers yours for removal', () => {
    const { repo } = messyLibrary()
    const plan = buildTidyPlan(repo.tagStats(), repo.tagsByBookmark(), 2)

    const adblock = plan.groups.find((g) => g.members.some((m) => m.name === 'adblock'))
    expect(adblock?.members.map((m) => m.name).sort()).toEqual(['ad-blockers', 'ad-blocking', 'adblock'])
    expect(adblock).toMatchObject({ keep: 'ad-blocking', spellingOnly: false, selected: true })

    const walk = plan.groups.find((g) => g.members.some((m) => m.name === 'Walkthroughs'))
    expect(walk).toMatchObject({ spellingOnly: true, selected: false }) // both are yours: your call
    expect(plan.groups.some((g) => g.members.some((m) => m.name === 'Gaming'))).toBe(false) // "games" is a different word

    const rare = plan.rare.tags.map((t) => t.name)
    expect(rare).toEqual(expect.arrayContaining(['heap-dumps', 'barcode', 'games']))
    expect(rare).not.toContain('Gaming') // yours
    expect(rare).not.toContain('adblock') // it is in a merge group instead
    expect(plan.rare.onlyTag).toBeGreaterThan(0) // heap-dumps is a bookmark's only tag
    expect(plan.vague.map((t) => t.name)).toEqual([]) // "system" is used twice, which counts as rare here
    expect(buildTidyPlan(repo.tagStats(), repo.tagsByBookmark(), 1).vague.map((t) => t.name)).toEqual(['system'])
    expect(plan.oneUse).toBeGreaterThan(0)
  })

  it('keeps one of your own tags as the survivor of a merge', () => {
    const keeper = chooseKeeper([
      { name: 'javascript', uses: 300, userUses: 0 },
      { name: 'JS', uses: 5, userUses: 5 }
    ])
    expect(keeper.name).toBe('JS')
  })
})

describe('Tidy tags: applying and undoing', () => {
  const merge = { keep: 'ad-blocking', from: ['ad-blockers', 'adblock'] }

  it('merges look-alikes, keeping each bookmark\'s tags and where they came from', () => {
    const { repo, b } = messyLibrary()
    const result = repo.applyTidy({ merges: [merge], remove: [], rareMaxUses: 2, keepOnlyTag: true })
    expect(result).toMatchObject({ merged: 2, removed: 0 })
    expect(repo.getBookmark(b[2]!.id)).toMatchObject({ tags: ['ad-blocking'], autoTags: ['ad-blocking'] }) // was two tags, is one
    expect(repo.getBookmark(b[0]!.id)?.tags).toEqual(['ad-blocking', 'Gaming'])
    expect(repo.listTags().map((t) => t.name)).not.toContain('adblock')
    expect(repo.query({ scope: { kind: 'all' }, search: '#ad-blocking', sort: 'created', direction: 'desc', limit: 10, offset: 0 }).total).toBe(3) // searchable straight away
  })

  it('counts a merged tag as yours if either tag was, and never removes your own tags', () => {
    const { repo, b } = messyLibrary()
    repo.applyTidy({ merges: [{ keep: 'Walkthroughs', from: ['Walkthrough'] }], remove: ['Gaming', 'Walkthroughs'], rareMaxUses: 50, keepOnlyTag: false })
    expect(repo.getBookmark(b[10]!.id)).toMatchObject({ tags: ['Walkthroughs'], autoTags: [] })
    expect(repo.getBookmark(b[0]!.id)?.tags).toContain('Gaming') // yours: refused whatever was asked
    expect(repo.getBookmark(b[9]!.id)?.tags).toEqual(['Walkthroughs'])
  })

  it('removes rare automatic tags but leaves a bookmark\'s only tag alone (unless told otherwise)', () => {
    const { repo, b } = messyLibrary()
    const result = repo.applyTidy({ merges: [], remove: ['heap-dumps', 'barcode', 'games'], rareMaxUses: 2, keepOnlyTag: true })
    expect(repo.getBookmark(b[5]!.id)?.tags).toEqual(['heap-dumps']) // its only tag
    expect(repo.getBookmark(b[4]!.id)?.tags).toEqual(['games']) // its only tag
    expect(repo.getBookmark(b[6]!.id)?.tags).toEqual(['privacy']) // barcode went, privacy stayed
    expect(result).toMatchObject({ removed: 1, keptAsOnlyTag: 2 })

    const strict = messyLibrary()
    strict.repo.applyTidy({ merges: [], remove: ['heap-dumps'], rareMaxUses: 2, keepOnlyTag: false })
    expect(strict.repo.getBookmark(strict.b[5]!.id)?.tags).toEqual([])
  })

  it('checks every removal again: a tag that is no longer rare, or is yours, stays', () => {
    const { repo, b } = messyLibrary()
    repo.applyTidy({ merges: [], remove: ['privacy', 'ad-blocking', 'Gaming', 'no-such-tag'], rareMaxUses: 1, keepOnlyTag: false })
    expect(repo.getBookmark(b[1]!.id)?.tags).toEqual(['ad-blocking', 'privacy']) // used three and two times: not rare at 1
    expect(repo.getBookmark(b[0]!.id)?.tags).toEqual(['ad-blocking', 'Gaming'])
  })

  it('merges first, so a tag made popular by the merge is not removed as rare', () => {
    const { repo, b } = messyLibrary()
    repo.applyTidy({ merges: [merge], remove: ['adblock', 'ad-blockers', 'ad-blocking'], rareMaxUses: 2, keepOnlyTag: false })
    expect(repo.getBookmark(b[0]!.id)?.tags).toContain('ad-blocking') // three bookmarks now: above the limit
    expect(repo.getBookmark(b[2]!.id)?.tags).toEqual(['ad-blocking'])
  })

  it('undoes exactly what it did, including provenance and the runs tags came from', () => {
    const { repo, b, runId } = messyLibrary()
    repo.addAutoTags(b[3]!.id, ['barcode'], 'llm', runId)
    const snapshot = () => JSON.stringify(repo.allActiveBookmarks().map((x) => [x.id, x.tags, x.autoTags]))
    const dbRows = () => JSON.stringify((repo as unknown as { all(sql: string): unknown[] }).all('SELECT bookmark_id, (SELECT name FROM tags t WHERE t.id = bt.tag_id) AS name, source, run_id FROM bookmark_tags bt ORDER BY bookmark_id, name'))
    const before = snapshot()
    const rowsBefore = dbRows()

    const done = repo.applyTidy({ merges: [merge, { keep: 'Walkthroughs', from: ['Walkthrough'] }], remove: ['heap-dumps', 'barcode', 'games'], rareMaxUses: 2, keepOnlyTag: false })
    expect(done.id).not.toBeNull()
    expect(snapshot()).not.toBe(before)
    expect(repo.lastTidy()).toMatchObject({ id: done.id, merged: 3, removed: done.removed })

    repo.undoTidy(done.id as number)
    expect(snapshot()).toBe(before)
    expect(dbRows()).toBe(rowsBefore)
    expect(repo.lastTidy()).toBeNull()
    expect(() => repo.undoTidy(done.id as number)).toThrow(/already undone/)
  })

  it('does nothing (and records nothing) when there is nothing to do', () => {
    const { repo } = messyLibrary()
    expect(repo.applyTidy({ merges: [{ keep: 'nope', from: ['also-nope'] }], remove: ['nothing'], rareMaxUses: 2, keepOnlyTag: true })).toMatchObject({ id: null, merged: 0, removed: 0 })
    expect(repo.lastTidy()).toBeNull()
  })

  it('keeps only the latest few tidies', () => {
    const repo = makeRepo()
    for (let i = 0; i < 5; i++) {
      repo.createBookmark({ url: `https://s${i}.example.org/`, tags: [`Foo${i}`, `Foo${i}s`] })
      repo.applyTidy({ merges: [{ keep: `Foo${i}`, from: [`Foo${i}s`] }], remove: [], rareMaxUses: 2, keepOnlyTag: false })
    }
    const n = (repo as unknown as { get(sql: string): { n: number } }).get('SELECT COUNT(*) AS n FROM tidy_log').n
    expect(n).toBe(3)
  })

  it('carries waiting suggestions along with a merged tag', () => {
    const { repo, b } = messyLibrary()
    const run = repo.createRun('auto-tag', 'suggest')
    repo.addProposals(run, b[9]!.id, [{ tag: 'ad-blockers', score: 0.7, origin: 'llm', reason: 'x' }])
    repo.addProposals(run, b[10]!.id, [{ tag: 'ad-blockers', score: 0.7, origin: 'llm', reason: 'x' }], 'held')
    repo.applyTidy({ merges: [merge], remove: [], rareMaxUses: 2, keepOnlyTag: true })
    expect(repo.proposalGroups().map((g) => g.tag)).toEqual(['ad-blocking'])
    expect(repo.heldTags()).toEqual(['ad-blocking'])
  })
})
