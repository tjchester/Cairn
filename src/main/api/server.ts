import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Bookmark } from '@shared/types'
import type { Repo } from '../db/repo'
import { bearerToken, keysMatch } from './auth'
import { CAPTURE_PATH } from './bookmarklet'
import { contentSecurityPolicy, renderCapturePage, type CapturePageModel } from './capturePage'
import { ApiError } from './errors'
import type { CaptureOutcome, Enrichment, IngestService } from './ingest'
import { parseCapture, queryToBody, type CaptureRequest } from './schema'

// The local API: a small HTTP server on 127.0.0.1 that runs only while the app is open.
//
// What protects it, in the order a request meets it:
//  1. It listens on the loopback address only, so nothing on the network can connect.
//  2. The Host header must be the loopback name and our port. A web page that tricks the browser into resolving its
//     own name to 127.0.0.1 ("DNS rebinding") sends its own name there and is turned away.
//  3. JSON endpoints refuse anything that looks like it came from a web page (an Origin header or a cross-site
//     fetch), and send no CORS headers, so browsers cannot read responses either.
//  4. Everything except /ping needs the secret key. Web pages never learn it: only the bookmarklet contains it.
//  5. Sizes and rates are limited.

export const API_VERSION = 1
const MAX_BODY_BYTES = 64 * 1024
const RATE_LIMIT = { perMinute: 30, windowMs: 60_000 }

export interface ApiServerDeps {
  ingest: IngestService
  repo: Repo
  /** Read on every request, so resetting the key takes effect at once. */
  getKey: () => string
  version: string
  /** Method, path and status only: never keys, addresses of pages, or their content. */
  log?: (event: string, data?: Record<string, unknown>) => void
  now?: () => number
}

/** What the API tells callers about a bookmark. A stable public shape, separate from the app's internal one. */
export function toApiBookmark(repo: Repo, b: Bookmark): Record<string, unknown> {
  const path = repo.collectionPath(b.collectionId)
  return {
    id: b.id,
    url: b.url,
    title: b.title,
    description: b.excerpt,
    note: b.note,
    tags: b.tags,
    autoTags: b.autoTags,
    favorite: b.favorite,
    collectionId: b.collectionId,
    collection: b.collectionId === null ? null : path.join('/'),
    domain: b.domain,
    coverUrl: b.coverUrl,
    faviconUrl: b.faviconUrl,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    inTrash: b.deletedAt !== null
  }
}

function messageFor(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === 'EADDRINUSE') return 'Port ' + port + ' is already used by another program. Choose a different port in Settings, then copy the bookmarklet again.'
  if (error.code === 'EACCES') return 'This computer does not allow using port ' + port + '. Choose a different port in Settings.'
  return 'The local API could not start: ' + error.message
}

export class ApiServer {
  private server: Server | null = null
  private boundPort = 0
  private hits: number[] = []

  constructor(private readonly deps: ApiServerDeps) {}

  /** The port actually in use (differs from the requested one only when 0 was asked for, as tests do). */
  get port(): number {
    return this.boundPort
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer({ maxHeaderSize: 32 * 1024 }, (req, res) => void this.onRequest(req, res))
      server.requestTimeout = 15_000
      server.headersTimeout = 10_000
      server.keepAliveTimeout = 2_000
      server.once('error', (error: NodeJS.ErrnoException) => reject(new Error(messageFor(error, port))))
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        server.on('error', (error) => this.deps.log?.('api-error', { message: error.message }))
        this.boundPort = (server.address() as AddressInfo).port
        this.server = server
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  // ---------------------------------------------------------------- requests

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = safePath(req.url)
    let status = 500
    try {
      this.checkHost(req)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/api/v1/ping') status = this.ping(req, res)
      else if (url.pathname === '/api/v1/bookmarks') status = await this.createBookmark(req, res)
      else if (url.pathname === CAPTURE_PATH) status = this.capturePage(req, res, url)
      else throw new ApiError(404, 'not-found', 'There is nothing here.')
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(500, 'internal', 'Something went wrong inside Cairn.')
      if (!(error instanceof ApiError)) this.deps.log?.('api-error', { path, message: error instanceof Error ? error.message : String(error) })
      status = failure.status
      if (path === CAPTURE_PATH) this.sendHtml(res, failure.status, errorPage(failure), failure.headers)
      else this.sendJson(res, failure.status, { error: { code: failure.code, message: failure.message } }, failure.headers)
    }
    this.deps.log?.('api-request', { method: req.method, path, status })
  }

  private checkHost(req: IncomingMessage): void {
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== '127.0.0.1:' + this.boundPort && host !== 'localhost:' + this.boundPort) {
      throw new ApiError(403, 'bad-host', 'Requests must be made to 127.0.0.1 or localhost on port ' + this.boundPort + '.')
    }
  }

  private allow(req: IncomingMessage, method: 'GET' | 'POST'): void {
    if (req.method !== method) throw new ApiError(405, 'method-not-allowed', 'Use ' + method + ' here.', { Allow: method })
  }

  /** Refuses anything that was sent by a web page rather than by a program. */
  private refuseBrowsers(req: IncomingMessage): void {
    const site = req.headers['sec-fetch-site']
    if (req.headers.origin !== undefined || site === 'cross-site' || site === 'same-site') {
      throw new ApiError(403, 'browser-request-refused', 'This endpoint is for programs, not web pages.')
    }
  }

  private authenticate(given: string | undefined): void {
    if (!keysMatch(given, this.deps.getKey())) {
      throw new ApiError(401, 'unauthorized', 'The key is missing or wrong. Send it as "Authorization: Bearer <key>".', { 'WWW-Authenticate': 'Bearer' })
    }
  }

  private rateLimit(): void {
    const now = (this.deps.now ?? Date.now)()
    this.hits = this.hits.filter((t) => now - t < RATE_LIMIT.windowMs)
    if (this.hits.length >= RATE_LIMIT.perMinute) {
      const wait = Math.max(1, Math.ceil((RATE_LIMIT.windowMs - (now - (this.hits[0] ?? now))) / 1000))
      throw new ApiError(429, 'rate-limited', 'Too many bookmarks in a minute. Try again in ' + wait + ' seconds.', { 'Retry-After': String(wait) })
    }
    this.hits.push(now)
  }

  private ping(req: IncomingMessage, res: ServerResponse): number {
    this.allow(req, 'GET')
    this.sendJson(res, 200, { app: 'Cairn', version: this.deps.version, apiVersion: API_VERSION })
    return 200
  }

  /** Keeps a caller from adding this very API as a bookmark (and having the app fetch itself). */
  private refuseOwnAddress(request: CaptureRequest): void {
    const url = new URL(request.url)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (local && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === this.boundPort) {
      throw new ApiError(400, 'refused', 'That address is Cairn\'s own local API.')
    }
  }

  private async createBookmark(req: IncomingMessage, res: ServerResponse): Promise<number> {
    this.allow(req, 'POST')
    this.refuseBrowsers(req)
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      throw new ApiError(415, 'unsupported-media-type', 'Send the request as application/json.')
    }
    this.authenticate(bearerToken(req.headers.authorization))
    this.rateLimit()

    const raw = await readBody(req, MAX_BODY_BYTES)
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new ApiError(400, 'invalid-json', 'The body is not valid JSON.')
    }
    const request = parseCapture(json)
    this.refuseOwnAddress(request)

    const outcome = this.deps.ingest.capture(request)
    let enrichment: Enrichment | null = null
    if (request.wait > 0 && outcome.enrichment === 'queued') {
      enrichment = await Promise.race([outcome.done, new Promise<null>((resolve) => setTimeout(() => resolve(null), request.wait * 1000).unref())])
    }
    const status = outcome.status === 'created' ? 201 : 200
    this.sendJson(res, status, this.describe(outcome, enrichment), status === 201 ? { Location: '/api/v1/bookmarks/' + outcome.bookmark.id } : {})
    return status
  }

  private describe(outcome: CaptureOutcome, finished: Enrichment | null): Record<string, unknown> {
    const { repo } = this.deps
    const bookmark = finished?.bookmark ?? outcome.bookmark
    const body: Record<string, unknown> = {
      status: outcome.status,
      bookmark: toApiBookmark(repo, bookmark),
      enrichment: finished ? finished.state : outcome.enrichment
    }
    if (finished) {
      body['suggestedTags'] = finished.suggestions
      if (finished.note) body['note'] = finished.note
    }
    return body
  }

  /** The pop-up the bookmarklet opens: saves the page and shows the result. */
  private capturePage(req: IncomingMessage, res: ServerResponse, url: URL): number {
    this.allow(req, 'GET')
    this.authenticate(url.searchParams.get('k') ?? undefined)
    this.rateLimit()
    const request = parseCapture(queryToBody(url.searchParams))
    this.refuseOwnAddress(request)
    const outcome = this.deps.ingest.capture(request)
    this.sendHtml(res, 200, savedPage(outcome))
    return 200
  }

  // --------------------------------------------------------------- responses

  private baseHeaders(): Record<string, string> {
    return {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin'
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { ...this.baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...headers })
    res.end(payload)
  }

  private sendHtml(res: ServerResponse, status: number, model: CapturePageModel, headers: Record<string, string> = {}): void {
    const nonce = randomBytes(16).toString('base64')
    const payload = renderCapturePage(model, nonce)
    res.writeHead(status, {
      ...this.baseHeaders(),
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Content-Security-Policy': contentSecurityPolicy(nonce),
      ...headers
    })
    res.end(payload)
  }
}

// ------------------------------------------------------------------ helpers

/** The path of a request for logging: never the query string, which carries the key and page addresses. */
function safePath(url: string | undefined): string {
  return (url ?? '/').split('?')[0]?.slice(0, 100) ?? '/'
}

/**
 * Reads the request body, keeping at most `limit` bytes. A body that is too big is still read to the end (and thrown
 * away, only callers with the key get this far, and the server's request timeout bounds it) so the caller can
 * receive the 413 instead of a broken connection.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) tooLarge = true
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) reject(new ApiError(413, 'too-large', 'The request is too large (limit ' + limit / 1024 + ' KB).', { Connection: 'close' }))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function savedPage(outcome: CaptureOutcome): CapturePageModel {
  const subject = outcome.bookmark.title
  if (outcome.status === 'exists') return { kind: 'exists', heading: 'Already in Cairn', subject, detail: 'This page was saved before.' }
  if (outcome.status === 'restored') return { kind: 'exists', heading: 'Back in Cairn', subject, detail: 'It was in the Trash, so it has been restored.' }
  return {
    kind: 'saved',
    heading: 'Saved to Cairn',
    subject,
    detail: outcome.enrichment === 'queued' ? 'Details and tag suggestions will appear in a moment.' : 'Done.'
  }
}

function errorPage(error: ApiError): CapturePageModel {
  const detail =
    error.code === 'unauthorized'
      ? 'This bookmarklet\'s key is not valid any more. In Cairn, choose Tools → Copy Bookmarklet and replace the one in your browser.'
      : error.message
  return { kind: 'error', heading: error.status === 401 ? 'Cairn did not recognise this bookmarklet' : 'Could not save this page', detail }
}
