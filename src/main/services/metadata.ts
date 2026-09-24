import { parse } from 'node-html-parser'
import type { LinkStatus, PageMetadata, PageSignals } from '@shared/types'
import { coerceUrl, isHttpUrl } from '@shared/url'
import { classifyNetworkError, describeNetworkError, parseRetryAfter, type NetworkFailure } from './net'

const MAX_BYTES = 512 * 1024
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Cairn/0.1'

type FetchLike = typeof fetch

export interface FetchOptions {
  timeoutMs?: number
  fetchImpl?: FetchLike
}

let networkFetch: FetchLike | null = null

/**
 * Sends page lookups through the app's own network stack instead of Node's. The main process hands in Chromium's
 * (via Electron) at startup: sites behind bot protection answer it as they answer a browser, while Node's fetch is
 * turned away with a challenge page (an HTTP 403 that looks like a dead link). Tests leave it unset.
 */
export function useNetworkStack(fn: FetchLike): void {
  networkFetch = fn
}

const appFetch = (): FetchLike => networkFetch ?? fetch

/**
 * A reply may only carry a status between 200 and 599, and building one outside that range throws inside the network
 * stack (the request then never finishes). Some sites answer bots with 999 — LinkedIn is the well-known one — so the
 * main process brings such a status into range as it arrives and puts the real number in this header.
 */
export const ORIGINAL_STATUS_HEADER = 'x-cairn-original-status'

/** The status the site really sent. */
export function statusOf(res: { status: number; headers: { get(name: string): string | null } }): number {
  const original = Number(res.headers.get(ORIGINAL_STATUS_HEADER))
  return Number.isInteger(original) && original > 0 ? original : res.status
}

const clean = (value: string | undefined | null, max: number): string =>
  (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function resolveHttp(value: string | undefined | null, base: string): string | null {
  if (!value) return null
  try {
    const abs = new URL(value.trim(), base).href
    return isHttpUrl(abs) ? abs : null
  } catch {
    return null
  }
}

/** "Fetched, but nothing to learn": recorded for pages that answered without useful content (errors, images, PDFs). */
export const EMPTY_SIGNALS: PageSignals = { keywords: [], ogType: null, siteName: null, lang: null, section: null, text: '' }

const MAX_SIGNAL_TEXT = 2000
const MAX_KEYWORDS = 20

function splitKeywords(value: string): string[] {
  return value
    .split(/[,;|]/)
    .map((k) => clean(k, 40))
    .filter((k) => k.length > 1)
}

/** Keywords and section from schema.org JSON-LD blocks (best effort; malformed JSON is ignored). */
function jsonLdSignals(root: ReturnType<typeof parse>): { keywords: string[]; section: string | null } {
  const found = { keywords: [] as string[], section: null as string | null }
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) walk(item, depth + 1)
      return
    }
    const obj = value as Record<string, unknown>
    const kw = obj['keywords']
    if (typeof kw === 'string') found.keywords.push(...splitKeywords(kw))
    else if (Array.isArray(kw)) for (const k of kw) if (typeof k === 'string') found.keywords.push(clean(k, 40))
    const section = obj['articleSection']
    if (!found.section && typeof section === 'string') found.section = clean(section, 40)
    else if (!found.section && Array.isArray(section) && typeof section[0] === 'string') found.section = clean(section[0], 40)
    walk(obj['@graph'], depth + 1)
  }
  for (const node of root.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = node.rawText
    if (!raw || raw.length > 200_000) continue
    try {
      walk(JSON.parse(raw), 0)
    } catch {
      // not valid JSON: ignore
    }
  }
  return found
}

/** The first ~2000 characters of real paragraph text (short fragments such as menus and captions are skipped). */
function paragraphText(root: ReturnType<typeof parse>): string {
  const parts: string[] = []
  let total = 0
  for (const p of root.querySelectorAll('p')) {
    const text = clean(p.text, 600)
    if (text.length < 60) continue
    parts.push(text)
    total += text.length + 1
    if (total >= MAX_SIGNAL_TEXT) break
  }
  return parts.join(' ').slice(0, MAX_SIGNAL_TEXT)
}

function extractSignals(root: ReturnType<typeof parse>, meta: Map<string, string>): PageSignals {
  const keywords: string[] = []
  const seen = new Set<string>()
  const add = (k: string): void => {
    const key = k.toLowerCase()
    if (k && !seen.has(key) && keywords.length < MAX_KEYWORDS) {
      seen.add(key)
      keywords.push(k)
    }
  }
  // Explicit per-article tags are the most reliable, then JSON-LD, then the old-style keywords meta tag.
  for (const node of root.querySelectorAll('meta')) {
    const key = (node.getAttribute('property') ?? node.getAttribute('name') ?? '').toLowerCase()
    if (key === 'article:tag') add(clean(node.getAttribute('content'), 40))
  }
  const ld = jsonLdSignals(root)
  for (const k of ld.keywords) add(k)
  for (const k of splitKeywords(meta.get('keywords') ?? '')) add(k)

  const lang = clean(root.querySelector('html')?.getAttribute('lang'), 12).toLowerCase().split(/[-_]/)[0] ?? ''
  return {
    keywords,
    ogType: clean(meta.get('og:type'), 40).toLowerCase() || null,
    siteName: clean(meta.get('og:site_name'), 60) || null,
    lang: /^[a-z]{2,3}$/.test(lang) ? lang : null,
    section: clean(meta.get('article:section'), 40) || ld.section || null,
    text: paragraphText(root)
  }
}

/** Pure HTML -> metadata extraction (exported for tests). */
export function parseMetadata(html: string, baseUrl: string): Omit<PageMetadata, 'status' | 'finalUrl'> {
  const root = parse(html)

  const meta = new Map<string, string>()
  for (const node of root.querySelectorAll('meta')) {
    const key = (node.getAttribute('property') ?? node.getAttribute('name') ?? '').toLowerCase()
    const content = node.getAttribute('content')
    if (key && content && !meta.has(key)) meta.set(key, content)
  }

  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? root.querySelector('title')?.text, 300)
  const excerpt = clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 500)
  const coverUrl = resolveHttp(
    meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image') ?? meta.get('twitter:image:src'),
    baseUrl
  )

  let favicon: string | null = null
  let touchIcon: string | null = null
  for (const link of root.querySelectorAll('link')) {
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    const href = resolveHttp(link.getAttribute('href'), baseUrl)
    if (!href) continue
    if (rels.includes('icon') && !favicon) favicon = href
    else if (rels.includes('apple-touch-icon') && !touchIcon) touchIcon = href
  }

  let fallback: string | null = null
  try {
    fallback = new URL('/favicon.ico', baseUrl).href
  } catch {
    // ignore
  }
  return { title, excerpt, coverUrl, faviconUrl: favicon ?? touchIcon ?? fallback, signals: extractSignals(root, meta) }
}

function sniffCharset(contentType: string, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader
  const ascii = new TextDecoder('latin1').decode(head.subarray(0, 2048))
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii)?.[1] ?? 'utf-8'
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = sniffCharset(contentType, bytes)
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (received < limit) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
  }
  await reader.cancel().catch(() => undefined)
  const out = new Uint8Array(Math.min(received, limit))
  let offset = 0
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, out.length - offset))
    out.set(slice, offset)
    offset += slice.length
  }
  return out
}

function requestInit(method: string, timeoutMs: number): RequestInit {
  return {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.8'
    }
  }
}

/** Page details plus the server's Retry-After hint (null when it sent none). */
export interface MetadataResult extends PageMetadata {
  retryAfterMs: number | null
}

/** One attempt, no retries: callers that fetch in bulk add retrying and pacing on top (see jobs.ts). */
export async function fetchMetadata(url: string, options: FetchOptions = {}): Promise<MetadataResult> {
  const target = coerceUrl(url)
  const doFetch = options.fetchImpl ?? appFetch()
  const res = await doFetch(target, requestInit('GET', options.timeoutMs ?? 12_000))
  const finalUrl = res.url || target
  const contentType = res.headers.get('content-type') ?? ''
  const fallbackIcon = new URL('/favicon.ico', finalUrl).href
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
  const status = statusOf(res)
  const base = { finalUrl, status, retryAfterMs }

  if (status >= 400) {
    await res.body?.cancel().catch(() => undefined)
    return { title: '', excerpt: '', coverUrl: null, faviconUrl: fallbackIcon, ...base }
  }
  if (/^image\//i.test(contentType)) {
    await res.body?.cancel().catch(() => undefined)
    const name = decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? '')
    return { title: clean(name, 300), excerpt: '', coverUrl: finalUrl, faviconUrl: fallbackIcon, ...base }
  }
  if (contentType && !/html|xml/i.test(contentType)) {
    await res.body?.cancel().catch(() => undefined)
    const name = decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? '')
    return { title: clean(name, 300), excerpt: '', coverUrl: null, faviconUrl: fallbackIcon, ...base }
  }

  const bytes = await readLimited(res, MAX_BYTES)
  const parsed = parseMetadata(decode(bytes, contentType), finalUrl)
  return { ...parsed, ...base }
}

// ------------------------------------------------------------------ link check

export interface LinkCheckResult {
  status: LinkStatus
  httpStatus: number | null
}

/** What one attempt at checking a link found. Deciding what to do about it is the caller's job. */
export type LinkAttempt =
  | { kind: 'final'; result: LinkCheckResult }
  /** The server answered but is overloaded or rate limiting us: worth retrying later. */
  | { kind: 'transient'; httpStatus: number; retryAfterMs: number | null; rateLimited: boolean }
  /** No HTTP answer at all. Whether that means "dead link" or "my internet is down" is decided by the caller. */
  | { kind: 'network'; failure: NetworkFailure }

/** Answers that mean "the server is there but won't talk to a bot": the page exists, so not a broken link. */
const RESTRICTED = new Set([401, 403, 405, 406, 451, 999])

/** 429 and 503 are explicit "slow down" signals; other 5xx are usually temporary faults. */
export const isRateLimitStatus = (code: number): boolean => code === 429 || code === 503
// Only real server errors are worth trying again: a made-up status above 599 (LinkedIn's 999) means "not for bots",
// which no amount of retrying will change.
export const isTransientStatus = (code: number): boolean => code === 429 || (code >= 500 && code < 600)

/** Classifies a *final* HTTP status (transient ones are handled before this is reached). */
export function classifyHttpStatus(code: number): LinkStatus {
  if (code < 400 || RESTRICTED.has(code)) return 'ok'
  return 'broken'
}

export async function attemptLink(url: string, options: FetchOptions = {}): Promise<LinkAttempt> {
  const doFetch = options.fetchImpl ?? appFetch()
  const timeout = options.timeoutMs ?? 10_000
  const send = async (method: 'HEAD' | 'GET'): Promise<{ code: number; retryAfterMs: number | null }> => {
    const res = await doFetch(url, requestInit(method, timeout))
    await res.body?.cancel().catch(() => undefined)
    return { code: statusOf(res), retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) }
  }
  try {
    let answer = await send('HEAD')
    // Plenty of servers mishandle HEAD, so confirm a failure with a GET - but never pile a second request
    // onto a server that just told us to slow down.
    if (answer.code >= 400 && !isRateLimitStatus(answer.code)) answer = await send('GET')
    if (isTransientStatus(answer.code)) {
      return { kind: 'transient', httpStatus: answer.code, retryAfterMs: answer.retryAfterMs, rateLimited: isRateLimitStatus(answer.code) }
    }
    return { kind: 'final', result: { status: classifyHttpStatus(answer.code), httpStatus: answer.code } }
  } catch (error) {
    return { kind: 'network', failure: classifyNetworkError(error) }
  }
}

/**
 * Where to look when we need proof the internet works. All targets are tried together and the first answer
 * wins, so one slow or unreachable target cannot cause a false "you are offline":
 *  - a neutral connectivity-check endpoint (needs DNS);
 *  - a well-known IP address, which needs no DNS at all and so also works when name lookups are struggling.
 * Sites that just answered are tried as well (see probeConnectivity).
 */
export const PROBE_TARGETS: readonly string[] = ['https://www.gstatic.com/generate_204', 'https://1.1.1.1/']

export interface ProbeResult {
  url: string
  ok: boolean
  ms: number
  detail: string
}

/**
 * Returns true if any HTTP response arrives from any target (even an error status: a reply means we are online).
 * `onReport` receives every target's outcome when *nothing* answered, to explain the verdict.
 */
export async function probeConnectivity(
  recentlyWorking: string[],
  options: FetchOptions & { signal?: AbortSignal; targets?: readonly string[]; onReport?: (results: ProbeResult[]) => void } = {}
): Promise<boolean> {
  const doFetch = options.fetchImpl ?? appFetch()
  const targets = [...recentlyWorking.slice(0, 2), ...(options.targets ?? PROBE_TARGETS)]
  const stop = new AbortController() // cancels the stragglers as soon as one target answers
  const signal = options.signal ? AbortSignal.any([stop.signal, options.signal]) : stop.signal
  const results: ProbeResult[] = []

  const probeOne = async (url: string): Promise<boolean> => {
    const started = Date.now()
    try {
      const res = await doFetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 5000), signal]),
        headers: { 'user-agent': USER_AGENT }
      })
      await res.body?.cancel().catch(() => undefined)
      results.push({ url, ok: true, ms: Date.now() - started, detail: 'HTTP ' + res.status })
      return true
    } catch (error) {
      results.push({ url, ok: false, ms: Date.now() - started, detail: describeNetworkError(error) })
      return false
    }
  }

  const online = await new Promise<boolean>((resolve) => {
    let pending = targets.length
    for (const url of targets) {
      void probeOne(url).then((ok) => {
        if (ok) resolve(true)
        else if (--pending === 0) resolve(false)
      })
    }
  })
  stop.abort()
  if (!online && !options.signal?.aborted) options.onReport?.(results)
  return online
}
