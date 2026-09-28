import { describe, expect, it } from 'vitest'
import { runPool } from '../src/main/services/jobs'
import { attemptLink, isTransientStatus, mendReply, ORIGINAL_STATUS_HEADER, statusOf, classifyHttpStatus, fetchMetadata, parseMetadata, probeConnectivity, type ProbeResult } from '../src/main/services/metadata'

const PAGE = `<!doctype html><html><head>
<meta charset="utf-8">
<title>  Fallback   title </title>
<meta property="og:title" content="Rust &amp; Friends">
<meta name="description" content="A page about things">
<meta property="og:image" content="/img/cover.png">
<link rel="shortcut icon" href="/favicon-32.png">
<link rel="apple-touch-icon" href="/touch.png">
</head><body>hi</body></html>`

const htmlResponse = (body: string, init: ResponseInit = {}, url = 'https://example.com/post') => {
  const res = new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...init })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

const networkError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) })

describe('parseMetadata', () => {
  it('prefers Open Graph, resolves relative URLs and decodes entities', () => {
    expect(parseMetadata(PAGE, 'https://example.com/post')).toMatchObject({
      title: 'Rust & Friends',
      excerpt: 'A page about things',
      coverUrl: 'https://example.com/img/cover.png',
      faviconUrl: 'https://example.com/favicon-32.png'
    })
  })

  it('falls back to <title> and /favicon.ico', () => {
    const meta = parseMetadata('<html><head><title>Only title</title></head></html>', 'https://x.org/a/b')
    expect(meta).toMatchObject({ title: 'Only title', coverUrl: null, faviconUrl: 'https://x.org/favicon.ico' })
  })

  it('extracts tagging signals: keywords from every source, page type, language, section and body text', () => {
    const html = `<!doctype html><html lang="en-GB"><head>
      <meta property="og:type" content="Article"><meta property="og:site_name" content="Example Times">
      <meta property="article:section" content="Technology">
      <meta property="article:tag" content="Rust"><meta property="article:tag" content="Systems Programming">
      <meta name="keywords" content="rust, memory safety; ownership , Rust">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","keywords":["borrow checker","rust"]}]}</script>
      <script type="application/ld+json">{ this is not json </script>
      </head><body><nav><p>Menu</p></nav>
      <p>Rust is a systems programming language focused on safety, speed and concurrency for everyone.</p>
      <p>Short.</p>
      <p>Its ownership model guarantees memory safety without needing a garbage collector at runtime.</p>
      </body></html>`
    const { signals } = parseMetadata(html, 'https://example.com/post')
    expect(signals?.keywords).toEqual(['Rust', 'Systems Programming', 'borrow checker', 'memory safety', 'ownership']) // de-duplicated, best sources first
    expect(signals).toMatchObject({ ogType: 'article', siteName: 'Example Times', lang: 'en', section: 'Technology' })
    expect(signals?.text).toContain('systems programming language')
    expect(signals?.text).toContain('garbage collector')
    expect(signals?.text).not.toContain('Menu')
    expect(signals?.text).not.toContain('Short.')
  })

  it('returns empty, safe signals for a bare page and caps the amount of text kept', () => {
    expect(parseMetadata('<html><body>hi</body></html>', 'https://x.org/').signals).toEqual({
      keywords: [],
      ogType: null,
      siteName: null,
      lang: null,
      section: null,
      text: ''
    })
    const long = '<p>' + 'word '.repeat(400) + '</p>'
    expect(parseMetadata('<html><body>' + long.repeat(5) + '</body></html>', 'https://x.org/').signals?.text.length).toBeLessThanOrEqual(2000)
  })

  it('ignores non-http image URLs', () => {
    const meta = parseMetadata('<meta property="og:image" content="data:image/png;base64,AAAA">', 'https://x.org/')
    expect(meta.coverUrl).toBeNull()
  })
})

describe('fetchMetadata', () => {
  it('reads an HTML page and reports the final URL', async () => {
    const meta = await fetchMetadata('example.com/post', { fetchImpl: async () => htmlResponse(PAGE) })
    expect(meta).toMatchObject({ title: 'Rust & Friends', finalUrl: 'https://example.com/post', status: 200, retryAfterMs: null })
  })

  it('returns no scraped data for error pages', async () => {
    const meta = await fetchMetadata('https://example.com/x', {
      fetchImpl: async () => htmlResponse('<title>404 Not Found</title>', { status: 404 })
    })
    expect(meta).toMatchObject({ title: '', status: 404 })
  })

  it('surfaces a rate-limited response together with its Retry-After hint', async () => {
    const meta = await fetchMetadata('https://example.com/x', {
      fetchImpl: async () => htmlResponse('slow down', { status: 429, headers: { 'retry-after': '45', 'content-type': 'text/plain' } })
    })
    expect(meta).toMatchObject({ status: 429, retryAfterMs: 45_000, title: '' })
  })

  it('uses the image itself as the cover for image URLs', async () => {
    const meta = await fetchMetadata('https://example.com/pics/cat.png', {
      fetchImpl: async () => {
        const res = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
        Object.defineProperty(res, 'url', { value: 'https://example.com/pics/cat.png' })
        return res
      }
    })
    expect(meta).toMatchObject({ title: 'cat.png', coverUrl: 'https://example.com/pics/cat.png' })
  })

  it('refuses non-web URLs before making any request', async () => {
    let called = false
    await expect(fetchMetadata('file:///etc/passwd', { fetchImpl: async () => ((called = true), htmlResponse('')) })).rejects.toThrow()
    expect(called).toBe(false)
  })
})

describe('replies the network stack cannot build (LinkedIn answers 999)', () => {
  // A reply may only carry 200 to 599, so the main process brings an odd status into range as it arrives and puts the
  // real number in a header. Everything downstream reads that header, so the site's own number is what is reported.
  const odd = (code: number, body: string | null = null) =>
    new Response(body, { status: 599, headers: { [ORIGINAL_STATUS_HEADER]: String(code), 'content-type': 'text/html' } })

  it('is brought into range as the reply arrives, and ordinary replies are left alone', () => {
    const headers = { 'content-type': ['text/html'] }
    expect(mendReply({ statusLine: 'HTTP/1.1 200 OK', responseHeaders: headers })).toEqual({})
    expect(mendReply({ statusLine: 'HTTP/1.1 999 Request denied', responseHeaders: headers })).toEqual({
      statusLine: 'HTTP/1.1 599 Unusual Status',
      responseHeaders: { 'content-type': ['text/html'], [ORIGINAL_STATUS_HEADER]: ['999'] }
    })
  })

  it('drops headers the network stack cannot hold (a character above U+00FF), keeping the rest', () => {
    // A header holding "⛄" made building the reply throw: the lookup hung until it timed out.
    const mended = mendReply({
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'content-type': ['text/html'], 'x-weird': ['⛄ hi'], 'set-cookie': ['a=1', 'b=⛄'], 'x-latin': ['café'] }
    })
    expect(mended).toEqual({ responseHeaders: { 'content-type': ['text/html'], 'set-cookie': ['a=1'], 'x-latin': ['café'] } })
  })

  it('reads the real status back', () => {
    expect(statusOf(odd(999))).toBe(999)
    expect(statusOf(new Response(null, { status: 404 }))).toBe(404)
    expect(statusOf(new Response(null, { status: 200, headers: { [ORIGINAL_STATUS_HEADER]: 'nonsense' } }))).toBe(200)
  })

  it('is what a page lookup reports, and it reads nothing from the page', async () => {
    const fetchImpl = (async () => odd(999, '<title>Denied</title>')) as typeof fetch
    const result = await fetchMetadata('https://www.linkedin.com/in/someone', { fetchImpl })
    expect(result.status).toBe(999)
    expect(result.title).toBe('')
  })

  it('does not condemn the link when checking it', async () => {
    const fetchImpl = (async () => odd(999)) as typeof fetch
    expect(await attemptLink('https://www.linkedin.com/in/someone', { fetchImpl })).toEqual({
      kind: 'final',
      result: { status: 'ok', httpStatus: 999 } // the page is there, it just will not show itself to a program
    })
  })
})

describe('attemptLink', () => {
  const respond = (script: Record<string, { status: number; headers?: Record<string, string> }>) => {
    const methods: string[] = []
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = String(init?.method)
      methods.push(method)
      const r = script[method] ?? { status: 200 }
      return new Response(null, { status: r.status, headers: r.headers })
    }) as typeof fetch
    return { methods, fetchImpl }
  }

  it('is done after one HEAD when the page is fine', async () => {
    const { methods, fetchImpl } = respond({ HEAD: { status: 200 } })
    expect(await attemptLink('https://a.example', { fetchImpl })).toEqual({ kind: 'final', result: { status: 'ok', httpStatus: 200 } })
    expect(methods).toEqual(['HEAD'])
  })

  it('confirms a failed HEAD with a GET before calling a link broken', async () => {
    const { methods, fetchImpl } = respond({ HEAD: { status: 404 }, GET: { status: 200 } })
    expect(await attemptLink('https://a.example', { fetchImpl })).toEqual({ kind: 'final', result: { status: 'ok', httpStatus: 200 } })
    expect(methods).toEqual(['HEAD', 'GET'])

    const dead = respond({ HEAD: { status: 404 }, GET: { status: 404 } })
    expect(await attemptLink('https://a.example', { fetchImpl: dead.fetchImpl })).toEqual({
      kind: 'final',
      result: { status: 'broken', httpStatus: 404 }
    })
  })

  it('does not call pages that refuse bots broken', async () => {
    const { fetchImpl } = respond({ HEAD: { status: 403 }, GET: { status: 403 } })
    expect(await attemptLink('https://a.example', { fetchImpl })).toEqual({ kind: 'final', result: { status: 'ok', httpStatus: 403 } })
  })

  it('reports 429 as rate limiting, with Retry-After, and does not send a second request', async () => {
    const { methods, fetchImpl } = respond({ HEAD: { status: 429, headers: { 'retry-after': '30' } } })
    expect(await attemptLink('https://a.example', { fetchImpl })).toEqual({ kind: 'transient', httpStatus: 429, retryAfterMs: 30_000, rateLimited: true })
    expect(methods).toEqual(['HEAD'])
  })

  it('treats 503 as a slow-down signal and other 5xx as temporary faults', async () => {
    const busy = respond({ HEAD: { status: 503, headers: { 'retry-after': '5' } } })
    expect(await attemptLink('https://a.example', { fetchImpl: busy.fetchImpl })).toMatchObject({ kind: 'transient', rateLimited: true, retryAfterMs: 5000 })

    const fault = respond({ HEAD: { status: 502 }, GET: { status: 502 } })
    expect(await attemptLink('https://a.example', { fetchImpl: fault.fetchImpl })).toMatchObject({ kind: 'transient', httpStatus: 502, rateLimited: false })
  })

  it('reports connection-level failures with their cause instead of guessing "broken"', async () => {
    const fail = (error: unknown) => attemptLink('https://a.example', { fetchImpl: (async () => Promise.reject(error)) as typeof fetch })
    expect(await fail(networkError('ENOTFOUND'))).toEqual({ kind: 'network', failure: 'dns' })
    expect(await fail(networkError('ECONNREFUSED'))).toEqual({ kind: 'network', failure: 'refused' })
    expect(await fail(networkError('ECONNRESET'))).toEqual({ kind: 'network', failure: 'reset' })
    expect(await fail(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toEqual({ kind: 'network', failure: 'timeout' })
  })
})

describe('classifyHttpStatus', () => {
  it('leaves made-up statuses above 599 out of the retry loop', () => {
    expect(isTransientStatus(503)).toBe(true)
    expect(isTransientStatus(599)).toBe(true)
    expect(isTransientStatus(999)).toBe(false) // trying again will not change the site's mind
    expect(classifyHttpStatus(999)).toBe('ok')
  })

  it('classifies final statuses', () => {
    expect(classifyHttpStatus(200)).toBe('ok')
    expect(classifyHttpStatus(301)).toBe('ok')
    expect(classifyHttpStatus(401)).toBe('ok')
    expect(classifyHttpStatus(403)).toBe('ok')
    expect(classifyHttpStatus(404)).toBe('broken')
    expect(classifyHttpStatus(410)).toBe('broken')
  })
})

describe('probeConnectivity', () => {
  const answer = (status: number) => new Response(null, { status })
  /** Answers with the given status for the listed URLs and fails like an unreachable host for all others. */
  const fetchFor = (working: Record<string, number>, asked: string[] = []) =>
    (async (url: string | URL | Request) => {
      asked.push(String(url))
      const status = working[String(url)]
      if (status === undefined) throw networkError('ENOTFOUND')
      return answer(status)
    }) as typeof fetch

  it('is online if ANY target answers - even with an error status - while the others fail', async () => {
    const fetchImpl = fetchFor({ 'https://www.gstatic.com/generate_204': 500 })
    expect(await probeConnectivity(['https://recent.example/'], { fetchImpl })).toBe(true)
  })

  it('asks every target at once, including a well-known IP address that needs no DNS', async () => {
    const asked: string[] = []
    await probeConnectivity(['https://r1.example/', 'https://r2.example/', 'https://r3.example/'], { fetchImpl: fetchFor({}, asked) })
    expect(asked.sort()).toEqual(
      ['https://1.1.1.1/', 'https://r1.example/', 'https://r2.example/', 'https://www.gstatic.com/generate_204'].sort()
    ) // only the two most recent working sites are used
  })

  it('is not held up by a target that hangs: the first answer wins and stragglers are cancelled', async () => {
    let cancelled = false
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('slow')) {
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => ((cancelled = true), reject(new DOMException('aborted', 'AbortError'))))
        )
      }
      return answer(204)
    }) as typeof fetch
    const started = Date.now()
    expect(await probeConnectivity(['https://slow.example/'], { fetchImpl })).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(cancelled).toBe(true)
  })

  it('reports every target with the reason it failed when nothing answers', async () => {
    let report: ProbeResult[] = []
    const online = await probeConnectivity(['https://r1.example/'], { fetchImpl: fetchFor({}), onReport: (r) => (report = r) })
    expect(online).toBe(false)
    expect(report).toHaveLength(3)
    expect(report.every((r) => !r.ok && r.detail === 'dns (ENOTFOUND)')).toBe(true)
    expect(report.map((r) => r.url).sort()).toEqual(['https://1.1.1.1/', 'https://r1.example/', 'https://www.gstatic.com/generate_204'])
  })

  it('does not report when it succeeds, or when it was simply told to stop', async () => {
    const reports: ProbeResult[][] = []
    await probeConnectivity([], { fetchImpl: fetchFor({ 'https://1.1.1.1/': 301 }), onReport: (r) => reports.push(r) })
    const controller = new AbortController()
    controller.abort()
    expect(await probeConnectivity([], { signal: controller.signal, fetchImpl: fetchFor({}), onReport: (r) => reports.push(r) })).toBe(false)
    expect(reports).toEqual([])
  })
})

describe('runPool', () => {
  it('never exceeds the concurrency limit and processes everything', async () => {
    let running = 0
    let peak = 0
    const seen: number[] = []
    await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      seen.push(n)
      running--
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('stops picking up work after abort', async () => {
    const controller = new AbortController()
    const seen: number[] = []
    await runPool(
      [1, 2, 3, 4, 5],
      1,
      async (n) => {
        seen.push(n)
        if (n === 2) controller.abort()
      },
      controller.signal
    )
    expect(seen).toEqual([1, 2])
  })

  it('puts a deferred item back and keeps other items flowing meanwhile', async () => {
    const order: string[] = []
    let deferredOnce = false
    await runPool(['slow', 'b', 'c'], 2, async (item) => {
      order.push(item)
      if (item === 'slow' && !deferredOnce) {
        deferredOnce = true
        return { deferMs: 40 }
      }
    })
    expect(order.slice(0, 3)).toEqual(['slow', 'b', 'c'])
    expect(order.filter((x) => x === 'slow')).toHaveLength(2)
    expect(order.at(-1)).toBe('slow') // retried only after the others were done
  })

  it('does not finish early while another worker may still defer an item back', async () => {
    let attempts = 0
    await runPool(['only'], 4, async () => {
      attempts++
      if (attempts < 3) return { deferMs: 20 }
    })
    expect(attempts).toBe(3)
  })
})
