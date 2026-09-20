import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Aborted } from '../src/main/services/net'
import { chatJson, getVersion, listModels, OllamaError, validateBaseUrl } from '../src/main/tagging/ollama'

// A real HTTP server standing in for Ollama, so the client is tested over an actual socket.

interface Recorded {
  method: string
  url: string
  body: unknown
}

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections?.()
  for (const s of servers) s.close()
})

async function fakeOllama(handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void): Promise<{ baseUrl: string; requests: Recorded[] }> {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', body })
      handler(req, res, body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, requests }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('validateBaseUrl', () => {
  it('accepts this computer by default and normalises the address', () => {
    expect(validateBaseUrl('http://127.0.0.1:11434', false)).toEqual({ ok: true, url: 'http://127.0.0.1:11434', remote: false })
    expect(validateBaseUrl('  http://localhost:11434/  ', false)).toMatchObject({ ok: true, url: 'http://localhost:11434' })
    expect(validateBaseUrl('http://[::1]:11434', false)).toMatchObject({ ok: true, remote: false })
    expect(validateBaseUrl('http://127.0.0.5:1', false)).toMatchObject({ ok: true })
    expect(validateBaseUrl('http://ollama.localhost:11434', false)).toMatchObject({ ok: true })
  })

  it('refuses any other computer unless the user explicitly allows it', () => {
    for (const url of ['http://192.168.1.20:11434', 'http://my-server:11434', 'https://ollama.example.com', 'http://10.0.0.5:11434']) {
      const blocked = validateBaseUrl(url, false)
      expect(blocked.ok, url).toBe(false)
      expect(blocked.ok ? '' : blocked.error).toMatch(/not on this computer/)
      expect(validateBaseUrl(url, true), url).toMatchObject({ ok: true, remote: true })
    }
  })

  it('rejects malformed, non-web and credential-bearing addresses', () => {
    for (const url of ['', 'not a url', 'ftp://127.0.0.1', 'file:///etc/passwd', 'http://user:pass@127.0.0.1:11434', 'http://127.0.0.1:11434/?x=1', 'http://127.0.0.1:11434/#frag']) {
      expect(validateBaseUrl(url, true).ok, url).toBe(false)
    }
  })

  it('does not treat a look-alike host as this computer', () => {
    expect(validateBaseUrl('http://127.0.0.1.evil.example', false).ok).toBe(false)
    expect(validateBaseUrl('http://localhost.evil.example', false).ok).toBe(false)
  })
})

describe('Ollama client (over a real socket)', () => {
  it('reads the version and the installed models', async () => {
    const { baseUrl } = await fakeOllama((req, res) => {
      if (req.url === '/api/version') return json(res, 200, { version: '0.34.0' })
      if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen2.5:7b' }, { name: 'gemma3:12b' }] })
      json(res, 404, { error: 'nope' })
    })
    expect(await getVersion({ baseUrl })).toBe('0.34.0')
    expect(await listModels({ baseUrl })).toEqual(['gemma3:12b', 'qwen2.5:7b'])
  })

  it('asks for a schema-constrained, deterministic, non-streamed answer and returns the reply text', async () => {
    const schema = { type: 'object', properties: { tags: { type: 'array' } } }
    const { baseUrl, requests } = await fakeOllama((_req, res) => json(res, 200, { message: { role: 'assistant', content: '{"tags":["a"]}' } }))
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'usr' }
    ]
    expect(await chatJson({ baseUrl }, 'qwen2.5:7b', messages, schema)).toBe('{"tags":["a"]}')

    const sent = requests[0]?.body as Record<string, unknown>
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/chat' })
    expect(sent).toMatchObject({ model: 'qwen2.5:7b', stream: false, format: schema, messages })
    expect(sent['options']).toMatchObject({ temperature: 0 })
  })

  it('reports a missing model with a specific error', async () => {
    const { baseUrl } = await fakeOllama((_req, res) => json(res, 404, { error: 'model "nope" not found, try pulling it first' }))
    await expect(chatJson({ baseUrl }, 'nope', [], {})).rejects.toMatchObject({ name: 'OllamaError', kind: 'model-missing' })
  })

  it('reports other server errors with the server message', async () => {
    const { baseUrl } = await fakeOllama((_req, res) => json(res, 500, { error: 'out of memory' }))
    await expect(getVersion({ baseUrl })).rejects.toThrow(/out of memory/)
  })

  it('reports Ollama not running', async () => {
    const { baseUrl } = await fakeOllama(() => undefined)
    const port = new URL(baseUrl).port
    for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve)) // now nothing listens on that port
    await expect(getVersion({ baseUrl: 'http://127.0.0.1:' + port })).rejects.toMatchObject({ kind: 'unreachable' })
  })

  it('gives up after the timeout instead of hanging', async () => {
    const { baseUrl } = await fakeOllama(() => undefined) // never answers
    const started = Date.now()
    await expect(getVersion({ baseUrl, timeoutMs: 200 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('refuses to follow redirects to somewhere else', async () => {
    const { baseUrl } = await fakeOllama((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
      res.end()
    })
    await expect(getVersion({ baseUrl })).rejects.toBeInstanceOf(OllamaError)
  })

  it('rejects replies that are not JSON, or not shaped like Ollama', async () => {
    const garbage = await fakeOllama((_req, res) => {
      res.writeHead(200)
      res.end('<html>not ollama</html>')
    })
    await expect(getVersion({ baseUrl: garbage.baseUrl })).rejects.toMatchObject({ kind: 'bad-response' })

    const wrongShape = await fakeOllama((_req, res) => json(res, 200, { hello: 'world' }))
    await expect(getVersion({ baseUrl: wrongShape.baseUrl })).rejects.toMatchObject({ kind: 'bad-response' })
    await expect(chatJson({ baseUrl: wrongShape.baseUrl }, 'm', [], {})).rejects.toMatchObject({ kind: 'bad-response' })
  })

  it('stops when the caller aborts, distinguishing that from a timeout', async () => {
    const { baseUrl } = await fakeOllama(() => undefined)
    const controller = new AbortController()
    const pending = getVersion({ baseUrl, signal: controller.signal, timeoutMs: 10_000 })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toBeInstanceOf(Aborted)
  })
})
