import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Aborted,
  backoffMs,
  classifyNetworkError,
  Connectivity,
  describeNetworkError,
  HARD_FAILURES,
  HostScheduler,
  interleaveByHost,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  realClock,
  WouldWait
} from '../src/main/services/net'

const sleepy = (ms: number) => realClock.sleep(ms)

describe('backoffMs', () => {
  it('doubles each attempt, with +/-25% jitter, up to a cap', () => {
    expect(backoffMs(1, 1000, () => 0.5)).toBe(1000)
    expect(backoffMs(2, 1000, () => 0.5)).toBe(2000)
    expect(backoffMs(3, 1000, () => 0.5)).toBe(4000)
    expect(backoffMs(1, 1000, () => 0)).toBe(750)
    expect(backoffMs(1, 1000, () => 0.9999)).toBe(1250)
    expect(backoffMs(20, 1000, () => 0.5, 60_000)).toBe(60_000)
  })
})

describe('parseRetryAfter', () => {
  it('understands delay-seconds and HTTP dates, caps long waits, ignores nonsense', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('30', now)).toBe(30_000)
    expect(parseRetryAfter(' 0 ', now)).toBe(0)
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60_000)
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('999999', now)).toBe(MAX_RETRY_AFTER_MS)
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter('', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
  })
})

describe('classifyNetworkError', () => {
  const withCause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

  it('recognises the common failure modes, including nested causes', () => {
    expect(classifyNetworkError(withCause('ENOTFOUND'))).toBe('dns')
    expect(classifyNetworkError(withCause('EAI_AGAIN'))).toBe('dns-temporary')
    expect(classifyNetworkError(withCause('ECONNREFUSED'))).toBe('refused')
    expect(classifyNetworkError(withCause('ECONNRESET'))).toBe('reset')
    expect(classifyNetworkError(withCause('UND_ERR_SOCKET'))).toBe('reset')
    expect(classifyNetworkError(withCause('UND_ERR_CONNECT_TIMEOUT'))).toBe('timeout')
    expect(classifyNetworkError(withCause('ENETUNREACH'))).toBe('unreachable')
    expect(classifyNetworkError(withCause('CERT_HAS_EXPIRED'))).toBe('tls')
    expect(classifyNetworkError(withCause('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls')
    expect(classifyNetworkError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(classifyNetworkError(new Error('who knows'))).toBe('other')
    expect(classifyNetworkError(undefined)).toBe('other')
  })

  it("understands Chromium's wording, which the app's own network stack reports", () => {
    // Electron reports failures as a net::ERR_... message with no code, e.g. what a dead host looks like.
    const chromium = (message: string) => new Error(message)
    expect(classifyNetworkError(chromium('net::ERR_NAME_NOT_RESOLVED'))).toBe('dns')
    expect(classifyNetworkError(chromium('net::ERR_DNS_TIMED_OUT'))).toBe('dns-temporary')
    expect(classifyNetworkError(chromium('net::ERR_CONNECTION_REFUSED'))).toBe('refused')
    expect(classifyNetworkError(chromium('net::ERR_CONNECTION_TIMED_OUT'))).toBe('timeout')
    expect(classifyNetworkError(chromium('net::ERR_CONNECTION_RESET'))).toBe('reset')
    expect(classifyNetworkError(chromium('net::ERR_EMPTY_RESPONSE'))).toBe('reset')
    expect(classifyNetworkError(chromium('net::ERR_INTERNET_DISCONNECTED'))).toBe('unreachable')
    expect(classifyNetworkError(chromium('net::ERR_CERT_DATE_INVALID'))).toBe('tls')
    expect(classifyNetworkError(chromium('net::ERR_SSL_PROTOCOL_ERROR'))).toBe('tls')
    expect(classifyNetworkError(chromium('net::ERR_UNSAFE_PORT'))).toBe('other') // Chromium refuses some ports outright
    expect(describeNetworkError(chromium('net::ERR_NAME_NOT_RESOLVED'))).toBe('dns (ERR_NAME_NOT_RESOLVED)')

    // Only "dns" and "refused" ever condemn a link, so Chromium's wording must not widen that.
    for (const message of ['net::ERR_CERT_DATE_INVALID', 'net::ERR_CONNECTION_TIMED_OUT', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_BLOCKED_BY_CLIENT']) {
      expect(HARD_FAILURES.has(classifyNetworkError(chromium(message))), message).toBe(false)
    }
  })

  it('looks inside AggregateError (multiple addresses tried)', () => {
    const aggregate = Object.assign(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' })]), {})
    expect(classifyNetworkError(Object.assign(new TypeError('fetch failed'), { cause: aggregate }))).toBe('refused')
  })
})

describe('interleaveByHost', () => {
  const seeded = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const item = (host: string, n: number) => ({ url: `https://${host}/${n}`, host, n })

  it('returns every item exactly once and keeps each site in its original order', () => {
    const input = [...Array.from({ length: 30 }, (_, i) => item('a.example', i)), ...Array.from({ length: 10 }, (_, i) => item('b.example', i))]
    const out = interleaveByHost(input, seeded(1))
    expect(out).toHaveLength(40)
    expect(new Set(out).size).toBe(40)
    for (const host of ['a.example', 'b.example']) {
      const order = out.filter((x) => x.host === host).map((x) => x.n)
      expect(order).toEqual([...order].sort((x, y) => x - y))
    }
  })

  it('spreads a dominant site across the whole run instead of front-loading it', () => {
    const input = [...Array.from({ length: 100 }, (_, i) => item('github.com', i)), ...Array.from({ length: 100 }, (_, i) => item(`site${i}.example`, 0))]
    const out = interleaveByHost(input, seeded(7))
    const firstHalf = out.slice(0, 100).filter((x) => x.host === 'github.com').length
    expect(firstHalf).toBeGreaterThan(35)
    expect(firstHalf).toBeLessThan(65)
    // ...and only short runs of the same site (unspread, there would be a run of 100)
    let longest = 0
    let run = 0
    let last = ''
    for (const x of out.slice(0, 150)) {
      run = x.host === last ? run + 1 : 1
      last = x.host
      longest = Math.max(longest, run)
    }
    expect(longest).toBeLessThanOrEqual(10)
  })

  it('treats www. and the bare domain as one site, and is stable for the same random source', () => {
    const input = [item('www.x.example', 1), item('x.example', 2), item('y.example', 3)]
    expect(interleaveByHost(input, seeded(3))).toEqual(interleaveByHost(input, seeded(3)))
    expect(interleaveByHost([], seeded(1))).toEqual([])
  })
})

describe('HostScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const settle = () => vi.runAllTimersAsync()

  it('limits concurrent requests per site but not across sites', async () => {
    const s = new HostScheduler({ perHost: 2, minGapMs: 0, random: () => 0.5 })
    let running = 0
    let peak = 0
    const work = async () => {
      running++
      peak = Math.max(peak, running)
      await sleepy(100)
      running--
    }
    const same = Array.from({ length: 6 }, () => s.run('a.example', work))
    await settle()
    await Promise.all(same)
    expect(peak).toBe(2)

    peak = 0
    const different = ['a', 'b', 'c', 'd'].map((h) => s.run(`${h}.example`, work))
    await settle()
    await Promise.all(different)
    expect(peak).toBe(4)
  })

  it('spaces out request starts to the same site', async () => {
    const s = new HostScheduler({ perHost: 5, minGapMs: 500, random: () => 0.5 })
    const starts: number[] = []
    const jobs = Array.from({ length: 4 }, () => s.run('a.example', async () => void starts.push(Date.now())))
    await settle()
    await Promise.all(jobs)
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] as number))
    expect(gaps.every((g) => g >= 500)).toBe(true)
  })

  it('holds a site back for its Retry-After without delaying other sites', async () => {
    const s = new HostScheduler({ perHost: 2, minGapMs: 0, random: () => 0.5 })
    const t0 = Date.now()
    expect(s.rateLimited('a.example', 20_000)).toBe(20_000)
    expect(s.blockedFor('a.example')).toBe(20_000)
    expect(s.blockedFor('b.example')).toBe(0)
    expect(s.coolingHosts()).toBe(1)

    let aStart = -1
    let bStart = -1
    const a = s.run('a.example', async () => void (aStart = Date.now() - t0))
    const b = s.run('b.example', async () => void (bStart = Date.now() - t0))
    await settle()
    await Promise.all([a, b])
    expect(bStart).toBe(0)
    expect(aStart).toBeGreaterThanOrEqual(20_000)
    expect(s.coolingHosts()).toBe(0)
  })

  it('escalates the cooldown when the server gives no Retry-After, and relaxes after a success', () => {
    const s = new HostScheduler({ perHost: 1, minGapMs: 0 })
    expect(s.rateLimited('a', null)).toBe(15_000)
    expect(s.rateLimited('a', null)).toBe(30_000)
    expect(s.rateLimited('a', null)).toBe(60_000)
    s.succeeded('a')
    expect(s.rateLimited('a', null)).toBe(15_000)
    expect(s.rateLimited('a', 0)).toBeGreaterThan(0) // "Retry-After: 0" must not mean "hammer it"
  })

  it('widens the gap between requests to a site that rate-limited us', async () => {
    const s = new HostScheduler({ perHost: 1, minGapMs: 500, random: () => 0.5 })
    s.rateLimited('a', 1000) // gap 500 -> 1000
    const starts: number[] = []
    const jobs = [1, 2].map(() => s.run('a', async () => void starts.push(Date.now())))
    await settle()
    await Promise.all(jobs)
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(1000)
  })

  it('applies a rate limit before the next queued request for the site wakes, and lets it step aside', async () => {
    const s = new HostScheduler({ perHost: 1, minGapMs: 0, random: () => 0.5 })
    const ran: string[] = []
    const first = s.run('a', async () => (ran.push('first'), sleepy(10)), undefined, { after: () => void s.rateLimited('a', 60_000) })
    const second = s
      .run('a', async () => void ran.push('second'), undefined, { maxWaitMs: 10_000 })
      .then(() => 'ran', (error) => (error instanceof WouldWait ? `would wait ${error.ms >= 59_000}` : 'other'))
    await settle()
    await first
    expect(await second).toBe('would wait true')
    expect(ran).toEqual(['first']) // the queued request never went out
  })

  it('uses a larger base gap for big sites and relaxes back to it (not below it) after rate limiting', async () => {
    const gapFor = (host: string) => (host === 'big.example' ? 2000 : 100)
    const s = new HostScheduler({ perHost: 5, minGapMs: 100, gapFor, random: () => 0.5 })
    const spacing = async (host: string, runs = 3) => {
      const starts: number[] = []
      const jobs = Array.from({ length: runs }, () => s.run(host, async () => void starts.push(Date.now())))
      await settle()
      await Promise.all(jobs)
      return starts.slice(1).map((t, i) => t - (starts[i] as number))
    }
    expect((await spacing('big.example')).every((g) => g === 2000)).toBe(true)
    expect((await spacing('small.example')).every((g) => g === 100)).toBe(true)

    s.rateLimited('big.example', 1000) // widens the gap...
    for (let i = 0; i < 12; i++) s.succeeded('big.example') // ...and successes bring it back to 2000, no lower
    expect((await spacing('big.example')).every((g) => g === 2000)).toBe(true)
  })

  it('stops waiting when aborted', async () => {
    const s = new HostScheduler({ perHost: 1, minGapMs: 0 })
    const controller = new AbortController()
    let firstFinished = false
    const first = s.run('a', async () => (await sleepy(1000), (firstFinished = true)), controller.signal)
    await vi.advanceTimersByTimeAsync(0) // the first request is now in flight and holds the only slot
    const second = s.run('a', async () => 'never', controller.signal).then(
      () => 'ran',
      (error) => (error instanceof Aborted ? 'aborted' : 'other')
    )
    controller.abort()
    await settle()
    await first
    expect(await second).toBe('aborted')
    expect(firstFinished).toBe(true) // a request already in flight is left to finish
  })
})

describe('Connectivity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does nothing about isolated failures: one dead site is not an outage', async () => {
    const probe = vi.fn(async () => true)
    const c = new Connectivity({ probe })
    c.recordNetworkFailure()
    expect(await c.afterFailure()).toBe('ok')
    c.recordNetworkFailure()
    expect(await c.afterFailure()).toBe('ok')
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes after a streak of failures, concludes "online", and does not re-probe while that evidence is fresh', async () => {
    const probe = vi.fn(async () => true)
    const c = new Connectivity({ probe, freshMs: 15_000 })
    for (let i = 0; i < 3; i++) c.recordNetworkFailure()
    expect(await c.afterFailure()).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) c.recordNetworkFailure()
    expect(await c.afterFailure()).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(16_000)
    for (let i = 0; i < 3; i++) c.recordNetworkFailure()
    await c.afterFailure()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('a successful response resets the streak and counts as proof of a working connection', async () => {
    const probe = vi.fn(async () => true)
    const c = new Connectivity({ probe })
    c.recordNetworkFailure()
    c.recordNetworkFailure()
    c.recordResponse()
    c.recordNetworkFailure()
    expect(await c.afterFailure()).toBe('ok')
    expect(await c.confirmOnline()).toBe('ok') // fresh evidence: no probe needed
    expect(probe).not.toHaveBeenCalled()
  })

  it('waits out an outage with backed-off probes and lets every caller share it', async () => {
    let online = false
    const probe = vi.fn(async () => online)
    const changes: boolean[] = []
    const c = new Connectivity({ probe, onChange: (offline) => changes.push(offline), retryDelaysMs: [1000, 2000, 4000], confirmDelayMs: 100 })
    for (let i = 0; i < 3; i++) c.recordNetworkFailure()

    const verdicts = [c.afterFailure(), c.afterFailure(), c.confirmOnline()]
    await vi.advanceTimersByTimeAsync(500)
    expect(c.offline).toBe(true)
    setTimeout(() => (online = true), 6000)
    await vi.advanceTimersByTimeAsync(20_000)

    expect(await Promise.all(verdicts)).toEqual(['recovered', 'recovered', 'recovered'])
    expect(c.offline).toBe(false)
    expect(changes).toEqual([true, false])
    // initial probes (concurrent callers) + backed-off retries at ~1s, 3s, 7s - not one per caller per tick
    expect(probe.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('one failed probe is not an outage: it looks again before believing it', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const changes: boolean[] = []
    const events: string[] = []
    const c = new Connectivity({ probe, confirmDelayMs: 2000, onChange: (o) => changes.push(o), onDiagnostic: (e) => events.push(e) })
    for (let i = 0; i < 3; i++) c.recordNetworkFailure()
    const verdict = c.afterFailure()
    await vi.advanceTimersByTimeAsync(2500)
    expect(await verdict).toBe('ok')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(changes).toEqual([]) // the user never sees "no internet"
    expect(events).toEqual(['probe-failed', 'probe-recovered'])
  })

  it('two failed probes in a row declare an outage, and record what led to it', async () => {
    let online = false
    const events: { event: string; data: Record<string, unknown> }[] = []
    const c = new Connectivity({
      probe: async () => online,
      confirmDelayMs: 1000,
      retryDelaysMs: [5000],
      onDiagnostic: (event, data) => events.push({ event, data })
    })
    c.recordNetworkFailure('a.example:dns')
    c.recordNetworkFailure('b.example:timeout')
    c.recordNetworkFailure('c.example:reset')
    const verdict = c.afterFailure()
    await vi.advanceTimersByTimeAsync(1500)
    expect(c.offline).toBe(true)
    online = true
    await vi.advanceTimersByTimeAsync(6000)
    expect(await verdict).toBe('recovered')
    expect(events.map((e) => e.event)).toEqual(['probe-failed', 'outage-start', 'outage-end'])
    expect(events[1]?.data).toMatchObject({ streak: 3, recentFailures: ['a.example:dns', 'b.example:timeout', 'c.example:reset'] })
    expect(events[2]?.data.seconds).toBeGreaterThanOrEqual(5)
  })

  it('is cancelled cleanly when the job is aborted mid-outage', async () => {
    const controller = new AbortController()
    const c = new Connectivity({ probe: async () => false, retryDelaysMs: [1000], confirmDelayMs: 100 })
    for (let i = 0; i < 3; i++) c.recordNetworkFailure()
    const verdict = c.afterFailure(controller.signal)
    await vi.advanceTimersByTimeAsync(3500)
    expect(c.offline).toBe(true)
    controller.abort()
    await vi.advanceTimersByTimeAsync(1)
    expect(await verdict).toBe('cancelled')
    expect(c.offline).toBe(false)
  })
})
