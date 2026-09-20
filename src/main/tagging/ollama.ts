import { z } from 'zod'
import { Aborted } from '../services/net'

// A small client for Ollama's HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md).
// Requests are made from the main process only, to the address the user configured.

export type OllamaErrorKind = 'invalid-address' | 'unreachable' | 'timeout' | 'model-missing' | 'bad-response' | 'http'

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i

export type AddressCheck = { ok: true; url: string; remote: boolean } | { ok: false; error: string }

/**
 * Checks and normalises the Ollama address. Anything that is not this computer needs explicit consent
 * (`allowRemote`), because bookmark titles, links and descriptions are sent to it.
 */
export function validateBaseUrl(raw: string, allowRemote: boolean): AddressCheck {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'Enter a full address such as http://127.0.0.1:11434' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://' }
  if (url.username || url.password) return { ok: false, error: 'Do not put a user name or password in the address.' }
  if (url.search || url.hash) return { ok: false, error: 'Remove the ? and # parts of the address.' }
  const loopback = LOOPBACK.test(url.hostname) || url.hostname.endsWith('.localhost')
  if (!loopback && !allowRemote) {
    return {
      ok: false,
      error:
        'That address is not on this computer. Tick "Allow a server on another computer" to use it; your bookmarks\' titles, links and descriptions would then be sent to it.'
    }
  }
  return { ok: true, url: url.origin + url.pathname.replace(/\/+$/, ''), remote: !loopback }
}

export interface OllamaRequest {
  baseUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

const MAX_RESPONSE_CHARS = 1_000_000

async function call(options: OllamaRequest, path: string, init: RequestInit = {}): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout

  let response: Response
  try {
    response = await doFetch(options.baseUrl + path, {
      ...init,
      signal,
      redirect: 'error', // never let the server bounce us somewhere else
      headers: { 'content-type': 'application/json', accept: 'application/json' }
    })
  } catch (error) {
    if (options.signal?.aborted) throw new Aborted()
    const name = (error as { name?: string } | null)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new OllamaError('timeout', 'Ollama did not answer in time. A large model can be slow on the first request; try again.')
    }
    throw new OllamaError('unreachable', 'Could not reach Ollama at ' + options.baseUrl + '. Is it running?')
  }

  const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const message = (body as { error?: unknown } | undefined)?.error
    const detail = typeof message === 'string' ? message : 'HTTP ' + response.status
    if (response.status === 404 && /model/i.test(detail)) throw new OllamaError('model-missing', detail)
    throw new OllamaError('http', 'Ollama reported an error: ' + detail)
  }
  if (body === undefined) throw new OllamaError('bad-response', 'Ollama sent a reply that could not be read.')
  return body
}

const versionSchema = z.object({ version: z.string() })
const tagsSchema = z.object({ models: z.array(z.object({ name: z.string() })).default([]) })
const chatSchema = z.object({ message: z.object({ content: z.string() }) })

export async function getVersion(options: OllamaRequest): Promise<string> {
  const parsed = versionSchema.safeParse(await call(options, '/api/version'))
  if (!parsed.success) throw new OllamaError('bad-response', 'That address did not answer like Ollama.')
  return parsed.data.version
}

/** Names of the models installed in Ollama. */
export async function listModels(options: OllamaRequest): Promise<string[]> {
  const parsed = tagsSchema.safeParse(await call(options, '/api/tags'))
  if (!parsed.success) throw new OllamaError('bad-response', 'That address did not answer like Ollama.')
  return parsed.data.models.map((m) => m.name).sort((a, b) => a.localeCompare(b))
}

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * Asks the model for a JSON answer that matches `schema` (Ollama's structured outputs constrain generation to it).
 * Temperature 0 keeps the answer stable. Returns the model's raw text for the caller to validate.
 */
export async function chatJson(options: OllamaRequest, model: string, messages: ChatMessage[], schema: object): Promise<string> {
  const body = {
    model,
    messages,
    stream: false,
    format: schema,
    options: { temperature: 0, num_predict: 200 },
    keep_alive: '10m'
  }
  const parsed = chatSchema.safeParse(await call(options, '/api/chat', { method: 'POST', body: JSON.stringify(body) }))
  if (!parsed.success) throw new OllamaError('bad-response', 'Ollama sent a reply that could not be read.')
  return parsed.data.message.content
}
