import { randomUUID } from 'node:crypto'
import type { JobKind, JobProgress, LinkStatus } from '@shared/types'
import { domainOf } from '@shared/url'
import type { Repo } from '../db/repo'
import {
  attemptLink,
  fetchMetadata,
  isRateLimitStatus,
  isTransientStatus,
  probeConnectivity,
  type LinkAttempt,
  type LinkCheckResult,
  type MetadataResult
} from './metadata'
import {
  Aborted,
  WouldWait,
  backoffMs,
  classifyNetworkError,
  Connectivity,
  HARD_FAILURES,
  HostScheduler,
  interleaveByHost,
  realClock,
  type Clock,
  type NetworkFailure
} from './net'

// ---------------------------------------------------------------- work queue

/**
 * Runs `worker` over `items` with bounded concurrency. Stops picking up new items once `signal` aborts.
 * A worker may return `{ deferMs }` to put its item back on the queue to be retried after that delay;
 * other items keep flowing in the meantime.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void | { deferMs: number }>,
  signal?: AbortSignal,
  clock: Clock = realClock
): Promise<void> {
  const pending = items.map((item) => ({ item, notBefore: 0 }))
  let active = 0

  const lane = async (): Promise<void> => {
    while (!signal?.aborted) {
      const now = clock.now()
      const index = pending.findIndex((entry) => entry.notBefore <= now)
      if (index < 0) {
        if (pending.length === 0 && active === 0) return
        // Everything left is waiting for its retry time, or in flight (and may still be deferred back to us).
        const soonest = pending.length ? Math.min(...pending.map((entry) => entry.notBefore)) - now : 50
        await clock.sleep(Math.max(10, Math.min(soonest, 1000)), signal)
        continue
      }
      const [entry] = pending.splice(index, 1)
      if (!entry) continue
      active++
      try {
        const result = await worker(entry.item)
        if (result && typeof result === 'object') pending.push({ item: entry.item, notBefore: clock.now() + result.deferMs })
      } finally {
        active--
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane))
}

// ------------------------------------------------------------------ settings

export interface JobDeps {
  fetchMetadata: (url: string) => Promise<MetadataResult>
  attemptLink: (url: string) => Promise<LinkAttempt>
  /** True if the internet is reachable. `recentlyWorking` are URLs that answered a moment ago. */
  probe: (recentlyWorking: string[], signal?: AbortSignal) => Promise<boolean>
  clock: Clock
  random: () => number
  /** Records notable events (rate limits, connectivity decisions) for later diagnosis. */
  log: (event: string, data?: Record<string, unknown>) => void
}

export interface JobTuning {
  concurrency: number
  perHost: number
  /** Minimum gap between requests to one site. */
  minGapMs: number
  /** Sites with at least `bigSiteThreshold` bookmarks to process get this larger gap instead. */
  bigSiteGapMs?: number
  bigSiteThreshold?: number
}

export interface JobOptions {
  /** Tries per bookmark before giving up on it for this run. */
  maxAttempts: number
  /** Waits longer than this put the bookmark back in the queue instead of holding a worker. */
  deferAboveMs: number
  httpBackoffMs: number
  networkBackoffMs: number
  linkCheck: JobTuning
  metadata: JobTuning
}

const defaultDeps: JobDeps = {
  fetchMetadata: (url) => fetchMetadata(url),
  attemptLink: (url) => attemptLink(url),
  probe: (recentlyWorking, signal) => probeConnectivity(recentlyWorking, { signal }),
  clock: realClock,
  random: Math.random,
  log: () => undefined
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  maxAttempts: 3,
  deferAboveMs: 10_000,
  httpBackoffMs: 3000,
  networkBackoffMs: 1500,
  // HEAD requests are light: 2 at a time per site, 0.4s apart, and 1.5s apart for sites with 100+ bookmarks.
  linkCheck: { concurrency: 8, perHost: 2, minGapMs: 400, bigSiteGapMs: 1500, bigSiteThreshold: 100 },
  // Full page downloads: 1 at a time per site, 0.8s apart, and 3s apart for sites with 100+ bookmarks
  // (a library with a thousand GitHub links would otherwise be rate limited almost at once).
  metadata: { concurrency: 5, perHost: 1, minGapMs: 800, bigSiteGapMs: 3000, bigSiteThreshold: 100 }
}

// --------------------------------------------------------------- retry engine

interface Task {
  id: number
  url: string
  host: string
  attempts: number
  failures: NetworkFailure[]
}

type Attempt<R> =
  | { kind: 'final'; value: R }
  | { kind: 'transient'; httpStatus: number | null; retryAfterMs: number | null; rateLimited: boolean }
  | { kind: 'network'; failure: NetworkFailure }

type Outcome<R> =
  | { kind: 'done'; value: R }
  | { kind: 'inconclusive'; httpStatus: number | null }
  | { kind: 'defer'; ms: number }
  | { kind: 'cancelled' }

interface RunContext {
  signal: AbortSignal
  scheduler: HostScheduler
  connectivity: Connectivity
  clock: Clock
  random: () => number
  options: JobOptions
  noteWorking: (url: string) => void
  log: (event: string, data?: Record<string, unknown>) => void
  /** Push a progress update to the UI right now (used when the status note changes). */
  notify: () => void
}

/**
 * Performs one bookmark's work, coping with the messy reality of the web:
 *  - waits its turn for the site (per-site concurrency and pacing) and while the site is cooling down;
 *  - retries temporary trouble (5xx, timeouts, resets, 429/503) with jittered backoff, honouring Retry-After;
 *  - puts the bookmark back in the queue when the wait is long, so other sites are not held up;
 *  - never blames the link for our own outage: network failures are checked against connectivity, and an
 *    outage pauses everything and does not use up attempts;
 *  - only reports "dead" (`deadResult`) when the failure is a hard one (no such host / refused), repeated on
 *    every attempt, and the internet is confirmed to be working.
 */
async function drive<R>(run: RunContext, task: Task, attemptFn: () => Promise<Attempt<R>>, deadResult: R | null): Promise<Outcome<R>> {
  const { signal, scheduler, connectivity, clock, random, options } = run
  for (;;) {
    if (signal.aborted) return { kind: 'cancelled' }
    const blocked = scheduler.blockedFor(task.host)
    if (blocked > options.deferAboveMs) return { kind: 'defer', ms: blocked }

    let attempt: Attempt<R>
    let cooldown = 0
    try {
      attempt = await scheduler.run(task.host, attemptFn, signal, {
        maxWaitMs: options.deferAboveMs,
        // Recorded before the slot is released, so requests already queued for this site see the cooldown.
        after: (result) => {
          if (result.kind === 'transient' && result.rateLimited) {
            cooldown = scheduler.rateLimited(task.host, result.retryAfterMs)
            run.log('rate-limited', { host: task.host, status: result.httpStatus, retryAfterMs: result.retryAfterMs, cooldownMs: cooldown })
            run.notify()
          }
        }
      })
    } catch (error) {
      if (error instanceof WouldWait) return { kind: 'defer', ms: error.ms }
      if (error instanceof Aborted || signal.aborted) return { kind: 'cancelled' }
      throw error
    }

    if (attempt.kind === 'final') {
      connectivity.recordResponse()
      scheduler.succeeded(task.host)
      run.noteWorking(task.url)
      return { kind: 'done', value: attempt.value }
    }

    if (attempt.kind === 'transient') {
      connectivity.recordResponse() // any answer proves we are online
      run.noteWorking(task.url)
      task.attempts++
      if (task.attempts >= options.maxAttempts) return { kind: 'inconclusive', httpStatus: attempt.httpStatus }
      const wait = Math.max(cooldown, attempt.retryAfterMs ?? 0, backoffMs(task.attempts, options.httpBackoffMs, random))
      if (wait > options.deferAboveMs) return { kind: 'defer', ms: wait }
      await clock.sleep(wait, signal)
      continue
    }

    // No HTTP answer at all: is it them, or is it us?
    connectivity.recordNetworkFailure(task.host + ':' + attempt.failure)
    const verdict = await connectivity.afterFailure(signal)
    if (verdict === 'cancelled') return { kind: 'cancelled' }
    if (verdict === 'recovered') continue // an outage was waited out; it does not count against this bookmark

    task.attempts++
    task.failures.push(attempt.failure)
    if (task.attempts >= options.maxAttempts) {
      const looksDead = deadResult !== null && task.failures.every((failure) => HARD_FAILURES.has(failure))
      if (!looksDead) return { kind: 'inconclusive', httpStatus: null }
      const online = await connectivity.confirmOnline(signal)
      if (online === 'cancelled') return { kind: 'cancelled' }
      if (online === 'recovered') {
        // The connection had dropped; those failures were not the site's fault. Start this bookmark afresh.
        task.attempts = 0
        task.failures = []
        continue
      }
      return { kind: 'done', value: deadResult as R }
    }
    await clock.sleep(backoffMs(task.attempts, options.networkBackoffMs, random), signal)
  }
}

// ---------------------------------------------------------------- job runner

interface ActiveJob {
  id: string
  kind: JobKind
  controller: AbortController
}

/** One background job at a time (link check, or filling in missing covers/icons). */
export class JobRunner {
  private active: ActiveJob | null = null
  private readonly deps: JobDeps
  private readonly options: JobOptions

  constructor(
    private readonly repo: Repo,
    private readonly emit: (progress: JobProgress) => void,
    deps: Partial<JobDeps> = {},
    options: Partial<JobOptions> = {}
  ) {
    this.deps = { ...defaultDeps, ...deps }
    if (!deps.probe) {
      this.deps.probe = (recentlyWorking, signal) =>
        probeConnectivity(recentlyWorking, { signal, onReport: (results) => this.deps.log('probe-report', { results }) })
    }
    this.options = { ...DEFAULT_JOB_OPTIONS, ...options }
  }

  get running(): boolean {
    return this.active !== null
  }

  /** Starts a job and returns its id, or null if one is already running. Completion is reported via `emit`. */
  start(kind: JobKind): string | null {
    if (this.active) return null
    const job: ActiveJob = { id: randomUUID(), kind, controller: new AbortController() }
    this.active = job
    void this.execute(job).finally(() => {
      if (this.active === job) this.active = null
    })
    return job.id
  }

  cancel(id: string): void {
    if (this.active?.id === id) this.active.controller.abort()
  }

  private async execute(job: ActiveJob): Promise<void> {
    const { clock, random } = this.deps
    const isLinkCheck = job.kind === 'check-links'
    const tuning = isLinkCheck ? this.options.linkCheck : this.options.metadata
    const signal = job.controller.signal

    // Spread each site's bookmarks over the whole run instead of visiting them back to back.
    const tasks: Task[] = interleaveByHost(this.repo.listForJob(isLinkCheck ? 'all' : 'missing-metadata'), random).map((item) => ({
      id: item.id,
      url: item.url,
      host: domainOf(item.url) || item.url,
      attempts: 0,
      failures: []
    }))

    const progress: JobProgress = { id: job.id, kind: job.kind, done: 0, total: tasks.length, finished: false, cancelled: false, paused: false }
    const counts: Record<LinkStatus, number> = { ok: 0, broken: 0, unknown: 0 }
    let updated = 0
    let failed = 0
    let lastEmit = 0
    const recentlyWorking: string[] = []

    const perHostCount = new Map<string, number>()
    for (const task of tasks) perHostCount.set(task.host, (perHostCount.get(task.host) ?? 0) + 1)
    const bigSiteAt = tuning.bigSiteThreshold ?? 100
    const scheduler = new HostScheduler({
      perHost: tuning.perHost,
      minGapMs: tuning.minGapMs,
      gapFor: (host) => ((perHostCount.get(host) ?? 0) >= bigSiteAt ? Math.max(tuning.minGapMs, tuning.bigSiteGapMs ?? 0) : tuning.minGapMs),
      clock,
      random
    })
    const log = this.deps.log
    const tick = (force = false): void => {
      const now = clock.now()
      if (!force && now - lastEmit < 250) return
      lastEmit = now
      progress.note = progress.paused
        ? 'No internet connection. Waiting for it to come back; the task will resume by itself.'
        : scheduler.coolingHosts() > 0
          ? 'Some sites asked us to slow down. Waiting before trying them again.'
          : undefined
      this.emit({ ...progress })
    }

    const connectivity = new Connectivity({
      probe: (probeSignal) => this.deps.probe([...recentlyWorking], probeSignal),
      clock,
      onChange: (offline) => {
        progress.paused = offline
        tick(true)
      },
      onDiagnostic: (event, data) => log(event, { job: job.kind, ...data })
    })

    const run: RunContext = {
      signal,
      scheduler,
      connectivity,
      clock,
      random,
      options: this.options,
      noteWorking: (url) => {
        const at = recentlyWorking.indexOf(url)
        if (at >= 0) recentlyWorking.splice(at, 1)
        recentlyWorking.unshift(url)
        recentlyWorking.length = Math.min(recentlyWorking.length, 3)
      },
      log,
      notify: () => tick(true)
    }

    const bigSites = [...perHostCount].filter(([, n]) => n >= bigSiteAt).map(([host, n]) => host + ':' + n)
    log('job-start', { job: job.kind, total: tasks.length, bigSites })
    tick(true)
    try {
      await runPool(
        tasks,
        tuning.concurrency,
        async (task) => {
          try {
            if (isLinkCheck) {
              const outcome = await drive<LinkCheckResult>(
                run,
                task,
                async () => {
                  const attempt = await this.deps.attemptLink(task.url)
                  return attempt.kind === 'final' ? { kind: 'final', value: attempt.result } : attempt
                },
                { status: 'broken', httpStatus: null }
              )
              if (outcome.kind === 'cancelled') return
              if (outcome.kind === 'defer') return { deferMs: outcome.ms }
              if (outcome.kind === 'done') {
                this.repo.setLinkStatus(task.id, outcome.value.status, outcome.value.httpStatus)
                counts[outcome.value.status]++
              } else {
                // Inconclusive: leave whatever we knew before rather than overwrite it with a guess.
                counts.unknown++
              }
            } else {
              const outcome = await drive(
                run,
                task,
                async (): Promise<Attempt<MetadataResult>> => {
                  let meta: MetadataResult
                  try {
                    meta = await this.deps.fetchMetadata(task.url)
                  } catch (error) {
                    return { kind: 'network', failure: classifyNetworkError(error) }
                  }
                  if (meta.status !== null && isTransientStatus(meta.status)) {
                    return { kind: 'transient', httpStatus: meta.status, retryAfterMs: meta.retryAfterMs, rateLimited: isRateLimitStatus(meta.status) }
                  }
                  return { kind: 'final', value: meta }
                },
                null
              )
              if (outcome.kind === 'cancelled') return
              if (outcome.kind === 'defer') return { deferMs: outcome.ms }
              if (outcome.kind === 'done' && outcome.value.status !== null && outcome.value.status < 400) {
                this.repo.applyMetadata(task.id, outcome.value)
                updated++
              } else {
                failed++ // unreachable, or an error page: nothing to learn (a later run tries again)
              }
            }
            progress.done++
            tick()
          } catch {
            // One bad site must not abort the whole run.
            failed++
            progress.done++
            tick()
          }
        },
        signal,
        clock
      )
    } finally {
      progress.finished = true
      progress.cancelled = signal.aborted
      progress.paused = false
      progress.summary = isLinkCheck
        ? `${counts.broken} broken, ${counts.ok} working, ${counts.unknown} inconclusive`
        : `${updated} bookmarks refreshed${failed > 0 ? `, ${failed} could not be fetched (run it again later)` : ''}`
      log('job-end', { job: job.kind, done: progress.done, total: progress.total, cancelled: progress.cancelled, summary: progress.summary })
      tick(true)
    }
  }
}
