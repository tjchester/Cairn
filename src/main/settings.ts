import { z } from 'zod'
import {
  DEFAULT_API,
  DEFAULT_SETTINGS,
  DEFAULT_TAGGING,
  type ApiSettings,
  type Settings,
  type SettingsPatch,
  type TaggingSettings
} from '@shared/types'
import { SCHEMES } from '@shared/themes'
import type { Repo } from './db/repo'
import { validateBaseUrl } from './tagging/ollama'
import { parseUserRules } from './tagging/rules'

// App settings live in the database as key -> string. Simple ones are stored as-is; the nested `tagging` and `api`
// blocks are stored as one JSON string each. This module reads, validates and merges them (no Electron, so it is
// unit-testable). Other keys in the table (such as the API's secret key) are never part of the settings object.

const sortKey = z.enum(['created', 'updated', 'title', 'domain'])
const direction = z.enum(['asc', 'desc'])

export const llmSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().max(300),
  model: z.string().max(200),
  allowRemote: z.boolean(),
  sendPageText: z.boolean(),
  instructions: z.string().max(2000)
})

export const taggingSchema = z.object({
  mode: z.enum(['off', 'suggest', 'auto']),
  maxTags: z.number().int().min(1).max(10),
  userRules: z.string().max(100_000),
  llm: llmSchema
})

const taggingPatchSchema = taggingSchema.omit({ llm: true }).partial().extend({ llm: llmSchema.partial().optional() })

/** Ports below 1024 need special rights on some systems, so they are not offered. */
export const apiSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535)
})

const apiPatchSchema = apiSchema.partial().strict()

const simpleSettings = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    scheme: z.string().max(40).refine((id) => SCHEMES.some((s) => s.id === id), 'Unknown colour scheme'),
    view: z.enum(['list', 'grid', 'headlines']),
    sort: sortKey,
    direction,
    sidebarWidth: z.number().int().min(180).max(480),
    collectionsOpen: z.boolean(),
    tagsOpen: z.boolean()
  })
  .partial()
  .strict()

const SIMPLE_KEYS = new Set(Object.keys(simpleSettings.shape))
// Everything is stored as text, so these come back as "260" and "false".
const NUMBER_KEYS = new Set(['sidebarWidth'])
const BOOLEAN_KEYS = new Set(['collectionsOpen', 'tagsOpen'])

export const settingsPatchSchema = simpleSettings.extend({ tagging: taggingPatchSchema.optional(), api: apiPatchSchema.optional() }).strict()

export function mergeTagging(base: TaggingSettings, patch: SettingsPatch['tagging'] | undefined): TaggingSettings {
  if (!patch) return base
  return { ...base, ...patch, llm: { ...base.llm, ...(patch.llm ?? {}) } } as TaggingSettings
}

function readJson<T>(raw: string | undefined, schema: z.ZodType<T>): T | null {
  if (!raw) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null // unreadable: fall back to the defaults
  }
}

export function readSettings(repo: Repo): Settings {
  const raw = repo.getSettingsRaw()
  const shape = simpleSettings.shape as Record<string, z.ZodType>
  const flat: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!SIMPLE_KEYS.has(key)) continue
    // One unreadable value falls back on its own, rather than taking every other setting down with it.
    const typed = NUMBER_KEYS.has(key) ? Number(value) : BOOLEAN_KEYS.has(key) ? value === 'true' : value
    const checked = shape[key]?.safeParse(typed)
    if (checked?.success) flat[key] = checked.data
  }
  const parsed = simpleSettings.safeParse(flat)

  const storedTagging = readJson(raw['tagging'], taggingPatchSchema)
  const tagging = storedTagging ? mergeTagging(DEFAULT_TAGGING, storedTagging) : DEFAULT_TAGGING
  const storedApi = readJson(raw['api'], apiPatchSchema)
  const api: ApiSettings = { ...DEFAULT_API, ...(storedApi ?? {}) }

  return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}), tagging, api }
}

/** Saves a settings patch and returns the resulting settings. Throws with a readable message if it is invalid. */
export function applySettingsPatch(repo: Repo, patch: SettingsPatch): Settings {
  const { tagging, api, ...simple } = patch
  if (tagging) {
    const next = mergeTagging(readSettings(repo).tagging, tagging)
    const rules = parseUserRules(next.userRules)
    if (!rules.ok) throw new Error('Custom rules: ' + rules.error)
    const address = validateBaseUrl(next.llm.baseUrl, next.llm.allowRemote)
    if (!address.ok) throw new Error('Ollama address: ' + address.error)
    repo.setSettingRaw('tagging', JSON.stringify(taggingSchema.parse(next)))
  }
  if (api) {
    const next = apiSchema.safeParse({ ...readSettings(repo).api, ...api })
    if (!next.success) throw new Error('The port must be a number between 1024 and 65535.')
    repo.setSettingRaw('api', JSON.stringify(next.data))
  }
  const checked = simpleSettings.safeParse(simple)
  if (!checked.success) throw new Error('That setting is not one Cairn knows: ' + (checked.error.issues[0]?.path.join('.') ?? 'unknown'))
  for (const [key, value] of Object.entries(checked.data)) repo.setSettingRaw(key, String(value))
  return readSettings(repo)
}
