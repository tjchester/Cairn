import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobRunner, type JobDeps, type JobOptions } from '../src/main/services/jobs'
import type { LinkAttempt, MetadataResult } from '../src/main/services/metadata'
import type { JobProgress } from '../src/shared/types'
import { makeRepo } from './helpers'

// Everything runs on fake timers: minutes of waiting, backoff and outage recovery take milliseconds.

const OPTIONS: Partial<JobOptions> = {
  linkCheck: { concurrency: 4, perHost: 2, minGapMs: 0 },
  metadata: { concurrency: 4, perHost: 2, minGapMs: 0 }
}

const ok: LinkAttempt = { kind: 'final', result: { status: 'ok', httpStatus: 200 } }
const dns: LinkAttempt = { kind: 'network', failure: 'dns' }
const timeout: LinkAttempt = { kind: 'network', failure: 'timeout' }
const hostOf = (url: string) => new URL(url).hostname

function setup(deps: Partial<JobDeps>, options: Partial<JobOptions> = OPTIONS) {
  const repo = makeRepo()
  const events: JobProgress[] = []
  const runner = new JobRunner(repo, (e) => events.push(e), { random: () => 0.5, probe: async () => true, ...deps }, options)
  return { repo, events, runner }
}

async function finish(events: JobProgress[]): Promise<JobProgress> {
  for (let waited = 0; waited < 2_000_000 && !events.some((e) => e.finished); waited += 250) await vi.advanceTimersByTimeAsync(250)
  const last = events.at(-1) as JobProgress
  expect(last?.finished, 'job did not finish').toBe(true)
  return last
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('link-check job: basics', () => {
  it('records statuses, allows one job at a time and reports a summary', async () => {
    const { repo, events, runner } = setup({
      attemptLink: async (url) => (url.includes('bad') ? { kind: 'final', result: { status: 'broken', httpStatus: 404 } } : ok)
    })
    const good = repo.createBookmark({ url: 'https://good.example' })
    const bad = repo.createBookmark({ url: 'https://bad.example' })

    expect(runner.start('check-links')).toBeTruthy()
    expect(runner.start('check-links')).toBeNull()
    const last = await finish(events)

    expect(last).toMatchObject({ done: 2, total: 2, cancelled: false, summary: '1 broken, 1 working, 0 inconclusive' })
    expect(repo.getBookmark(good.id)?.status).toBe('ok')
    expect(repo.getBookmark(bad.id)).toMatchObject({ status: 'broken', httpStatus: 404 })
    expect(runner.running).toBe(false)
  })
})

describe('link-check job: your internet goes out', () => {
  it('never blames the links: pauses, waits for the connection, then finishes with everything working', async () => {
    let online = false
    const { repo, events, runner } = setup({
      attemptLink: async () => (online ? ok : dns), // offline, every lookup fails with "no such host"
      probe: async () => online
    })
    for (let i = 0; i < 6; i++) repo.createBookmark({ url: `https://site${i}.example/` })
    setTimeout(() => (online = true), 5 * 60_000) // "several minutes" without internet

    runner.start('check-links')
    const last = await finish(events)

    expect(last).toMatchObject({ done: 6, summary: '0 broken, 6 working, 0 inconclusive', paused: false })
    expect(repo.counts().broken).toBe(0)
    expect(repo.allActiveBookmarks().every((b) => b.status === 'ok')).toBe(true)

    const paused = events.filter((e) => e.paused)
    expect(paused.length).toBeGreaterThan(0)
    expect(paused[0]?.note).toMatch(/internet/i)
    // ...and the pause ended before the job did
    expect(events.findLastIndex((e) => e.paused)).toBeLessThan(events.length - 1)
  })

  it('records why it paused and resumed, so a surprising message can be investigated', async () => {
    let online = false
    const log = vi.fn()
    const { repo, events, runner } = setup({ attemptLink: async () => (online ? ok : dns), probe: async () => online, log })
    for (let i = 0; i < 4; i++) repo.createBookmark({ url: 'https://site' + i + '.example/' })
    setTimeout(() => (online = true), 90_000)
    runner.start('check-links')
    await finish(events)

    const names = log.mock.calls.map((c) => c[0])
    expect(names[0]).toBe('job-start')
    expect(names).toEqual(expect.arrayContaining(['probe-failed', 'outage-start', 'outage-end']))
    expect(names.at(-1)).toBe('job-end')
    const start = log.mock.calls.find((c) => c[0] === 'outage-start')?.[1]
    expect(start).toMatchObject({ job: 'check-links' })
    expect((start as { recentFailures: string[] }).recentFailures.every((f) => f.endsWith(':dns'))).toBe(true)
  })

  it('a single bookmark checked during an outage is retried afterwards instead of being marked broken', async () => {
    let online = false
    const { repo, events, runner } = setup({ attemptLink: async () => (online ? ok : dns), probe: async () => online })
    const b = repo.createBookmark({ url: 'https://lonely.example/' })
    setTimeout(() => (online = true), 60_000)

    runner.start('check-links')
    await finish(events)
    expect(repo.getBookmark(b.id)?.status).toBe('ok')
  })

  it('can be cancelled while waiting for the connection', async () => {
    const { repo, events, runner } = setup({ attemptLink: async () => dns, probe: async () => false })
    for (let i = 0; i < 3; i++) repo.createBookmark({ url: `https://site${i}.example/` })

    const id = runner.start('check-links') as string
    await vi.advanceTimersByTimeAsync(20_000)
    expect(events.some((e) => e.paused)).toBe(true)
    runner.cancel(id)
    const last = await finish(events)

    expect(last).toMatchObject({ cancelled: true, paused: false })
    expect(repo.counts().broken).toBe(0)
    expect(runner.running).toBe(false)
  })
})

describe('link-check job: sites that really are dead', () => {
  it('marks a domain that does not exist as broken after repeated, confirmed failures', async () => {
    const calls: string[] = []
    const { repo, events, runner } = setup({
      attemptLink: async (url) => (calls.push(hostOf(url)), url.includes('dead') ? dns : ok)
    })
    const dead = repo.createBookmark({ url: 'https://dead.example/' })
    for (const h of ['a', 'b', 'c']) repo.createBookmark({ url: `https://${h}.example/` })

    runner.start('check-links')
    const last = await finish(events)

    expect(repo.getBookmark(dead.id)).toMatchObject({ status: 'broken', httpStatus: null })
    expect(calls.filter((h) => h === 'dead.example')).toHaveLength(3) // three attempts, not one
    expect(last.summary).toBe('1 broken, 3 working, 0 inconclusive')
  })

  it('still reaches that verdict when the dead site is the only bookmark, because a probe proves we are online', async () => {
    const probe = vi.fn(async () => true)
    const { repo, events, runner } = setup({ attemptLink: async () => ({ kind: 'network', failure: 'refused' }), probe })
    const b = repo.createBookmark({ url: 'https://refused.example/' })

    runner.start('check-links')
    await finish(events)
    expect(repo.getBookmark(b.id)?.status).toBe('broken')
    expect(probe).toHaveBeenCalled()
  })

  it('does not call a link broken on timeouts, resets or mixed failures (inconclusive, previous status kept)', async () => {
    const script = [dns, timeout, dns]
    let n = 0
    const { repo, events, runner } = setup({ attemptLink: async () => script[n++ % script.length] as LinkAttempt })
    const fresh = repo.createBookmark({ url: 'https://flaky.example/' })
    const wasBroken = repo.createBookmark({ url: 'https://previously-broken.example/' })
    repo.setLinkStatus(wasBroken.id, 'broken', 404)
    n = 0

    runner.start('check-links')
    const last = await finish(events)

    expect(last.summary).toBe('0 broken, 0 working, 2 inconclusive')
    expect(repo.getBookmark(fresh.id)).toMatchObject({ status: 'unknown', lastCheckedAt: null })
    expect(repo.getBookmark(wasBroken.id)).toMatchObject({ status: 'broken', httpStatus: 404 }) // not overwritten by a guess
  })
})

describe('link-check job: retries', () => {
  it('retries temporary server errors with growing waits, then succeeds', async () => {
    const t0 = Date.now()
    const times: number[] = []
    const script: LinkAttempt[] = [
      { kind: 'transient', httpStatus: 500, retryAfterMs: null, rateLimited: false },
      { kind: 'transient', httpStatus: 502, retryAfterMs: null, rateLimited: false },
      ok
    ]
    const { repo, events, runner } = setup({ attemptLink: async () => (times.push(Date.now() - t0), script[times.length - 1] as LinkAttempt) })
    const b = repo.createBookmark({ url: 'https://wobbly.example/' })

    runner.start('check-links')
    await finish(events)

    expect(repo.getBookmark(b.id)?.status).toBe('ok')
    expect(times).toHaveLength(3)
    expect((times[1] as number) - (times[0] as number)).toBe(3000) // base backoff
    expect((times[2] as number) - (times[1] as number)).toBe(6000) // doubled
  })

  it('gives up after three tries as "inconclusive" (never "working", never "broken")', async () => {
    let calls = 0
    const { repo, events, runner } = setup({
      attemptLink: async () => (calls++, { kind: 'transient', httpStatus: 429, retryAfterMs: 1000, rateLimited: true })
    })
    const b = repo.createBookmark({ url: 'https://always-429.example/' })

    runner.start('check-links')
    const last = await finish(events)

    expect(calls).toBe(3)
    expect(last.summary).toBe('0 broken, 0 working, 1 inconclusive')
    expect(repo.getBookmark(b.id)).toMatchObject({ status: 'unknown', lastCheckedAt: null })
  })
})

describe('link-check job: being polite to busy sites', () => {
  it('holds a rate-limited site back for its Retry-After while every other site carries on', async () => {
    const t0 = Date.now()
    const log: { host: string; at: number }[] = []
    let firstGithub = true
    const { repo, events, runner } = setup(
      {
        attemptLink: async (url) => {
          const host = hostOf(url)
          log.push({ host, at: Date.now() - t0 })
          if (host === 'github.com' && firstGithub) {
            firstGithub = false
            return { kind: 'transient', httpStatus: 429, retryAfterMs: 20_000, rateLimited: true }
          }
          return ok
        }
      },
      { linkCheck: { concurrency: 4, perHost: 1, minGapMs: 0 } }
    )
    repo.createBookmark({ url: 'https://github.com/a/1' })
    repo.createBookmark({ url: 'https://github.com/a/2' })
    repo.createBookmark({ url: 'https://other.example/' })

    runner.start('check-links')
    const last = await finish(events)

    const github = log.filter((l) => l.host === 'github.com').map((l) => l.at)
    expect(github[0]).toBe(0)
    expect(github.slice(1).every((t) => t >= 20_000)).toBe(true) // nothing sent to GitHub while it said "wait"
    expect(log.find((l) => l.host === 'other.example')?.at).toBe(0) // unaffected
    expect(last.summary).toBe('0 broken, 3 working, 0 inconclusive')
    expect(events.some((e) => /slow down/i.test(e.note ?? ''))).toBe(true) // the UI is told why it is slow
  })

  it('starts big sites (many bookmarks to process) at a larger gap, without slowing small ones', async () => {
    const t0 = Date.now()
    const starts: Record<string, number[]> = {}
    const log = vi.fn()
    const { repo, events, runner } = setup(
      {
        attemptLink: async (url) => ((starts[hostOf(url)] ??= []).push(Date.now() - t0), ok),
        log
      },
      { linkCheck: { concurrency: 8, perHost: 8, minGapMs: 0, bigSiteGapMs: 2000, bigSiteThreshold: 3 } }
    )
    for (let i = 0; i < 4; i++) repo.createBookmark({ url: 'https://big.example/' + i })
    for (let i = 0; i < 2; i++) repo.createBookmark({ url: 'https://small.example/' + i })

    runner.start('check-links')
    await finish(events)

    const gaps = (host: string) => (starts[host] as number[]).slice(1).map((t, i) => t - ((starts[host] as number[])[i] as number))
    expect(gaps('big.example').every((g) => g >= 2000)).toBe(true)
    expect(gaps('small.example').every((g) => g === 0)).toBe(true)
    expect(log.mock.calls[0]).toEqual(['job-start', { job: 'check-links', total: 6, bigSites: ['big.example:4'] }])
  })

  it('spaces out requests to one site', async () => {
    const t0 = Date.now()
    const starts: number[] = []
    const { repo, events, runner } = setup(
      { attemptLink: async () => (starts.push(Date.now() - t0), ok) },
      { linkCheck: { concurrency: 4, perHost: 4, minGapMs: 500 } }
    )
    for (let i = 0; i < 4; i++) repo.createBookmark({ url: `https://one-site.example/page${i}` })

    runner.start('check-links')
    await finish(events)

    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number))
    expect(starts).toHaveLength(4)
    expect(gaps.every((g) => g >= 500)).toBe(true)
  })

  it('mixes sites instead of working through one site at a time', async () => {
    const order: string[] = []
    const { repo, events, runner } = setup(
      { attemptLink: async (url) => (order.push(hostOf(url)), ok) },
      { linkCheck: { concurrency: 1, perHost: 1, minGapMs: 0 } }
    )
    for (let i = 0; i < 6; i++) repo.createBookmark({ url: `https://a.example/${i}` })
    for (let i = 0; i < 6; i++) repo.createBookmark({ url: `https://b.example/${i}` })

    runner.start('check-links')
    await finish(events)

    expect(order).toHaveLength(12)
    expect(new Set(order.slice(0, 4)).size).toBe(2) // both sites show up right away, not "all of a, then all of b"
  })
})

describe('fetch-details job', () => {
  const meta = (over: Partial<MetadataResult> = {}): MetadataResult => ({
    title: 'Nice title',
    excerpt: 'About it',
    coverUrl: 'https://cdn.example/cover.png',
    faviconUrl: 'https://cdn.example/icon.png',
    finalUrl: 'https://x.example/',
    status: 200,
    retryAfterMs: null,
    ...over
  })
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })

  it('retries what is temporary, skips what is hopeless, and never records junk for error pages', async () => {
    const calls: Record<string, number> = {}
    const { repo, events, runner } = setup({
      fetchMetadata: async (url) => {
        const host = hostOf(url)
        calls[host] = (calls[host] ?? 0) + 1
        if (host === 'flaky.example') return calls[host] === 1 ? meta({ status: 503, title: '' }) : meta({ title: 'Recovered' })
        if (host === 'gone.example') return meta({ status: 404, title: '', coverUrl: null, faviconUrl: 'https://gone.example/favicon.ico' })
        if (host === 'down.example') throw reset()
        return meta()
      }
    })
    const good = repo.createBookmark({ url: 'https://good.example/' })
    const flaky = repo.createBookmark({ url: 'https://flaky.example/' })
    const gone = repo.createBookmark({ url: 'https://gone.example/' })
    const down = repo.createBookmark({ url: 'https://down.example/' })

    runner.start('fetch-metadata')
    const last = await finish(events)

    expect(repo.getBookmark(good.id)).toMatchObject({ title: 'Nice title', coverUrl: 'https://cdn.example/cover.png' })
    expect(repo.getBookmark(flaky.id)?.title).toBe('Recovered')
    expect(calls['flaky.example']).toBe(2) // retried once
    expect(repo.getBookmark(gone.id)).toMatchObject({ title: 'gone.example', faviconUrl: null }) // 404: nothing applied
    expect(repo.getBookmark(down.id)).toMatchObject({ title: 'down.example', coverUrl: null })
    expect(calls['down.example']).toBe(3) // tried three times, then left for a later run
    expect(last.summary).toBe('2 bookmarks refreshed, 1 returned an error page, 1 could not be reached (run it again later)')
    // "Missing" now means "never successfully fetched": only the unreachable site is asked again next time.
    expect(repo.getSignals(gone.id)).not.toBeNull()
    expect(repo.getSignals(down.id)).toBeNull()
    expect(repo.listForJob('missing-metadata').map((b) => b.id)).toEqual([down.id])
  })

  it('waits out an outage instead of failing everything', async () => {
    let online = false
    const { repo, events, runner } = setup({
      fetchMetadata: async () => {
        if (!online) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) })
        return meta()
      },
      probe: async () => online
    })
    for (let i = 0; i < 5; i++) repo.createBookmark({ url: `https://site${i}.example/` })
    setTimeout(() => (online = true), 4 * 60_000)

    runner.start('fetch-metadata')
    const last = await finish(events)

    expect(last.summary).toBe('5 bookmarks refreshed')
    expect(events.some((e) => e.paused)).toBe(true)
    expect(repo.allActiveBookmarks().every((b) => b.coverUrl !== null)).toBe(true)
  })
})
