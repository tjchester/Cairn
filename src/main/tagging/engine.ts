import type { PageSignals, SuggestionSource, TagSuggestion } from '@shared/types'
import { findTopics, type CompiledRules } from './rules'
import { canon, GENERIC_TAGS, STOPWORDS, tokenize, WORKFLOW_TAGS, wordCount } from './text'
import type { Vocabulary } from './vocabulary'

// The built-in tagger. Every signal proposes candidate tags with a confidence; the merge step maps them onto the
// user's existing tags, combines the evidence, and keeps the best few. The same merge is used for the optional
// LLM's answers, so its suggestions get the same treatment (existing spelling reused, blocklist applied, ...).

export interface EngineInput {
  url: string
  title: string
  excerpt: string
  signals?: PageSignals | null
  /** Tags the bookmark already has (never suggested again). */
  tags?: readonly string[]
}

export interface EngineContext {
  vocabulary: Vocabulary
  rules: CompiledRules
  /** Loose forms (see canon) of tags that must never be suggested. */
  blocked: ReadonlySet<string>
  maxTags: number
  /** Suggestions below this confidence are dropped (default 0.45). */
  minScore?: number
}

export interface Candidate {
  tag: string
  score: number
  source: SuggestionSource
  reason: string
  /** Trusted candidates (rules, dictionary, the user's own tags, the LLM) skip the "too generic" filter. */
  trusted: boolean
  /** Loose-form synonyms that identify the same tag in the user's library (e.g. js for javascript). */
  aliases?: readonly string[]
}

const DEFAULT_MIN_SCORE = 0.45
const MAX_TEXT_CHARS = 1500

/** Weights: how much a match in each part of the page is worth. */
const ZONES = {
  title: { label: 'title', topic: 0.65, vocab: 0.65 },
  description: { label: 'description', topic: 0.5, vocab: 0.45 },
  text: { label: 'page text', topic: 0.3, vocab: 0.28 }
} as const

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function fromUrl(input: EngineInput, rules: CompiledRules, out: Candidate[]): void {
  let url: URL
  try {
    url = new URL(input.url)
  } catch {
    return
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const labels = host.split('.')

  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join('.')
    const tags = rules.domains.get(suffix)
    if (tags) {
      for (const tag of tags) out.push({ tag, score: 0.7, source: 'domain', reason: 'Site: ' + suffix, trusted: true })
      break
    }
  }
  const tld = labels[labels.length - 1] ?? ''
  for (const tag of rules.tlds.get(tld) ?? []) out.push({ tag, score: 0.55, source: 'domain', reason: 'Domain ends in .' + tld, trusted: true })
  if (labels.length > 2) {
    for (const tag of rules.hostPrefixes.get(labels[0] as string) ?? []) {
      out.push({ tag, score: 0.5, source: 'domain', reason: 'Subdomain "' + labels[0] + '"', trusted: true })
    }
  }

  const segments = url.pathname
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .slice(0, 6)
    .map(safeDecode)
  segments.forEach((segment, index) => {
    for (const tag of rules.pathSegments.get(segment) ?? []) {
      out.push({ tag, score: 0.5, source: 'path', reason: 'Path contains "' + segment + '"', trusted: true })
    }
    if (index === segments.length - 1) {
      const ext = /\.([a-z0-9]{2,5})$/.exec(segment)?.[1]
      for (const tag of ext ? (rules.extensions.get(ext) ?? []) : []) {
        out.push({ tag, score: 0.75, source: 'file-type', reason: 'File type .' + ext, trusted: true })
      }
    }
  })
}

function fromSignals(input: EngineInput, ctx: EngineContext, out: Candidate[]): void {
  const signals = input.signals
  if (!signals) return
  const { rules, vocabulary } = ctx

  if (signals.ogType) {
    const family = signals.ogType.split('.')[0] as string
    const tags = rules.ogTypes.get(signals.ogType) ?? rules.ogTypes.get(family) ?? []
    for (const tag of tags) out.push({ tag, score: 0.5, source: 'page-type', reason: 'Page type: ' + signals.ogType, trusted: true })
  }

  // Keywords the page's author supplied. They are only trusted when they mean something we recognise (a known topic
  // or one of the user's tags); anything else must also show up in the title or description to count.
  const visible = new Set([...tokenize(input.title), ...tokenize(input.excerpt)].map(canon))
  const keywords = [...signals.keywords, ...(signals.section ? [signals.section] : [])]
  keywords.forEach((keyword, index) => {
    const phrase = keyword.trim()
    if (!phrase || wordCount(phrase) > 3) return
    const key = tokenize(phrase).map(canon).join(' ')
    const topic = rules.phraseToTag.get(key)
    const known = vocabulary.lookup(canon(phrase))
    const reason = 'Page keyword "' + phrase + '"'
    if (topic) {
      out.push({ tag: topic, score: 0.75, source: 'metadata', reason, trusted: true, aliases: rules.aliases.get(canon(topic)) })
    } else if (known) {
      out.push({ tag: known.name, score: 0.7, source: 'metadata', reason: reason + ' (a tag you use)', trusted: true })
    } else if (index < 8 && wordCount(phrase) <= 2 && tokenize(phrase).every((word) => visible.has(canon(word)))) {
      out.push({ tag: phrase, score: 0.55, source: 'metadata', reason: reason + ', also in the title or description', trusted: false })
    }
  })
}

function fromText(input: EngineInput, ctx: EngineContext, out: Candidate[]): void {
  const { rules, vocabulary } = ctx
  const zones: { zone: (typeof ZONES)[keyof typeof ZONES]; text: string }[] = [
    { zone: ZONES.title, text: input.title },
    { zone: ZONES.description, text: input.excerpt },
    { zone: ZONES.text, text: (input.signals?.text ?? '').slice(0, MAX_TEXT_CHARS) }
  ]
  const entries = vocabulary.entries()

  for (const { zone, text } of zones) {
    if (!text.trim()) continue
    const tokens = tokenize(text).map(canon)

    // Known topics (the built-in dictionary).
    for (const [tag, count] of findTopics(rules, tokens)) {
      const bonus = zone === ZONES.text ? Math.min(0.15, (count - 1) * 0.05) : 0
      out.push({
        tag,
        score: zone.topic + bonus,
        source: 'topic',
        reason: 'Mentions "' + tag.replace(/-/g, ' ') + '" in the ' + zone.label,
        trusted: true,
        aliases: rules.aliases.get(canon(tag))
      })
    }

    // The user's own tags, found as whole words or short phrases.
    if (entries.length === 0) continue
    const seen = new Set<string>()
    for (let i = 0; i < tokens.length; i++) {
      for (let n = 1; n <= 3 && i + n <= tokens.length; n++) {
        const key = tokens.slice(i, i + n).join('')
        const hit = vocabulary.lookup(key)
        if (!hit || seen.has(hit.canon)) continue
        const word = hit.canon
        const short = word.length < 3 && !/[+#]/.test(word)
        if (short || STOPWORDS.has(word) || WORKFLOW_TAGS.has(word)) continue
        seen.add(hit.canon)
        out.push({ tag: hit.name, score: zone.vocab, source: 'vocabulary', reason: 'Your tag "' + hit.name + '" appears in the ' + zone.label, trusted: true })
      }
    }
  }
}

/** Every candidate the built-in signals propose for this bookmark (before merging). */
export function collectCandidates(input: EngineInput, ctx: EngineContext): Candidate[] {
  const out: Candidate[] = []
  fromUrl(input, ctx.rules, out)
  fromSignals(input, ctx, out)
  fromText(input, ctx, out)
  return out
}

/**
 * Combines candidates (from any source) into the final suggestions: each is mapped onto the library's own tag when
 * one exists, evidence for the same tag is combined, blocked and already-present tags are dropped, and only the
 * best few are kept.
 */
export function mergeCandidates(candidates: readonly Candidate[], input: EngineInput, ctx: EngineContext): TagSuggestion[] {
  const present = new Set((input.tags ?? []).map(canon))
  const groups = new Map<string, { display: string; existing: boolean; parts: Candidate[] }>()

  for (const candidate of candidates) {
    const aliases = candidate.aliases ?? ctx.rules.aliases.get(canon(candidate.tag)) ?? []
    const resolved = ctx.vocabulary.resolve(candidate.tag, aliases)
    if (!resolved) continue
    // The model must not make up vague tags ("system", "service"); ones the library already has are fine.
    if (candidate.source === 'llm' && !resolved.existing && GENERIC_TAGS.has(canon(resolved.name))) continue
    const key = canon(resolved.name)
    if (!key || present.has(key) || ctx.blocked.has(key) || WORKFLOW_TAGS.has(key)) continue
    if (!candidate.trusted && STOPWORDS.has(key)) continue
    const group = groups.get(key)
    if (group) group.parts.push(candidate)
    else groups.set(key, { display: resolved.name, existing: resolved.existing, parts: [candidate] })
  }

  const min = ctx.minScore ?? DEFAULT_MIN_SCORE
  const suggestions: TagSuggestion[] = []
  for (const group of groups.values()) {
    // Independent pieces of evidence reinforce each other: 0.6 and 0.5 together are 0.8, not more than 1.
    let score = 1 - group.parts.reduce((left, part) => left * (1 - Math.min(0.99, part.score)), 1)
    if (group.existing) score = Math.min(0.95, score + 0.1) // prefer tags the library already uses
    score = Math.round(score * 1000) / 1000 // avoid float noise deciding borderline cases
    if (score < min) continue
    const sources = [...new Set(group.parts.map((p) => p.source))]
    const strongest = [...group.parts].sort((a, b) => b.score - a.score)
    suggestions.push({
      tag: group.display,
      score: Math.round(score * 100) / 100,
      origin: sources.includes('llm') ? 'llm' : 'builtin',
      sources,
      reasons: [...new Set(strongest.map((p) => p.reason))].slice(0, 3),
      existing: group.existing
    })
  }
  suggestions.sort((a, b) => b.score - a.score || Number(b.existing) - Number(a.existing) || a.tag.localeCompare(b.tag))
  return suggestions.slice(0, ctx.maxTags)
}

/** Suggests tags for a bookmark using only the built-in signals. */
export function suggestTags(input: EngineInput, ctx: EngineContext): TagSuggestion[] {
  return mergeCandidates(collectCandidates(input, ctx), input, ctx)
}
