import { z } from 'zod'
import { DEFAULT_SETTINGS, DEFAULT_TAGGING, type Settings, type SettingsPatch, type TaggingSettings } from '@shared/types'
import type { Repo } from './db/repo'
import { parseUserRules } from './tagging/rules'

// App settings live in the database as key -> string. Simple ones are stored as-is; the nested `tagging` block is
// stored as one JSON string. This module reads, validates and merges them (no Electron, so it is unit-testable).

const sortKey = z.enum(['created', 'updated', 'title', 'domain'])
const direction = z.enum(['asc', 'desc'])

const llmSchema = z.object({
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

const simpleSettings = z
  .object({
    theme: z.enum(['system', 'light', 'dark']),
    view: z.enum(['list', 'grid', 'headlines']),
    sort: sortKey,
    direction,
    sidebarWidth: z.number().int().min(180).max(480)
  })
  .partial()
  .strict()

export const settingsPatchSchema = simpleSettings.extend({ tagging: taggingPatchSchema.optional() }).strict()

export function mergeTagging(base: TaggingSettings, patch: SettingsPatch['tagging'] | undefined): TaggingSettings {
  if (!patch) return base
  return { ...base, ...patch, llm: { ...base.llm, ...(patch.llm ?? {}) } } as TaggingSettings
}

export function readSettings(repo: Repo): Settings {
  const raw = repo.getSettingsRaw()
  const flat: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  delete flat['tagging']
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'tagging') continue
    flat[key] = key === 'sidebarWidth' ? Number(value) : value
  }
  const parsed = simpleSettings.safeParse(flat)

  let tagging = DEFAULT_TAGGING
  if (raw['tagging']) {
    try {
      const stored = taggingPatchSchema.safeParse(JSON.parse(raw['tagging']))
      if (stored.success) tagging = mergeTagging(DEFAULT_TAGGING, stored.data)
    } catch {
      // unreadable: fall back to the defaults
    }
  }
  return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}), tagging }
}

/** Saves a settings patch and returns the resulting settings. Throws with a readable message if it is invalid. */
export function applySettingsPatch(repo: Repo, patch: SettingsPatch): Settings {
  const { tagging, ...simple } = patch
  if (tagging) {
    const next = mergeTagging(readSettings(repo).tagging, tagging)
    const rules = parseUserRules(next.userRules)
    if (!rules.ok) throw new Error('Custom rules: ' + rules.error)
    repo.setSettingRaw('tagging', JSON.stringify(taggingSchema.parse(next)))
  }
  for (const [key, value] of Object.entries(simple)) repo.setSettingRaw(key, String(value))
  return readSettings(repo)
}
