import { canon, styleNewTag, tokenize } from './text'

export interface VocabularyEntry {
  name: string
  count: number
  canon: string
}

/**
 * The tags already in the library. The engine uses it to reuse the user's own spelling ("JS" rather than a new
 * "javascript") and to prefer tags that exist over inventing new ones, which keeps the tag list from sprawling.
 */
export class Vocabulary {
  private readonly byCanon = new Map<string, VocabularyEntry>()

  constructor(tags: readonly { name: string; count: number }[]) {
    for (const tag of tags) {
      const key = canon(tag.name)
      if (!key) continue
      const existing = this.byCanon.get(key)
      if (!existing || tag.count > existing.count) this.byCanon.set(key, { name: tag.name, count: tag.count, canon: key })
    }
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

  /**
   * Maps a candidate tag onto the library's own tag if there is one (also trying `aliases`, loose-form synonyms
   * such as "js" for "javascript"); otherwise returns it in the engine's style for new tags.
   */
  resolve(candidate: string, aliases: readonly string[] = []): { name: string; existing: boolean } | null {
    for (const key of [canon(candidate), ...aliases]) {
      const hit = this.byCanon.get(key)
      if (hit) return { name: hit.name, existing: true }
    }
    const styled = styleNewTag(candidate)
    return styled ? { name: styled, existing: false } : null
  }

  /** The tags most relevant to some text (word overlap, then popularity): used to keep an LLM prompt short. */
  relevant(text: string, limit: number): string[] {
    const words = new Set(tokenize(text).map(canon))
    const scored = this.entries().map((entry) => {
      const parts = tokenize(entry.name.replace(/-/g, ' ')).map(canon)
      const overlap = parts.filter((p) => words.has(p)).length
      return { name: entry.name, score: overlap * 2 + Math.log10(entry.count + 1) * 0.3 }
    })
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    return scored.slice(0, limit).map((s) => s.name)
  }
}
