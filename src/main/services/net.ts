import { domainOf } from '@shared/url'

// Building blocks for being a polite, resilient HTTP client when visiting many sites in bulk:
//   - spread requests so one site is not hit over and over        (interleaveByHost, HostScheduler)
//   - honour 429/503 "slow down" signals                           (parseRetryAfter, HostScheduler.cooldown)
//   - retry transient failures with jittered exponential backoff   (backoffMs)
//   - tell "this site is dead" apart from "my internet is down"    (classifyNetworkError, Connectivity)

// ------------------------------------------------------------------- time

export interface Clock {
  now(): number
  /** Resolves after `ms`, or earlier if `signal` aborts (it never rejects). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve()
      const onAbort = (): void => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export class Aborted extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AbortError'
  }
}

/** Thrown by HostScheduler.run when the site is held back for longer than the caller is willing to wait. */
export class WouldWait extends Error {
  constructor(readonly ms: number) {
    super(`Would have to wait ${ms}ms`)
    this.name = 'WouldWait'
  }
}

/** Exponential backoff with +/-25% jitter: attempt 1 waits ~base, attempt 2 ~2x base, and so on. */
export function backoffMs(attempt: number, baseMs: number, random: () => number = Math.random, capMs = 60_000): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exponential * (0.75 + random() * 0.5))
}

// ----------------------------------------------------------- Retry-After

export const MAX_RETRY_AFTER_MS = 5 * 60_000

/** Parses a `Retry-After` header (delay-seconds or an HTTP date) into milliseconds, capped at 5 minutes. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null
  const text = value.trim()
  let ms: number
  if (/^\d+$/.test(text)) ms = Number(text) * 1000
  else {
    const at = Date.parse(text)
    if (Number.isNaN(at)) return null
    ms = at - now
  }
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS))
}

// ----------------------------------------------------- error classification

export type NetworkFailure =
  | 'timeout' //     no answer in time
  | 'dns' //         the name does not exist (ENOTFOUND)
  | 'dns-temporary' // resolver trouble (EAI_AGAIN): says nothing about the site
  | 'refused' //     nothing listening (ECONNREFUSED)
  | 'reset' //       connection dropped mid-way
  | 'unreachable' // no route to the network/host
  | 'tls' //         certificate / handshake problem
  | 'other'

/** Failures that, once confirmed repeatable while online, mean the link really is dead. */
export const HARD_FAILURES: ReadonlySet<NetworkFailure> = new Set<NetworkFailure>(['dns', 'refused'])

function errorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 3) return []
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown[] }
  const codes: string[] = typeof e.code === 'string' ? [e.code] : []
  codes.push(...errorCodes(e.cause, depth + 1))
  for (const inner of e.errors ?? []) codes.push(...errorCodes(inner, depth + 1))
  return codes
}

export function classifyNetworkError(error: unknown): NetworkFailure {
  const name = (error as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  const codes = errorCodes(error)
  const has = (...wanted: string[]): boolean => codes.some((c) => wanted.includes(c))
  if (has('ENOTFOUND')) return 'dns'
  if (has('EAI_AGAIN')) return 'dns-temporary'
  if (has('ECONNREFUSED')) return 'refused'
  if (has('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT')) return 'timeout'
  if (has('ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED')) return 'reset'
  if (has('ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ENETRESET')) return 'unreachable'
  if (codes.some((c) => /^ERR_TLS|CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(c))) return 'tls'
  return 'other'
}

/** Short human-readable reason for a failed request, e.g. "dns (ENOTFOUND)" or "timeout". */
export function describeNetworkError(error: unknown): string {
  const kind = classifyNetworkError(error)
  const code = errorCodes(error)[0]
  return code ? kind + ' (' + code + ')' : kind
}

// -------------------------------------------------------------- ordering

/**
 * Reorders items so requests to the same site are spread out over the whole run instead of arriving in
 * a burst (imports keep a folder's links together, so insertion order would hammer one site).
 * Items from one site keep their relative order; sites are interleaved with a random offset.
 */
export function interleaveByHost<T extends { url: string }>(items: readonly T[], random: () => number = Math.random): T[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const host = domainOf(item.url) || item.url
    const group = groups.get(host)
    if (group) group.push(item)
    else groups.set(host, [item])
  }
  const keyed: { item: T; key: number }[] = []
  for (const group of groups.values()) {
    group.forEach((item, index) => keyed.push({ item, key: (index + random()) / group.length }))
  }
  keyed.sort((a, b) => a.key - b.key)
  return keyed.map((entry) => entry.item)
}

// ------------------------------------------------------------ per-host limits

export interface SchedulerOptions {
  /** Requests allowed in flight to one site at a time. */
  perHost: number
  /** Minimum time between request starts to one site (jittered). Doubles after a rate-limit signal. */
  minGapMs: number
  /** Per-site override of the base gap, e.g. a larger one for a site that has hundreds of bookmarks. */
  gapFor?: (host: string) => number
  maxGapMs?: number
  clock?: Clock
  random?: () => number
}

interface HostState {
  inFlight: number
  waiters: (() => void)[]
  nextStart: number
  blockedUntil: number
  /** Current gap between request starts (grows after rate limiting, relaxes back to the base). */
  gapMs: number
  baseGapMs: number
  strikes: number
}

/**
 * Limits concurrency and pacing per site, and holds a site back when it says "slow down".
 * Different sites never wait on each other.
 */
export class HostScheduler {
  private readonly hosts = new Map<string, HostState>()
  private readonly clock: Clock
  private readonly random: () => number
  private readonly maxGapMs: number

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? realClock
    this.random = options.random ?? Math.random
    this.maxGapMs = options.maxGapMs ?? 8000
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host)
    if (!s) {
      const base = Math.max(0, this.options.gapFor?.(host) ?? this.options.minGapMs)
      s = { inFlight: 0, waiters: [], nextStart: 0, blockedUntil: 0, gapMs: base, baseGapMs: base, strikes: 0 }
      this.hosts.set(host, s)
    }
    return s
  }

  /** How long the site is currently held back (0 when it is free to use). */
  blockedFor(host: string): number {
    return Math.max(0, this.state(host).blockedUntil - this.clock.now())
  }

  /** Number of sites that are currently cooling down after a rate-limit response. */
  coolingHosts(): number {
    const now = this.clock.now()
    let count = 0
    for (const s of this.hosts.values()) if (s.blockedUntil > now) count++
    return count
  }

  /**
   * Records a "slow down" response (429/503). Holds the site back for the server's Retry-After, or an
   * escalating 15s, 30s, 60s... (max 5 min) when it did not say, and widens the gap between requests.
   * Returns the cooldown that was applied.
   */
  rateLimited(host: string, retryAfterMs: number | null): number {
    const s = this.state(host)
    s.strikes++
    const escalating = Math.min(MAX_RETRY_AFTER_MS, 15_000 * 2 ** (s.strikes - 1))
    // Respect the server's own number when it gives one; otherwise back off progressively.
    const cooldown = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : escalating
    s.blockedUntil = Math.max(s.blockedUntil, this.clock.now() + cooldown)
    s.gapMs = Math.min(Math.max(this.maxGapMs, s.baseGapMs), s.gapMs * 2)
    return cooldown
  }

  /** A request to the site worked: relax the pacing back towards its normal gap. */
  succeeded(host: string): void {
    const s = this.state(host)
    s.strikes = 0
    s.gapMs = Math.max(s.baseGapMs, Math.round(s.gapMs * 0.75))
  }

  /**
   * Runs `fn` once the site has a free slot, is not cooling down, and the pacing gap has elapsed.
   *  - `after` sees the result *before* the slot is released, so a rate-limit recorded there is already in
   *    force when the next queued request for the same site wakes up (otherwise it would fire straight away).
   *  - `maxWaitMs`: if the site is held back for longer than this, throw WouldWait instead of holding the
   *    caller (and its worker) hostage, so it can do other work and come back later.
   */
  async run<T>(
    host: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    options: { after?: (result: T) => void; maxWaitMs?: number } = {}
  ): Promise<T> {
    const s = this.state(host)
    await this.acquire(s, signal)
    try {
      for (;;) {
        if (signal?.aborted) throw new Aborted()
        const now = this.clock.now()
        const wait = Math.max(s.blockedUntil - now, s.nextStart - now)
        if (wait <= 0) break
        if (options.maxWaitMs !== undefined && wait > options.maxWaitMs) throw new WouldWait(wait)
        await this.clock.sleep(wait, signal)
      }
      // Claim the next start time before yielding, so concurrent callers queue up behind us.
      s.nextStart = this.clock.now() + Math.round(s.gapMs * (0.75 + this.random() * 0.5))
      const result = await fn()
      options.after?.(result)
      return result
    } finally {
      this.release(s)
    }
  }

  private acquire(s: HostState, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Aborted())
    if (s.inFlight < this.options.perHost) {
      s.inFlight++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const at = s.waiters.indexOf(entry)
        if (at >= 0) s.waiters.splice(at, 1)
        reject(new Aborted())
      }
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort)
        s.inFlight++
        resolve()
      }
      s.waiters.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  private release(s: HostState): void {
    s.inFlight--
    s.waiters.shift()?.()
  }
}

// ---------------------------------------------------------- connectivity

export interface ConnectivityOptions {
  /** Resolves true if the internet is reachable (any HTTP response counts). */
  probe: (signal?: AbortSignal) => Promise<boolean>
  clock?: Clock
  /** Consecutive network failures before we check whether *we* are the problem. */
  streakThreshold?: number
  /** Evidence of a working connection (a recent response or probe) stays fresh for this long. */
  freshMs?: number
  /** Delays between probes while offline; the last value repeats. */
  retryDelaysMs?: number[]
  /** A failed probe is re-checked after this long before we believe it (one failure can be a fluke). */
  confirmDelayMs?: number
  onChange?: (offline: boolean) => void
  /** Explains decisions ("probe-failed", "outage-start", "outage-end") so surprises can be investigated. */
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void
}

export type Verdict = 'ok' | 'recovered' | 'cancelled'

/**
 * Distinguishes "that site is down" from "my internet is down".
 * Any HTTP response is proof we are online. A run of network-level failures triggers a probe; if the probe
 * fails, everything waits (probing with backoff) until the connection comes back.
 */
export class Connectivity {
  private streak = 0
  private lastOnlineAt = Number.NEGATIVE_INFINITY
  private outage: Promise<boolean> | null = null
  private readonly clock: Clock
  private readonly threshold: number
  private readonly freshMs: number
  private readonly delays: number[]
  private readonly confirmDelayMs: number
  /** The most recent network failures (site:kind), kept to explain an outage decision. */
  private recentFailures: string[] = []

  constructor(private readonly options: ConnectivityOptions) {
    this.clock = options.clock ?? realClock
    this.threshold = options.streakThreshold ?? 3
    this.freshMs = options.freshMs ?? 15_000
    this.delays = options.retryDelaysMs ?? [3000, 6000, 12_000, 30_000]
    this.confirmDelayMs = options.confirmDelayMs ?? 2000
  }

  get offline(): boolean {
    return this.outage !== null
  }

  /** The server answered (with any status): the network is fine. */
  recordResponse(): void {
    this.streak = 0
    this.lastOnlineAt = this.clock.now()
  }

  /** A request got no HTTP answer. `info` (e.g. "example.com:timeout") is kept for diagnostics. */
  recordNetworkFailure(info?: string): void {
    this.streak++
    if (info) {
      this.recentFailures.push(info)
      if (this.recentFailures.length > 8) this.recentFailures.shift()
    }
  }

  /** After a network-level failure: 'ok' = failure is specific to that site, 'recovered' = we waited out an outage. */
  async afterFailure(signal?: AbortSignal): Promise<Verdict> {
    if (this.outage) return this.joinOutage()
    if (this.streak < this.threshold || this.isFresh()) return 'ok'
    return this.verify(signal)
  }

  /** Positive confirmation that we are online, required before calling a link dead. */
  async confirmOnline(signal?: AbortSignal): Promise<Verdict> {
    if (this.outage) return this.joinOutage()
    if (this.isFresh()) return 'ok'
    return this.verify(signal)
  }

  private isFresh(): boolean {
    return this.clock.now() - this.lastOnlineAt < this.freshMs
  }

  private async joinOutage(): Promise<Verdict> {
    return (await this.outage) ? 'recovered' : 'cancelled'
  }

  private async verify(signal?: AbortSignal): Promise<Verdict> {
    if (await this.options.probe(signal)) {
      this.recordResponse()
      return 'ok'
    }
    if (signal?.aborted) return 'cancelled'
    if (this.outage) return this.joinOutage()

    // One failed probe can be a fluke (a target that resets HEAD requests, a slow moment). Look again shortly
    // before telling the user their internet is down.
    this.options.onDiagnostic?.('probe-failed', { attempt: 1, recentFailures: [...this.recentFailures] })
    await this.clock.sleep(this.confirmDelayMs, signal)
    if (signal?.aborted) return 'cancelled'
    if (this.outage) return this.joinOutage()
    if (await this.options.probe(signal)) {
      this.recordResponse()
      this.options.onDiagnostic?.('probe-recovered', { attempt: 2 })
      return 'ok'
    }
    if (signal?.aborted) return 'cancelled'

    if (!this.outage) {
      const startedAt = this.clock.now()
      this.options.onDiagnostic?.('outage-start', { streak: this.streak, recentFailures: [...this.recentFailures] })
      this.options.onChange?.(true)
      this.outage = this.waitForNetwork(signal).finally(() => {
        this.outage = null
        this.options.onDiagnostic?.('outage-end', { seconds: Math.round((this.clock.now() - startedAt) / 1000) })
        this.options.onChange?.(false)
      })
    }
    return this.joinOutage()
  }

  private async waitForNetwork(signal?: AbortSignal): Promise<boolean> {
    for (let i = 0; ; i++) {
      await this.clock.sleep(this.delays[Math.min(i, this.delays.length - 1)] as number, signal)
      if (signal?.aborted) return false
      if (await this.options.probe(signal)) {
        this.recordResponse()
        return true
      }
    }
  }
}
