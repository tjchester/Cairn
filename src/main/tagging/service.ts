import type { SuggestResult, TagSuggestion, TaggingMode, TaggingSettings, TaggingTarget } from '@shared/types'
import type { Repo, TaggingCandidate } from '../db/repo'
import { suggestTags, type EngineContext, type EngineInput } from './engine'
import { compileRules, parseUserRules, type CompiledRules } from './rules'
import { canon } from './text'
import { Vocabulary } from './vocabulary'

/** Connects the engine to the library (existing tags, blocked tags, stored page signals) and to the settings. */
export class TaggingService {
  private rulesCache: { text: string; compiled: CompiledRules } | null = null

  constructor(
    private readonly repo: Repo,
    private readonly settings: () => TaggingSettings
  ) {}

  /** Built-in rules plus the user's custom ones (cached until the custom rules change; invalid ones are ignored). */
  rules(): CompiledRules {
    const text = this.settings().userRules
    if (this.rulesCache?.text === text) return this.rulesCache.compiled
    const parsed = parseUserRules(text)
    const compiled = compileRules(parsed.ok ? parsed.rules : {})
    this.rulesCache = { text, compiled }
    return compiled
  }

  /** Everything the engine needs, built from the current state of the library. Build it once per batch. */
  context(): EngineContext {
    return {
      vocabulary: new Vocabulary(this.repo.listTags()),
      rules: this.rules(),
      blocked: new Set(this.repo.blockedTags().map(canon)),
      maxTags: this.settings().maxTags
    }
  }

  inputFor(target: TaggingTarget): EngineInput | null {
    if ('bookmarkId' in target) {
      const candidate = this.repo.getTaggingCandidate(target.bookmarkId)
      return candidate && { url: candidate.url, title: candidate.title, excerpt: candidate.excerpt, signals: candidate.signals, tags: candidate.tags }
    }
    const { url, title, excerpt, signals, tags } = target.draft
    return { url, title, excerpt, signals: signals ?? null, tags: tags ?? [] }
  }

  /** Built-in suggestions only: instant, offline. */
  suggest(target: TaggingTarget, context: EngineContext = this.context()): TagSuggestion[] {
    if (this.settings().mode === 'off') return []
    const input = this.inputFor(target)
    return input ? suggestTags(input, context) : []
  }

  mode(): TaggingMode {
    return this.settings().mode
  }

  /** Built-in suggestions for a bookmark that has already been loaded (used by bulk jobs). */
  suggestForCandidate(candidate: TaggingCandidate, context: EngineContext): TagSuggestion[] {
    return suggestTags(
      { url: candidate.url, title: candidate.title, excerpt: candidate.excerpt, signals: candidate.signals, tags: candidate.tags },
      context
    )
  }

  /**
   * Hands suggestions over according to the mode: "auto" adds them as automatic tags (undoable via the run),
   * "suggest" queues them for review. Anything the user already rejected for this bookmark is skipped.
   */
  deliver(bookmarkId: number, suggestions: readonly TagSuggestion[], mode: 'suggest' | 'auto', runId: number): { added: number; proposed: number } {
    const rejected = this.repo.rejectedProposalTags(bookmarkId)
    const fresh = suggestions.filter((s) => !rejected.has(s.tag.toLowerCase()))
    if (fresh.length === 0) return { added: 0, proposed: 0 }
    if (mode === 'auto') {
      let added = 0
      for (const origin of ['builtin', 'llm'] as const) {
        const tags = fresh.filter((s) => s.origin === origin).map((s) => s.tag)
        if (tags.length > 0) added += this.repo.addAutoTags(bookmarkId, tags, origin, runId).length
      }
      return { added, proposed: 0 }
    }
    const proposed = this.repo.addProposals(
      runId,
      bookmarkId,
      fresh.map((s) => ({ tag: s.tag, score: s.score, origin: s.origin, reason: s.reasons[0] ?? '' }))
    )
    return { added: 0, proposed }
  }

  async suggestResult(target: TaggingTarget, _withLlm: boolean): Promise<SuggestResult> {
    return { suggestions: this.suggest(target), llm: 'off' }
  }
}
