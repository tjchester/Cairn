import { request, type IncomingHttpHeaders } from 'node:http'
import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_API, DEFAULT_SETTINGS, DEFAULT_TAGGING, type CaptureEvent, type OllamaStatus, type TaggingMode } from '../src/shared/types'
import { ApiController } from '../src/main/api/controller'
import { buildBookmarklet } from '../src/main/api/bookmarklet'
import { escapeHtml } from '../src/main/api/capturePage'
import { keysMatch } from '../src/main/api/auth'
import { IngestService } from '../src/main/api/ingest'
import { parseCapture, queryToBody } from '../src/main/api/schema'
import { ApiServer } from '../src/main/api/server'
import { applySettingsPatch, readSettings } from '../src/main/settings'
import type { MetadataResult } from '../src/main/services/metadata'
import type { LlmClient, LlmInput } from '../src/main/tagging/llm'
import { TaggingService } from '../src/main/tagging/service'
import type { Repo } from '../src/main/db/repo'
import { makeRepo } from './helpers'

const KEY = 'test-key-0123456789'

// ------------------------------------------------------------------ settings

describe('API settings', () => {
  it('is off by default, on a fixed port', () => {
    expect(readSettings(makeRepo()).api).toEqual({ enabled: false, port: 47821 })
    expect(DEFAULT_SETTINGS.api).toEqual(DEFAULT_API)
  })

  it('saves changes field by field and rejects bad ports', () => {
    const repo = makeRepo()
    applySettingsPatch(repo, { api: { enabled: true } })
    applySettingsPatch(repo, { api: { port: 50123 } })
    expect(readSettings(repo).api).toEqual({ enabled: true, port: 50123 })
    for (const port of [80, 1023, 65536, 12.5, -1]) {
      expect(() => applySettingsPatch(repo, { api: { port } }), String(port)).toThrow(/port/i)
    }
    expect(readSettings(repo).api.port).toBe(50123)
  })

  it('does not let other stored keys (like the secret key) break reading the settings', () => {
    const repo = makeRepo()
    repo.setSettingRaw('apiKey', 'secret')
    repo.setSettingRaw('theme', 'dark')
    const settings = readSettings(repo)
    expect(settings.theme).toBe('dark')
    expect(Object.values(settings).map((v) => JSON.stringify(v)).join()).not.toContain('secret')
  })
})

// ---------------------------------------------------------------- bookmarklet

describe('bookmarklet', () => {
  function run(code: string, page: { href: string; title: string; selection?: string }, popupBlocked = false) {
    const opened: { url: string; name: string }[] = []
    const alerts: string[] = []
    const context = {
      window: {
        open: (url: string, name: string) => (popupBlocked ? null : (opened.push({ url, name }), {})),
        getSelection: () => ({ toString: () => page.selection ?? '' }),
        alert: (m: string) => alerts.push(m)
      },
      location: { href: page.href },
      document: { title: page.title },
      alert: (m: string) => alerts.push(m)
    }
    expect(code.startsWith('javascript:')).toBe(true)
    runInNewContext(code.slice('javascript:'.length), context)
    return { opened, alerts }
  }

  it('contains no percent sign (browsers decode javascript: bookmarks before running them)', () => {
    const code = buildBookmarklet(47821, 'aB-_09xyz')
    expect(code).not.toContain('%')
    expect(code).not.toMatch(/[\r\n]/)
  })

  it('opens the local capture page with the address, title and any selected text', () => {
    const { opened } = run(buildBookmarklet(47821, KEY), { href: 'https://example.com/a?b=c&d=e#f', title: 'Ünïcode & <title>', selection: '  some quote  ' })
    expect(opened).toHaveLength(1)
    const url = new URL(opened[0]?.url ?? '')
    expect(url.origin).toBe('http://127.0.0.1:47821')
    expect(url.pathname).toBe('/capture')
    expect(url.searchParams.get('k')).toBe(KEY)
    expect(url.searchParams.get('url')).toBe('https://example.com/a?b=c&d=e#f')
    expect(url.searchParams.get('title')).toBe('Ünïcode & <title>')
    expect(url.searchParams.get('note')).toBe('some quote')
    expect(opened[0]?.name).toBe('cairn-capture')
  })

  it('sends no note when nothing is selected, and cuts long values down', () => {
    const { opened } = run(buildBookmarklet(50000, KEY), { href: 'https://e.com/' + 'x'.repeat(3000), title: 't'.repeat(1000), selection: 'n'.repeat(5000) })
    const url = new URL(opened[0]?.url ?? '')
    expect(url.searchParams.get('url')?.length).toBe(2000)
    expect(url.searchParams.get('title')?.length).toBe(300)
    expect(url.searchParams.get('note')?.length).toBe(1000)
    const plain = run(buildBookmarklet(50000, KEY), { href: 'https://e.com/', title: 'T' })
    expect(new URL(plain.opened[0]?.url ?? '').searchParams.has('note')).toBe(false)
  })

  it('survives a cut in the middle of an emoji', () => {
    const { opened } = run(buildBookmarklet(47821, KEY), { href: 'https://e.com/', title: 'a'.repeat(299) + '😀 tail' })
    expect(new URL(opened[0]?.url ?? '').searchParams.get('title')).toBe('a'.repeat(299))
  })

  it('tells the user when the browser blocked the pop-up', () => {
    const { alerts } = run(buildBookmarklet(47821, KEY), { href: 'https://e.com/', title: 'T' }, true)
    expect(alerts[0]).toMatch(/pop-up/i)
  })
})

// ---------------------------------------------------------------- request shape

describe('capture requests', () => {
  it('needs only a url, and fills in the defaults', () => {
    expect(parseCapture({ url: 'example.com/page' })).toEqual({
      url: 'https://example.com/page',
      tags: [],
      favorite: false,
      fetch: true,
      useLlm: true,
      onDuplicate: 'skip',
      wait: 0
    })
  })

  it('explains what is wrong', () => {
    expect(() => parseCapture({})).toThrow(/url/)
    expect(() => parseCapture({ url: 'javascript:alert(1)' })).toThrow(/http and https/)
    expect(() => parseCapture({ url: 'file:///etc/passwd' })).toThrow(/http and https/)
    expect(() => parseCapture({ url: 'https://a.com', colour: 'red' })).toThrow(/Unknown field: "colour"/)
    expect(() => parseCapture({ url: 'https://a.com', collection: 'A', collectionId: 2 })).toThrow(/either/)
    expect(() => parseCapture({ url: 'https://a.com', wait: 99 })).toThrow(/wait/)
    expect(() => parseCapture({ url: 'https://a.com', autoTag: 'always' })).toThrow(/autoTag/)
  })

  it('reads the bookmarklet\'s query string into the same shape', () => {
    const params = new URLSearchParams('k=x&url=https%3A%2F%2Fa.com%2F&title=Hi&tags=a,b&tag=c&favorite=1&fetch=no&collectionId=7&junk=1&note=')
    const request = parseCapture(queryToBody(params))
    expect(request).toMatchObject({ url: 'https://a.com/', title: 'Hi', tags: ['a', 'b', 'c'], favorite: true, fetch: false, collectionId: 7 })
    expect(request.note).toBeUndefined()
  })

  it('compares keys without caring about length or position', () => {
    expect(keysMatch(KEY, KEY)).toBe(true)
    expect(keysMatch(KEY + 'x', KEY)).toBe(false)
    expect(keysMatch(KEY.slice(0, -1), KEY)).toBe(false)
    expect(keysMatch('', KEY)).toBe(false)
    expect(keysMatch(undefined, KEY)).toBe(false)
  })
})

// ------------------------------------------------------------------- ingest

function page(over: Partial<MetadataResult> = {}): MetadataResult {
  return {
    title: 'Fetched title',
    excerpt: 'A page about Docker containers.',
    coverUrl: 'https://cdn.example.com/cover.png',
    faviconUrl: 'https://example.com/icon.png',
    finalUrl: 'https://github.com/org/repo',
    status: 200,
    retryAfterMs: null,
    signals: { keywords: [], ogType: null, siteName: 'GitHub', lang: 'en', section: null, text: 'Docker containers.' },
    ...over
  }
}

class FakeLlm implements LlmClient {
  calls: LlmInput[] = []
  constructor(private readonly answer: () => string[] | Error = () => ['zebras']) {}
  async suggest(input: LlmInput): Promise<string[]> {
    this.calls.push(input)
    const result = this.answer()
    if (result instanceof Error) throw result
    return result
  }
  async status(): Promise<OllamaStatus> {
    return { ok: true, models: ['m'], modelReady: true, message: 'ok' }
  }
}

function makeIngest(mode: TaggingMode = 'suggest', options: { fetcher?: (url: string) => Promise<MetadataResult>; llm?: LlmClient; llmOn?: boolean } = {}) {
  const repo = makeRepo()
  const events: CaptureEvent[] = []
  const fetched: string[] = []
  const config = { ...DEFAULT_TAGGING, mode, llm: { ...DEFAULT_TAGGING.llm, enabled: options.llmOn ?? false, model: 'm' } }
  const tagging = new TaggingService(repo, () => config, options.llm ?? new FakeLlm())
  const ingest = new IngestService({
    repo,
    tagging,
    fetcher:
      options.fetcher ??
      (async (url) => {
        fetched.push(url)
        return page()
      }),
    notify: (event) => events.push(event),
    retryDelayMs: 0
  })
  return { repo, ingest, events, fetched, tagging }
}

const req = (url: string, over: Record<string, unknown> = {}) => parseCapture({ url, ...over })

describe('ingesting a URL', () => {
  it('saves at once, then fills in the details and queues tag suggestions', async () => {
    const { repo, ingest, events } = makeIngest('suggest')
    const outcome = ingest.capture(req('https://github.com/org/repo'))
    expect(outcome.status).toBe('created')
    expect(outcome.enrichment).toBe('queued')
    expect(outcome.bookmark.title).toBe('github.com') // just the address until the page has been read

    const done = await outcome.done
    expect(done.state).toBe('done')
    const saved = repo.getBookmark(outcome.bookmark.id)
    expect(saved).toMatchObject({ title: 'Fetched title', excerpt: 'A page about Docker containers.', coverUrl: 'https://cdn.example.com/cover.png' })
    expect(repo.getSignals(outcome.bookmark.id)?.siteName).toBe('GitHub') // stored, so it is never fetched again for tagging
    expect(saved?.tags).toEqual([]) // Suggest mode: nothing is applied...
    expect(done.suggestions.map((s) => s.tag)).toEqual(expect.arrayContaining(['code', 'docker'])) // ...it waits for review
    expect(repo.pendingProposalCount()).toBeGreaterThan(0)
    expect(events.map((e) => e.stage)).toEqual(['saved', 'enriched'])
  })

  it('keeps a title the caller supplied, and the tags and note it gave', async () => {
    const { repo, ingest } = makeIngest('suggest')
    const outcome = ingest.capture(req('https://github.com/org/repo', { title: 'My own title', note: 'why I saved it', tags: ['Reading'], favorite: true, description: 'mine' }))
    await outcome.done
    expect(repo.getBookmark(outcome.bookmark.id)).toMatchObject({ title: 'My own title', note: 'why I saved it', tags: ['Reading'], favorite: true, excerpt: 'mine' })
  })

  it('in Auto mode applies the tags as automatic ones, in a run of its own that "undo last run" does not offer', async () => {
    const { repo, ingest } = makeIngest('auto')
    repo.createBookmark({ url: 'https://other.example/', tags: ['docker'] })
    const outcome = ingest.capture(req('https://github.com/org/repo'))
    await outcome.done
    const saved = repo.getBookmark(outcome.bookmark.id)
    expect(saved?.tags).toEqual(expect.arrayContaining(['code', 'docker']))
    expect(saved?.autoTags).toEqual(expect.arrayContaining(['code', 'docker']))
    expect(repo.pendingProposalCount()).toBe(0)
    expect(repo.lastRun()).toBeNull()
  })

  it('lets a request override the tagging mode, and skip everything', async () => {
    const off = makeIngest('suggest')
    const outcome = off.ingest.capture(req('https://github.com/org/repo', { autoTag: 'off' }))
    await outcome.done
    expect(off.repo.pendingProposalCount()).toBe(0)

    const nothing = makeIngest('suggest')
    const quiet = nothing.ingest.capture(req('https://github.com/org/repo', { autoTag: 'off', fetch: false }))
    expect(quiet.enrichment).toBe('none')
    expect((await quiet.done).state).toBe('none')
    expect(nothing.fetched).toEqual([])

    const auto = makeIngest('suggest')
    const forced = auto.ingest.capture(req('https://github.com/org/repo', { autoTag: 'auto', fetch: false }))
    await forced.done
    expect(auto.repo.getBookmark(forced.bookmark.id)?.autoTags).toContain('code') // built-in rules need no page lookup for GitHub
  })

  it('uses the local model when it is set up, and says so when it cannot', async () => {
    const working = makeIngest('suggest', { llmOn: true, llm: new FakeLlm(() => ['zebras']) })
    const first = working.ingest.capture(req('https://example.org/x', { title: 'Notes on zebras' }))
    await first.done
    expect(working.repo.proposalItems('zebras')).toHaveLength(0) // a brand-new tag only the model thought of waits for a second bookmark
    expect(working.repo.heldBookmarkIds('zebras')).toEqual([first.bookmark.id])
    await working.ingest.capture(req('https://example.org/y', { title: 'More on zebras' })).done
    expect(working.repo.proposalItems('zebras')).toHaveLength(2) // now both are offered for review

    const broken = makeIngest('suggest', { llmOn: true, llm: new FakeLlm(() => new Error('Ollama did not answer in time.')) })
    const b = broken.ingest.capture(req('https://github.com/org/repo'))
    const done = await b.done
    expect(done.note).toMatch(/local model was not used: Ollama did not answer/)
    expect(done.suggestions.map((s) => s.tag)).toContain('code') // built-in suggestions still delivered

    const notWanted = makeIngest('suggest', { llmOn: true, llm: new FakeLlm() })
    await notWanted.ingest.capture(req('https://github.com/org/repo', { useLlm: false })).done
    expect((notWanted.tagging as unknown as { llm: FakeLlm }).llm.calls).toHaveLength(0)
  })

  it('keeps the bookmark when the page cannot be read, retries once, and leaves it for "Fetch missing details"', async () => {
    let calls = 0
    const { repo, ingest } = makeIngest('suggest', {
      fetcher: async () => {
        calls++
        throw new Error('fetch failed')
      }
    })
    const outcome = ingest.capture(req('https://github.com/org/repo'))
    const done = await outcome.done
    expect(calls).toBe(2)
    expect(done.state).toBe('failed')
    expect(done.note).toMatch(/Could not reach the site/)
    expect(repo.getBookmark(outcome.bookmark.id)).not.toBeNull()
    expect(repo.listForJob('missing-metadata').map((j) => j.id)).toContain(outcome.bookmark.id)
    expect(done.suggestions.map((s) => s.tag)).toContain('code') // the address alone still says "code"
  })

  it('does not retry a page that is simply gone, and does not save a guessed icon for it', async () => {
    let calls = 0
    const { repo, ingest } = makeIngest('off', {
      fetcher: async () => {
        calls++
        return page({ status: 404, title: '', excerpt: '', coverUrl: null, signals: undefined })
      }
    })
    const outcome = ingest.capture(req('https://example.com/gone'))
    const done = await outcome.done
    expect(calls).toBe(1)
    expect(done.note).toMatch(/HTTP 404/)
    expect(repo.getBookmark(outcome.bookmark.id)?.faviconUrl).toBeNull()
  })

  it('reports an existing bookmark instead of adding it twice, restoring one from the Trash', async () => {
    const { repo, ingest, events } = makeIngest('suggest')
    const first = ingest.capture(req('https://example.com/a'))
    await first.done
    const again = ingest.capture(req('http://www.example.com/a/?utm_source=x'))
    expect(again.status).toBe('exists')
    expect(again.bookmark.id).toBe(first.bookmark.id)
    expect(again.enrichment).toBe('none')
    expect(repo.counts().all).toBe(1)

    repo.trash([first.bookmark.id])
    const back = ingest.capture(req('https://example.com/a'))
    expect(back.status).toBe('restored')
    expect(repo.getBookmark(first.bookmark.id)?.deletedAt).toBeNull()
    expect(events.map((e) => e.stage)).toEqual(['saved', 'enriched', 'exists', 'exists'])
  })

  it('can merge new tags and a note into an existing bookmark, without overwriting its own', async () => {
    const { repo, ingest } = makeIngest('off')
    const first = ingest.capture(req('https://example.com/a', { tags: ['one'], note: 'original', autoTag: 'off', fetch: false }))
    ingest.capture(req('https://example.com/a', { tags: ['two'], note: 'other', onDuplicate: 'merge' }))
    expect(repo.getBookmark(first.bookmark.id)).toMatchObject({ tags: ['one', 'two'], note: 'original' })
    const bare = ingest.capture(req('https://example.com/b', { autoTag: 'off', fetch: false }))
    ingest.capture(req('https://example.com/b', { note: 'now with a note', onDuplicate: 'merge' }))
    expect(repo.getBookmark(bare.bookmark.id)?.note).toBe('now with a note')
  })

  it('finds a collection by name or path (case-insensitively), and refuses one that does not exist', () => {
    const { repo, ingest } = makeIngest('off')
    const work = repo.createCollection({ name: 'Work' })
    const reading = repo.createCollection({ name: 'Reading', parentId: work.id })
    const a = ingest.capture(req('https://example.com/a', { collection: 'work / READING', autoTag: 'off', fetch: false }))
    expect(a.bookmark.collectionId).toBe(reading.id)
    const b = ingest.capture(req('https://example.com/b', { collectionId: work.id, autoTag: 'off', fetch: false }))
    expect(b.bookmark.collectionId).toBe(work.id)
    expect(() => ingest.capture(req('https://example.com/c', { collection: 'Nope' }))).toThrow(/no collection "Nope"/)
    expect(() => ingest.capture(req('https://example.com/c', { collection: 'Reading' }))).toThrow(/no collection/) // only a top-level "Reading" would match
    expect(() => ingest.capture(req('https://example.com/c', { collectionId: 999 }))).toThrow(/no collection with id 999/)
    expect(repo.findByUrl('https://example.com/c')).toBeNull() // a refused request saves nothing
  })

  it('looks pages up a few at a time', async () => {
    let active = 0
    let peak = 0
    const { ingest } = makeIngest('off', {
      fetcher: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active--
        return page()
      }
    })
    const outcomes = Array.from({ length: 9 }, (_, i) => ingest.capture(req('https://example.com/p' + i)))
    await Promise.all(outcomes.map((o) => o.done))
    expect(peak).toBe(3)
  })
})

// --------------------------------------------------------------------- server

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  text: string
  json: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

function call(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: Reply['json'] = {}
        try {
          json = JSON.parse(text)
        } catch {
          // not JSON (an HTML page)
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('the local API server', () => {
  const stops: (() => Promise<void>)[] = []
  afterEach(async () => {
    while (stops.length) await stops.pop()?.()
  })

  async function boot(mode: TaggingMode = 'suggest', extra: { now?: () => number; logs?: [string, unknown][] } = {}) {
    const made = makeIngest(mode)
    const server = new ApiServer({
      ingest: made.ingest,
      repo: made.repo,
      getKey: () => KEY,
      version: '9.9.9',
      now: extra.now,
      log: extra.logs ? (event, data) => extra.logs?.push([event, data]) : undefined
    })
    await server.start(0)
    stops.push(() => server.stop())
    const auth = { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' }
    const post = (body: unknown, headers: Record<string, string> = auth) =>
      call(server.port, { method: 'POST', path: '/api/v1/bookmarks', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { ...made, server, auth, post, get: (path: string, headers?: Record<string, string>) => call(server.port, { path, headers }) }
  }

  it('answers a ping without a key, and says nothing about your data', async () => {
    const { get } = await boot()
    const reply = await get('/api/v1/ping')
    expect(reply.status).toBe(200)
    expect(reply.json).toEqual({ app: 'Cairn', version: '9.9.9', apiVersion: 1 })
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['access-control-allow-origin']).toBeUndefined() // no CORS: web pages cannot read it
  })

  it('listens on the loopback address only: this computer\'s network address gets no answer', async () => {
    const { server } = await boot()
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)
    if (!lan) return // no network adapter here: nothing to check
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect({ host: lan.address, port: server.port }, () => resolve('connected'))
        socket.on('error', reject)
        socket.setTimeout(3000, () => reject(new Error('timeout')))
      })
    ).rejects.toThrow(/ECONNREFUSED|timeout|EHOSTUNREACH/)
  })

  it('creates a bookmark from just a url, and answers 201 straight away', async () => {
    const { post, repo } = await boot()
    const reply = await post({ url: 'https://github.com/org/repo' })
    expect(reply.status).toBe(201)
    expect(reply.headers.location).toMatch(/^\/api\/v1\/bookmarks\/\d+$/)
    expect(reply.json).toMatchObject({ status: 'created', enrichment: 'queued', bookmark: { url: 'https://github.com/org/repo', inTrash: false, collection: null } })
    expect(repo.counts().all).toBe(1)
  })

  it('can wait for details and tags, and returns them', async () => {
    const { post } = await boot('suggest')
    const reply = await post({ url: 'https://github.com/org/repo', wait: 10, tags: ['mine'], collection: undefined })
    expect(reply.status).toBe(201)
    expect(reply.json).toMatchObject({ enrichment: 'done', bookmark: { title: 'Fetched title', description: 'A page about Docker containers.', tags: ['mine'] } })
    expect(reply.json['suggestedTags'].map((t: { tag: string }) => t.tag)).toEqual(expect.arrayContaining(['code', 'docker']))
  })

  it('answers 200 for something already saved', async () => {
    const { post } = await boot()
    await post({ url: 'https://example.com/a', fetch: false, autoTag: 'off' })
    const again = await post({ url: 'https://example.com/a' })
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ status: 'exists', enrichment: 'none' })
  })

  it('refuses a missing or wrong key', async () => {
    const { post, repo } = await boot()
    const none = await post({ url: 'https://example.com/a' }, { 'content-type': 'application/json' })
    expect(none.status).toBe(401)
    expect(none.headers['www-authenticate']).toBe('Bearer')
    const wrong = await post({ url: 'https://example.com/a' }, { authorization: 'Bearer nope', 'content-type': 'application/json' })
    expect(wrong.status).toBe(401)
    expect(wrong.json.error.code).toBe('unauthorized')
    expect(repo.counts().all).toBe(0)
  })

  it('turns away a forged Host header (DNS rebinding)', async () => {
    const { server, auth, repo } = await boot()
    for (const host of ['evil.example.com', 'evil.example.com:' + server.port, '127.0.0.1:1', 'localhost']) {
      const reply = await call(server.port, { method: 'POST', path: '/api/v1/bookmarks', headers: { ...auth, host }, body: JSON.stringify({ url: 'https://example.com/a' }) })
      expect(reply.status, host).toBe(403)
      expect(reply.json.error.code).toBe('bad-host')
    }
    const ping = await call(server.port, { path: '/api/v1/ping', headers: { host: 'evil.example.com:' + server.port } })
    expect(ping.status).toBe(403)
    const local = await call(server.port, { path: '/api/v1/ping', headers: { host: 'localhost:' + server.port } })
    expect(local.status).toBe(200)
    expect(repo.counts().all).toBe(0)
  })

  it('refuses requests that come from a web page, even with the right key', async () => {
    const { post, auth, repo } = await boot()
    const origin = await post({ url: 'https://example.com/a' }, { ...auth, origin: 'https://evil.example.com' })
    expect(origin.status).toBe(403)
    expect(origin.json.error.code).toBe('browser-request-refused')
    const cross = await post({ url: 'https://example.com/a' }, { ...auth, 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)
    expect(repo.counts().all).toBe(0)
  })

  it('answers a CORS preflight without permission', async () => {
    const { server } = await boot()
    const reply = await call(server.port, { method: 'OPTIONS', path: '/api/v1/bookmarks', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' } })
    expect(reply.status).toBe(405)
    expect(reply.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('checks the method, the content type and the body', async () => {
    const { post, auth, server } = await boot()
    expect((await call(server.port, { path: '/api/v1/bookmarks', headers: auth })).status).toBe(405)
    expect((await post({ url: 'https://example.com/a' }, { authorization: auth.authorization, 'content-type': 'text/plain' })).status).toBe(415)
    expect((await post('not json')).json.error.code).toBe('invalid-json')
    const unknown = await post({ url: 'https://example.com/a', bogus: 1 })
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.message).toMatch(/Unknown field: "bogus"/)
    expect((await post({ url: 'ftp://example.com/a' })).json.error.code).toBe('invalid-url')
    expect((await post({ url: 'https://example.com/a', collection: 'Missing' })).json.error.code).toBe('unknown-collection')
    expect((await post({})).status).toBe(400)
    expect((await call(server.port, { path: '/nope' })).status).toBe(404)
  })

  it('refuses a body over 64 KB', async () => {
    const { post, repo } = await boot()
    const reply = await post({ url: 'https://example.com/a', note: 'x'.repeat(70 * 1024) })
    expect(reply.status).toBe(413)
    expect(repo.counts().all).toBe(0)
  })

  it('does not accept its own address as a bookmark', async () => {
    const { post, server } = await boot()
    for (const url of ['http://127.0.0.1:' + server.port + '/capture', 'http://localhost:' + server.port + '/x']) {
      expect((await post({ url })).json.error.code).toBe('refused')
    }
    expect((await post({ url: 'http://127.0.0.1:1/other', fetch: false, autoTag: 'off' })).status).toBe(201) // other local pages are fine
  })

  it('limits how fast bookmarks can be added', async () => {
    let now = 1_000_000
    const { post } = await boot('off', { now: () => now })
    for (let i = 0; i < 30; i++) expect((await post({ url: 'https://example.com/p' + i, fetch: false })).status).toBe(201)
    const limited = await post({ url: 'https://example.com/one-too-many', fetch: false })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    now += 61_000
    expect((await post({ url: 'https://example.com/later', fetch: false })).status).toBe(201)
  })

  it('shows a page for the bookmarklet, saves the bookmark, and closes itself', async () => {
    const { get, repo, events } = await boot('suggest')
    const reply = await get('/capture?k=' + KEY + '&url=' + encodeURIComponent('https://github.com/org/repo') + '&title=' + encodeURIComponent('My page') + '&note=' + encodeURIComponent('quote'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toMatch(/text\/html/)
    expect(reply.text).toContain('Saved to Cairn')
    expect(reply.text).toContain('My page')
    expect(reply.text).toContain('window.close()')
    expect(repo.findByUrl('https://github.com/org/repo')).toMatchObject({ title: 'My page', note: 'quote' })
    expect(events[0]).toMatchObject({ stage: 'saved', title: 'My page' })

    const again = await get('/capture?k=' + KEY + '&url=' + encodeURIComponent('https://github.com/org/repo'))
    expect(again.text).toContain('Already in Cairn')
    expect(repo.counts().all).toBe(1)
  })

  it('escapes whatever a hostile page puts in its title, and locks the page down with a policy', async () => {
    const { get, repo } = await boot('off')
    const title = '<img src=x onerror=alert(1)><script>alert(2)</script>"\''
    const reply = await get('/capture?k=' + KEY + '&url=' + encodeURIComponent('https://example.com/x') + '&title=' + encodeURIComponent(title))
    expect(reply.text).not.toContain('<img')
    expect(reply.text).not.toContain('<script>alert')
    expect(reply.text).toContain(escapeHtml(title))
    const csp = String(reply.headers['content-security-policy'])
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    expect(nonce).toBeTruthy()
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(reply.text).toContain('<script nonce="' + nonce + '">') // the only script is ours
    expect(reply.text.match(/<script/g)).toHaveLength(1)
    expect(reply.headers['referrer-policy']).toBe('no-referrer')
    expect(repo.findByUrl('https://example.com/x')?.title).toBe(title) // stored as text, shown escaped
  })

  it('shows a helpful page (that stays open) when the bookmarklet is out of date or the address is bad', async () => {
    const { get, repo } = await boot()
    const stale = await get('/capture?k=old&url=' + encodeURIComponent('https://example.com/x'))
    expect(stale.status).toBe(401)
    expect(stale.text).toContain('Copy Bookmarklet')
    expect(stale.text).not.toContain('window.close')
    const bad = await get('/capture?k=' + KEY + '&url=' + encodeURIComponent('javascript:alert(1)'))
    expect(bad.status).toBe(400)
    expect(bad.text).toContain('Only http and https')
    const post = await call((await boot()).server.port, { method: 'POST', path: '/capture?k=' + KEY })
    expect(post.status).toBe(405)
    expect(repo.counts().all).toBe(0)
  })

  it('logs the method, path and outcome, and never the key or a page address', async () => {
    const logs: [string, unknown][] = []
    const { get } = await boot('off', { logs })
    await get('/capture?k=' + KEY + '&url=' + encodeURIComponent('https://secret.example.com/private'))
    const text = JSON.stringify(logs)
    expect(text).toContain('/capture')
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('secret.example.com')
  })

  it('stops listening when told to', async () => {
    const { server, get } = await boot()
    const port = server.port
    expect((await get('/api/v1/ping')).status).toBe(200)
    await server.stop()
    await expect(call(port, { path: '/api/v1/ping' })).rejects.toThrow()
  })
})

// ----------------------------------------------------------------- controller

describe('the API controller', () => {
  const controllers: ApiController[] = []
  afterEach(async () => {
    while (controllers.length) await controllers.pop()?.stop()
  })

  function make(repo: Repo = makeRepo()) {
    const { ingest } = makeIngest('off')
    const controller = new ApiController({ repo, ingest, version: '1.0.0', getSettings: () => readSettings(repo).api })
    controllers.push(controller)
    return { repo, controller }
  }

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port
        probe.close(() => resolve(port))
      })
    })
  }

  it('does nothing until it is switched on, follows the setting, and moves when the port changes', async () => {
    const { repo, controller } = make()
    expect(controller.status()).toMatchObject({ enabled: false, running: false })
    const first = await freePort()
    applySettingsPatch(repo, { api: { enabled: true, port: first < 1024 ? 40000 : first } })
    const on = await controller.apply()
    expect(on).toMatchObject({ enabled: true, running: true, error: null })
    expect((await call(on.port, { path: '/api/v1/ping' })).status).toBe(200)

    const second = await freePort()
    applySettingsPatch(repo, { api: { port: second } })
    const moved = await controller.apply()
    expect(moved).toMatchObject({ running: true, port: second })
    await expect(call(first, { path: '/api/v1/ping' })).rejects.toThrow()
    expect((await call(second, { path: '/api/v1/ping' })).status).toBe(200)

    applySettingsPatch(repo, { api: { enabled: false } })
    expect((await controller.apply()).running).toBe(false)
    await expect(call(second, { path: '/api/v1/ping' })).rejects.toThrow()
  })

  it('says so when the port is taken, instead of picking another one', async () => {
    const { repo, controller } = make()
    const blocker = createServer()
    const port = await new Promise<number>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as { port: number }).port)))
    try {
      applySettingsPatch(repo, { api: { enabled: true, port } })
      const status = await controller.apply()
      expect(status.running).toBe(false)
      expect(status.error).toMatch(new RegExp('Port ' + port + ' is already used'))
    } finally {
      blocker.close()
    }
    // Once the port is free, applying again works.
    expect((await controller.apply()).running).toBe(true)
  })

  it('keeps one secret key, and a reset makes old bookmarklets stop working at once', async () => {
    const { repo, controller } = make()
    const key = controller.key()
    expect(key.length).toBeGreaterThanOrEqual(40)
    expect(controller.key()).toBe(key)
    expect(repo.getSettingRaw('apiKey')).toBe(key)

    const port = await freePort()
    applySettingsPatch(repo, { api: { enabled: true, port } })
    await controller.apply()
    const oldBookmarklet = controller.bookmarklet()
    expect(oldBookmarklet).toContain(String(port))
    const url = (bookmarklet: string) => '/capture?k=' + new URL(/"(http[^"]+)"/.exec(bookmarklet)?.[1] ?? '').searchParams.get('k') + '&url=' + encodeURIComponent('https://example.com/a')
    expect((await call(port, { path: url(oldBookmarklet) })).status).toBe(200)

    controller.resetKey()
    expect(controller.key()).not.toBe(key)
    expect((await call(port, { path: url(oldBookmarklet) })).status).toBe(401)
    expect((await call(port, { path: url(controller.bookmarklet()) })).status).toBe(200)
  })
})
