import type { TidyGroup, TidyPlan, TidyTag } from '@shared/types'
import { canon, GENERIC_TAGS, variantKey } from './text'

// Works out what "Tidy tags" would offer. It only reads: nothing is changed until the user applies a selection.

export interface TagStat {
  name: string
  uses: number
  /** How many of the uses are there because the user added the tag themselves. */
  userUses: number
}

const toTidyTag = (s: TagStat): TidyTag => ({ name: s.name, uses: s.uses, yours: s.userUses > 0 })

/** The member the others should be merged into: one of yours if there is one, otherwise the most used. */
export function chooseKeeper(members: readonly TagStat[]): TagStat {
  const sorted = [...members].sort(
    (a, b) => b.userUses - a.userUses || b.uses - a.uses || a.name.length - b.name.length || a.name.localeCompare(b.name)
  )
  return sorted[0] as TagStat
}

/**
 * Groups look-alike tags ("ad-blocker", "ad-blockers", "ad-blocking", "adblock"), lists automatic tags used by only a
 * few bookmarks, and lists vague automatic tags. Tags you added yourself are never offered for removal.
 */
export function buildTidyPlan(stats: readonly TagStat[], tagsByBookmark: ReadonlyMap<number, readonly string[]>, rareMaxUses: number): TidyPlan {
  const families = new Map<string, TagStat[]>()
  for (const stat of stats) {
    const key = variantKey(stat.name)
    if (!key) continue
    const list = families.get(key)
    if (list) list.push(stat)
    else families.set(key, [stat])
  }

  const groups: TidyGroup[] = []
  const grouped = new Set<string>()
  for (const [key, members] of families) {
    if (members.length < 2) continue
    const keep = chooseKeeper(members)
    for (const m of members) grouped.add(m.name)
    groups.push({
      id: key,
      members: [...members].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).map(toTidyTag),
      keep: keep.name,
      spellingOnly: new Set(members.map((m) => canon(m.name))).size === 1,
      selected: members.filter((m) => m.userUses > 0).length <= 1
    })
  }
  // Looser matches first (they deserve a glance), then the plain plural / capital / hyphen ones, biggest first.
  const weight = (g: TidyGroup): number => g.members.reduce((n, m) => n + m.uses, 0)
  groups.sort((a, b) => Number(a.spellingOnly) - Number(b.spellingOnly) || weight(b) - weight(a) || a.id.localeCompare(b.id))

  const automatic = stats.filter((s) => s.userUses === 0 && !grouped.has(s.name))
  const rare = automatic.filter((s) => s.uses <= rareMaxUses).sort((a, b) => a.uses - b.uses || a.name.localeCompare(b.name))
  const vague = automatic.filter((s) => s.uses > rareMaxUses && GENERIC_TAGS.has(canon(s.name))).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))

  const rareNames = new Set(rare.map((s) => s.name.toLowerCase()))
  let onlyTag = 0
  for (const tags of tagsByBookmark.values()) {
    if (tags.length > 0 && tags.every((t) => rareNames.has(t.toLowerCase()))) onlyTag++
  }

  return {
    totalTags: stats.length,
    oneUse: stats.filter((s) => s.uses === 1).length,
    groups,
    rare: { maxUses: rareMaxUses, tags: rare.map(toTidyTag), uses: rare.reduce((n, s) => n + s.uses, 0), onlyTag },
    vague: vague.map(toTidyTag)
  }
}
