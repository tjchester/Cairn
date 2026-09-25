// Parses the search box syntax into structured filters.
//
//   words            match title, URL, note, description and tags (all words must match)
//   "exact phrase"   phrase match
//   -word            exclude
//   #tag  #"a tag"   has tag
//   site:example.com domain (and its subdomains)
//   is:favorite      is:broken   is:unsorted   is:archived
//   has:note         has:cover

export interface ParsedSearch {
  text: string[]
  exclude: string[]
  tags: string[]
  sites: string[]
  favorite: boolean
  broken: boolean
  unsorted: boolean
  /** Look in the Archive (which is otherwise left out). */
  archived: boolean
  hasNote: boolean
  hasCover: boolean
}

/** Splits on whitespace, treating "double quoted" runs as a single token (quotes removed). */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let buffer = ''
  let inQuotes = false
  let hasContent = false
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes
      hasContent = true
    } else if (!inQuotes && /\s/.test(ch)) {
      if (hasContent && buffer) tokens.push(buffer)
      buffer = ''
      hasContent = false
    } else {
      buffer += ch
      hasContent = true
    }
  }
  if (hasContent && buffer) tokens.push(buffer)
  return tokens
}

export function parseSearch(input: string): ParsedSearch {
  const parsed: ParsedSearch = {
    text: [],
    exclude: [],
    tags: [],
    sites: [],
    favorite: false,
    broken: false,
    unsorted: false,
    archived: false,
    hasNote: false,
    hasCover: false
  }

  for (const token of tokenize(input)) {
    const lower = token.toLowerCase()

    if (token.startsWith('#') && token.length > 1) {
      parsed.tags.push(token.slice(1).trim())
    } else if (/^(site|domain):./.test(lower)) {
      parsed.sites.push(lower.replace(/^(site|domain):/, '').replace(/^www\./, ''))
    } else if (lower === 'is:favorite' || lower === 'is:fav' || lower === 'is:favourite') {
      parsed.favorite = true
    } else if (lower === 'is:broken') {
      parsed.broken = true
    } else if (lower === 'is:unsorted') {
      parsed.unsorted = true
    } else if (lower === 'is:archived' || lower === 'is:archive') {
      parsed.archived = true
    } else if (lower === 'has:note') {
      parsed.hasNote = true
    } else if (lower === 'has:cover') {
      parsed.hasCover = true
    } else if (token.startsWith('-') && token.length > 1) {
      parsed.exclude.push(lower.slice(1))
    } else {
      parsed.text.push(lower)
    }
  }
  return parsed
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

export type SqlValue = string | number | null

/** Builds WHERE fragments (each to be AND-ed) for the parsed search. Table alias must be `b`. */
export function buildSearchClauses(parsed: ParsedSearch): { clauses: string[]; params: SqlValue[] } {
  const clauses: string[] = []
  const params: SqlValue[] = []

  for (const term of parsed.text) {
    clauses.push("b.search_text LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(term)}%`)
  }
  for (const term of parsed.exclude) {
    clauses.push("b.search_text NOT LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(term)}%`)
  }
  for (const tag of parsed.tags) {
    clauses.push(
      'EXISTS (SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id AND t.name = ?)'
    )
    params.push(tag)
  }
  for (const site of parsed.sites) {
    clauses.push("(b.domain = ? OR b.domain LIKE ? ESCAPE '\\')")
    params.push(site, `%.${escapeLike(site)}`)
  }
  if (parsed.favorite) clauses.push('b.favorite = 1')
  if (parsed.broken) clauses.push("b.status = 'broken'")
  if (parsed.unsorted) clauses.push('b.collection_id IS NULL')
  if (parsed.hasNote) clauses.push("b.note <> ''")
  if (parsed.hasCover) clauses.push("(b.cover_url IS NOT NULL AND b.cover_url <> '')")

  return { clauses, params }
}
