import { canon, styleNewTag, tokenize, variantKey } from './text'

export interface VocabularyEntry {
  name: string
  count: number
  canon: string
}

/**
 * The tags already in the library. The engine uses it to reuse the user's own spelling ("JS" rather than a new
 * "javascript") and to prefer tags that exist over inventing new ones, which keeps the tag list from sprawling.
 *
 * It is kept up to date while a bulk run goes on (`add`), so a tag the run has just created is what the rest of the
 * run reuses instead of inventing "ad-blockers" after "ad-blocker". Tag ideas that were held back because only one
 * bookmark wanted them so far (`noteHeld`) are remembered too, so a second bookmark is matched to the same spelling.
 */
export class Vocabulary {
  private readonly byCanon = new Map<string, VocabularyEntry>()
  private readonly byVariant = new Map<string, VocabularyEntry>()
  private readonly heldByCanon = new Map<string, string>()
  private readonly heldByVariant = new Map<string, string>()

  constructor(tags: readonly { name: string; count: number }[]) {
    for (const tag of tags) {
      const key = canon(tag.name)
      if (!key) continue
      const existing = this.byCanon.get(key)
      if (!existing || tag.count > existing.count) this.index({ name: tag.name, count: tag.count, canon: key })
    }
  }

  private index(entry: VocabularyEntry): void {
    this.byCanon.set(entry.canon, entry)
    const variant = variantKey(entry.name)
    const current = this.byVariant.get(variant)
    if (!current || entry.count >= current.count) this.byVariant.set(variant, entry)
  }

  get size(): number {
    return this.byCanon.size
  }

  entries(): VocabularyEntry[] {
    return [...this.byCanon.values()]
  }

  lookup(key: string): VocabularyEntry | undefined {
    return this.byCanon.get(key)
  }

  /** A tag was added to a bookmark: it now exists (or is one more use of an existing tag). */
  add(name: string): void {
    const key = canon(name)
    if (!key) return
    const existing = this.byCanon.get(key)
    if (existing) {
      existing.count++
      this.index(existing)
    } else {
      this.index({ name, count: 1, canon: key })
    }
    this.heldByCanon.delete(key)
    this.heldByVariant.delete(variantKey(name))
  }

  /** A tag idea nobody has used yet (held back, or only proposed): remembered so its spelling is reused. */
  noteHeld(name: string): void {
    const key = canon(name)
    if (!key || this.byCanon.has(key) || this.heldByCanon.has(key)) return
    this.heldByCanon.set(key, name)
    const variant = variantKey(name)
    if (!this.heldByVariant.has(variant)) this.heldByVariant.set(variant, name)
  }

  /**
   * Maps a candidate tag onto the library's own tag if there is one (also trying `aliases`, loose-form synonyms
   * such as "js" for "javascript", and look-alike forms such as "ad-blocking" for "ad-blocker"); then onto a tag idea
   * that is being held; otherwise returns it in the engine's style for new tags.
   */
  resolve(candidate: string, aliases: readonly string[] = []): { name: string; existing: boolean } | null {
    const key = canon(candidate)
    for (const k of [key, ...aliases]) {
      const hit = this.byCanon.get(k)
      if (hit) return { name: hit.name, existing: true }
    }
    const variant = variantKey(candidate)
    const similar = this.byVariant.get(variant)
    if (similar) return { name: similar.name, existing: true }
    const held = this.heldByCanon.get(key) ?? this.heldByVariant.get(variant)
    if (held) return { name: held, existing: false }
    const styled = styleNewTag(candidate)
    return styled ? { name: styled, existing: false } : null
  }

  /** The tags most relevant to some text (word overlap, then popularity): used to keep an LLM prompt short. */
  relevant(text: string, limit: number): string[] {
    const words = new Set(tokenize(text).map(canon))
    const candidates = [...this.entries().map((e) => ({ name: e.name, count: e.count })), ...[...this.heldByCanon.values()].map((name) => ({ name, count: 0 }))]
    const scored = candidates.map((entry) => {
      const parts = tokenize(entry.name.replace(/-/g, ' ')).map(canon)
      const overlap = parts.filter((p) => words.has(p)).length
      return { name: entry.name, score: overlap * 2 + Math.log10(entry.count + 1) * 0.3 }
    })
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return scored.slice(0, limit).map((s) => s.name)
  }
}
