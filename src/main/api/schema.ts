import { z } from 'zod'
import { coerceUrl } from '@shared/url'
import { ApiError } from './errors'

// What a caller may say when it adds a bookmark: everything the "New bookmark" dialog asks for, plus what to do
// afterwards. Only `url` is required. The same shape is used by the JSON endpoint and the bookmarklet's query string.

const text = (max: number) => z.string().max(max)

export const captureSchema = z
  .object({
    url: z.string().min(1).max(4096),
    title: text(2000).optional(),
    note: text(50_000).optional(),
    description: text(10_000).optional(),
    /** A collection by name, or a path such as "Work/Reading". It must already exist. */
    collection: text(500).optional(),
    collectionId: z.number().int().positive().optional(),
    tags: z.array(text(200)).max(200).optional(),
    favorite: z.boolean().optional(),
    coverUrl: text(4096).nullish(),
    faviconUrl: text(4096).nullish(),
    /** Look up the page's title, description, cover image and icon (default: yes). */
    fetch: z.boolean().optional(),
    /** Override the tagging mode for this bookmark (default: the mode in Settings). */
    autoTag: z.enum(['off', 'suggest', 'auto']).optional(),
    /** Use the local model for tag suggestions if it is set up (default: yes). */
    useLlm: z.boolean().optional(),
    onDuplicate: z.enum(['skip', 'merge']).optional(),
    /** JSON endpoint only: seconds to wait for details and tags before answering. */
    wait: z.number().int().min(0).max(30).optional()
  })
  .strict()
  .refine((v) => v.collection === undefined || v.collectionId === undefined, {
    message: 'Use either "collection" or "collectionId", not both.'
  })

export type CaptureBody = z.infer<typeof captureSchema>

/** A validated request with every default filled in. */
export interface CaptureRequest {
  url: string
  title?: string
  note?: string
  description?: string
  collection?: string
  collectionId?: number
  tags: string[]
  favorite: boolean
  coverUrl?: string | null
  faviconUrl?: string | null
  fetch: boolean
  autoTag?: 'off' | 'suggest' | 'auto'
  useLlm: boolean
  onDuplicate: 'skip' | 'merge'
  wait: number
}

const BOOLEAN_TRUE = new Set(['1', 'true', 'yes', 'on'])
const BOOLEAN_FALSE = new Set(['0', 'false', 'no', 'off'])

function flag(value: string): boolean | string {
  const v = value.trim().toLowerCase()
  return BOOLEAN_TRUE.has(v) ? true : BOOLEAN_FALSE.has(v) ? false : value
}

/** Turns the bookmarklet's query string into the same object the JSON endpoint accepts. Unknown parameters are ignored. */
export function queryToBody(params: URLSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of ['url', 'title', 'note', 'description', 'collection', 'coverUrl', 'faviconUrl', 'autoTag', 'onDuplicate'] as const) {
    const value = params.get(key)
    if (value !== null && value !== '') body[key] = value
  }
  for (const key of ['favorite', 'fetch', 'useLlm'] as const) {
    const value = params.get(key)
    if (value !== null && value !== '') body[key] = flag(value)
  }
  const collectionId = params.get('collectionId')
  if (collectionId) body['collectionId'] = /^\d+$/.test(collectionId) ? Number(collectionId) : collectionId
  const tags = [...params.getAll('tags'), ...params.getAll('tag')]
    .flatMap((value) => value.split(','))
    .map((tag) => tag.trim())
    .filter(Boolean)
  if (tags.length > 0) body['tags'] = tags
  return body
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'The request is not valid.'
  if (issue.code === 'unrecognized_keys') return 'Unknown field: ' + issue.keys.map((k) => '"' + k + '"').join(', ') + '.'
  const field = issue.path.join('.')
  return field ? '"' + field + '": ' + issue.message : issue.message
}

/** Validates a body from either source and fills in defaults. Throws an ApiError (400) that says what is wrong. */
export function parseCapture(input: unknown): CaptureRequest {
  const parsed = captureSchema.safeParse(input)
  if (!parsed.success) throw new ApiError(400, 'invalid-request', describeIssue(parsed.error))
  const body = parsed.data
  let url: string
  try {
    url = coerceUrl(body.url)
  } catch (error) {
    throw new ApiError(400, 'invalid-url', error instanceof Error ? error.message : 'That does not look like a valid URL')
  }
  return {
    url,
    title: body.title,
    note: body.note,
    description: body.description,
    collection: body.collection,
    collectionId: body.collectionId,
    tags: body.tags ?? [],
    favorite: body.favorite ?? false,
    coverUrl: body.coverUrl,
    faviconUrl: body.faviconUrl,
    fetch: body.fetch ?? true,
    autoTag: body.autoTag,
    useLlm: body.useLlm ?? true,
    onDuplicate: body.onDuplicate ?? 'skip',
    wait: body.wait ?? 0
  }
}
