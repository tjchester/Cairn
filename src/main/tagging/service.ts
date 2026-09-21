import type { LlmSettings, OllamaStatus, SuggestResult, TagSuggestion, TaggingMode, TaggingSettings, TaggingTarget } from '@shared/types'
import type { Repo, TaggingCandidate } from '../db/repo'
import { collectCandidates, mergeCandidates, suggestTags, type Candidate, type EngineContext, type EngineInput } from './engine'
import { LlmSkipped, looksLikeInjection, OllamaClient, type LlmClient, type LlmInput } from './llm'
import { compileRules, parseUserRules, type CompiledRules } from './rules'
import { canon } from './text'
import { Vocabulary } from './vocabulary'

/** Connects the engine to the library (existing tags, blocked tags, stored page signals), the settings and, optionally, a local model. */
export class TaggingService {
  private rulesCache: { text: string; compiled: CompiledRules } | null = null

  constructor(
    private readonly repo: Repo,
    private readonly settings: () => TaggingSettings,
    private readonly llm: LlmClient = new OllamaClient()
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

  mode(): TaggingMode {
    return this.settings().mode
  }

  inputFor(target: TaggingTarget): EngineInput | null {
    if ('bookmarkId' in target) {
      const candidate = this.repo.getTaggingCandidate(target.bookmarkId)
      return candidate && { url: candidate.url, title: candidate.title, excerpt: candidate.excerpt, signals: candidate.signals, tags: candidate.tags }
    }
    const { url, title, excerpt, signals, tags } = target.draft
    return { url, title, excerpt, signals: signals ?? null, tags: tags ?? [] }
  }

  private inputForCandidate(candidate: TaggingCandidate): EngineInput {
    return { url: candidate.url, title: candidate.title, excerpt: candidate.excerpt, signals: candidate.signals, tags: candidate.tags }
  }

  /** Built-in suggestions only: instant, offline. */
  suggest(target: TaggingTarget, context: EngineContext = this.context()): TagSuggestion[] {
    if (this.settings().mode === 'off') return []
    const input = this.inputFor(target)
    return input ? suggestTags(input, context) : []
  }

  /** Built-in suggestions for a bookmark that has already been loaded (used by bulk jobs). */
  suggestForCandidate(candidate: TaggingCandidate, context: EngineContext): TagSuggestion[] {
    return suggestTags(this.inputForCandidate(candidate), context)
  }

  // ------------------------------------------------------------ local model

  /** True when the user turned the local model on and picked a model. */
  llmEnabled(): boolean {
    const s = this.settings()
    return s.mode !== 'off' && s.llm.enabled && s.llm.model.trim() !== ''
  }

  private llmInput(input: EngineInput, context: EngineContext): LlmInput {
    const llm = this.settings().llm
    const gist = input.title + ' ' + input.excerpt + ' ' + (input.signals?.keywords.join(' ') ?? '')
    return {
      url: input.url,
      title: input.title,
      excerpt: input.excerpt,
      // Page text only leaves the app if the user opted in; private notes are never part of the input at all.
      pageText: llm.sendPageText ? (input.signals?.text ?? '') : '',
      vocabulary: context.vocabulary.relevant(gist, 80),
      instructions: llm.instructions,
      maxTags: context.maxTags
    }
  }

  /**
   * Built-in and local-model suggestions merged: the model's tags go through the same mapping onto your existing
   * tags, blocklist and limits, and tags both agree on rank higher. Throws if the model cannot be used.
   */
  async suggestWithLlm(input: EngineInput, context: EngineContext, signal?: AbortSignal): Promise<TagSuggestion[]> {
    const prepared = this.llmInput(input, context)
    if (looksLikeInjection([prepared.title, prepared.excerpt, prepared.pageText, prepared.url].join('\n'))) {
      throw new LlmSkipped('The local model was not used for this page: its text looks like it is trying to give the model instructions.')
    }
    const tags = await this.llm.suggest(prepared, this.settings().llm, signal)
    const fromModel: Candidate[] = tags.map((tag, index) => ({
      tag,
      score: Math.max(0.55, 0.75 - index * 0.05),
      source: 'llm',
      reason: 'Suggested by the local model',
      trusted: true
    }))
    return mergeCandidates([...collectCandidates(input, context), ...fromModel], input, context)
  }

  /** Like suggestWithLlm for a saved bookmark; on success the bookmark is recorded as classified by the model. */
  async suggestForCandidateWithLlm(candidate: TaggingCandidate, context: EngineContext, signal?: AbortSignal): Promise<TagSuggestion[]> {
    const suggestions = await this.suggestWithLlm(this.inputForCandidate(candidate), context, signal)
    this.repo.markLlmSeen(candidate.id, this.settings().llm.model)
    return suggestions
  }

  /** How many bookmarks the model has classified so far (so a long run's place is visible). */
  llmProgress(): { seen: number; total: number } {
    return this.repo.llmProgress()
  }

  /** Checks the connection and the chosen model. `overrides` lets Settings test values that are not saved yet. */
  llmStatus(overrides: Partial<LlmSettings> = {}): Promise<OllamaStatus> {
    return this.llm.status({ ...this.settings().llm, ...overrides })
  }

  async suggestResult(target: TaggingTarget, withLlm: boolean): Promise<SuggestResult> {
    const input = this.inputFor(target)
    if (!input || this.settings().mode === 'off') return { suggestions: [], llm: 'off' }
    const context = this.context()
    if (!withLlm || !this.llmEnabled()) return { suggestions: suggestTags(input, context), llm: 'off' }
    try {
      return { suggestions: await this.suggestWithLlm(input, context), llm: 'used' }
    } catch (error) {
      // The built-in answer is still useful; say why the model did not contribute.
      return { suggestions: suggestTags(input, context), llm: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
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
}
