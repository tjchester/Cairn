import { z } from 'zod'
import defaultRules from './rules.json'
import { canon, tokenize } from './text'

// The built-in knowledge the engine starts with (see rules.json): well-known sites, URL patterns, file types,
// page types and a dictionary of common topics with their synonyms. None of it is tied to any one library.
// Users can layer their own rules over it (Settings > Auto-tagging > Custom rules).

export interface RuleSet {
  /** Site (and its subdomains) -> tags, e.g. "github.com": ["code"]. */
  domains: Record<string, string[]>
  /** Top-level domain -> tags, e.g. "edu": ["education"]. */
  tlds: Record<string, string[]>
  /** First label of the host, e.g. "docs" for docs.example.com. */
  hostPrefixes: Record<string, string[]>
  /** A URL path segment, e.g. "tutorials". */
  pathSegments: Record<string, string[]>
  /** File extension. */
  extensions: Record<string, string[]>
  /** og:type value (a trailing ".*" family such as "video.movie" also falls back to "video"). */
  ogTypes: Record<string, string[]>
  /** Tag -> phrases that indicate it (synonyms), matched as whole words in titles, descriptions and text. */
  topics: Record<string, string[]>
}

const list = z.array(z.string().min(1).max(60)).max(30)
const map = z.record(z.string().min(1).max(120), list)

export const userRulesSchema = z
  .object({
    domains: map.optional(),
    tlds: map.optional(),
    hostPrefixes: map.optional(),
    pathSegments: map.optional(),
    extensions: map.optional(),
    ogTypes: map.optional(),
    topics: map.optional()
  })
  .strict()

export type UserRulesResult = { ok: true; rules: Partial<RuleSet> } | { ok: false; error: string }

/** Parses and validates the custom-rules JSON from settings. Empty text means "no custom rules". */
export function parseUserRules(text: string): UserRulesResult {
  if (!text.trim()) return { ok: true, rules: {} }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: 'Not valid JSON: ' + (error instanceof Error ? error.message : String(error)) }
  }
  const parsed = userRulesSchema.safeParse(data)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue && issue.path.length ? issue.path.join('.') + ': ' : ''
    return { ok: false, error: where + (issue?.message ?? 'invalid rules') }
  }
  return { ok: true, rules: parsed.data }
}

export interface TopicEntry {
  tokens: string[]
  tag: string
}

export interface CompiledRules {
  domains: Map<string, string[]>
  tlds: Map<string, string[]>
  hostPrefixes: Map<string, string[]>
  pathSegments: Map<string, string[]>
  extensions: Map<string, string[]>
  ogTypes: Map<string, string[]>
  /** Topic phrases indexed by their first (loose-form) word for fast scanning. */
  topicIndex: Map<string, TopicEntry[]>
  /** Loose-form single-word synonyms per topic tag (e.g. javascript -> js), used to find the user's own spelling. */
  aliases: Map<string, string[]>
  /** Loose-form phrase -> topic tag (so a keyword such as "k8s" can be recognised as "kubernetes"). */
  phraseToTag: Map<string, string>
}

const lower = (s: string): string => s.trim().toLowerCase()

function toMap(record: Record<string, string[]> | undefined, key: (k: string) => string = lower): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [k, v] of Object.entries(record ?? {})) out.set(key(k), v)
  return out
}

/** Built-in rules with the user's custom ones layered on top (custom entries win; topics are merged). */
export function compileRules(user: Partial<RuleSet> = {}): CompiledRules {
  const base = defaultRules as unknown as RuleSet
  const domainKey = (k: string): string => lower(k).replace(/^www\./, '')
  const merge = (a: Record<string, string[]>, b: Record<string, string[]> | undefined): Record<string, string[]> => ({ ...a, ...(b ?? {}) })

  const topics: Record<string, string[]> = { ...base.topics }
  for (const [tag, phrases] of Object.entries(user.topics ?? {})) topics[tag] = [...new Set([...(topics[tag] ?? []), ...phrases])]

  const topicIndex = new Map<string, TopicEntry[]>()
  const aliases = new Map<string, string[]>()
  const phraseToTag = new Map<string, string>()
  for (const [tag, phrases] of Object.entries(topics)) {
    // The tag's own name counts as a phrase ("machine-learning" is also found as "machine learning").
    const all = [...new Set([tag.replace(/-/g, ' '), ...phrases])]
    const singles: string[] = []
    for (const phrase of all) {
      const tokens = tokenize(phrase).map(canon)
      const first = tokens[0]
      if (!first) continue
      const entries = topicIndex.get(first) ?? []
      entries.push({ tokens, tag })
      topicIndex.set(first, entries)
      phraseToTag.set(tokens.join(' '), tag)
      if (tokens.length === 1) singles.push(first)
    }
    aliases.set(canon(tag), [...new Set(singles)])
  }

  return {
    domains: toMap(merge(base.domains, user.domains), domainKey),
    tlds: toMap(merge(base.tlds, user.tlds)),
    hostPrefixes: toMap(merge(base.hostPrefixes, user.hostPrefixes)),
    pathSegments: toMap(merge(base.pathSegments, user.pathSegments)),
    extensions: toMap(merge(base.extensions, user.extensions)),
    ogTypes: toMap(merge(base.ogTypes, user.ogTypes)),
    topicIndex,
    aliases,
    phraseToTag
  }
}

/**
 * Finds topic phrases in text. Returns how many times each topic tag was found. Matching is on whole words
 * in their loose form, so "recipes" finds "recipe" and "Machine-Learning" finds "machine learning".
 */
export function findTopics(rules: CompiledRules, tokens: readonly string[]): Map<string, number> {
  const found = new Map<string, number>()
  for (let i = 0; i < tokens.length; i++) {
    const entries = rules.topicIndex.get(tokens[i] as string)
    if (!entries) continue
    let best: TopicEntry | undefined
    for (const entry of entries) {
      if (entry.tokens.length > tokens.length - i) continue
      let match = true
      for (let j = 1; j < entry.tokens.length; j++) {
        if (tokens[i + j] !== entry.tokens[j]) {
          match = false
          break
        }
      }
      // Prefer the longest phrase that matches at this position.
      if (match && (!best || entry.tokens.length > best.tokens.length)) best = entry
    }
    if (best) found.set(best.tag, (found.get(best.tag) ?? 0) + 1)
  }
  return found
}
