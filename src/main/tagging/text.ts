// Text helpers shared by the tagging engine: tokenising, comparing tags loosely, and styling new tags.

/** Common English words that never make good tags on their own. */
export const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into ' +
    'is it its just me more most my no nor not of off on once only or other our out over own same she should so some such than that ' +
    'the their them then there these they this those through to too under until up us very was we were what when where which while who ' +
    'whom why will with would you your yours yourself get gets got make makes made using use used uses via vs etc like may might must ' +
    'one two three new now way ways want need needs really much many every even still since while without within across along among ' +
    'around behind beyond however whether either neither another anything everything something nothing someone everyone people thing ' +
    'things good great best better top latest free online official welcome home page pages site website web click read more see ' +
    'view show shows find first last next previous back full complete simple easy quick guide introduction intro overview'
  ).split(' ')
)

/** Tags people use for their own workflow rather than for topics: never matched against page text. */
export const WORKFLOW_TAGS = new Set(
  (
    'read reading to-read toread later todo to-do misc other fun cool interesting useful work stuff unsorted inbox favorites ' +
    'favourites favorite important bookmarks bookmark links link web internet online new old test tmp temp check review watch ' +
    'watchlater someday maybe archive archived reference ideas idea personal'
  ).split(' ')
)

/** Words that end in "s" but are not plurals, so must not be trimmed when comparing tags. */
const NO_SINGULAR = new Set(['news', 'series', 'species', 'status', 'analysis', 'bias', 'canvas', 'gas', 'lens', 'physics', 'mathematics', 'politics', 'economics', 'ios', 'macos', 'tls', 'https', 'atlas', 'chaos', 'cosmos', 'kudos'])

/** Splits text into lower-cased word tokens, keeping things like c++, c#, node.js and machine-learning whole. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#.\-']*/gu)) {
    let token = match[0].replace(/['.\-]+$/g, '')
    token = token.replace(/'s$/, '')
    if (token) out.push(token)
  }
  return out
}

/**
 * A loose form of a word or tag for comparing: case, punctuation and a plural "s" are ignored, so
 * "Machine Learning", "machine-learning" and "machine_learnings" compare equal, as do "docs" and "doc".
 */
export function canon(text: string): string {
  let s = text.toLowerCase().replace(/[^\p{L}\p{N}+#]/gu, '')
  if (s.length > 3 && !NO_SINGULAR.has(s)) {
    if (s.endsWith('ies')) s = s.slice(0, -3) + 'y'
    else if (s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1)
  }
  return s
}

/** Canonical form of a phrase: the loose form of each word, joined by a space. */
export function canonPhrase(text: string): string {
  return tokenize(text).map(canon).join(' ')
}

/**
 * The style used for tags this engine creates (existing tags keep whatever spelling the user gave them):
 * lower case, hyphens between words, no stray punctuation. Returns null for things that make poor tags.
 */
export function styleNewTag(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}+#.\-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  if (s.length < 2 || s.length > 30) return null
  if (/^[\d.\-]+$/.test(s)) return null
  if (STOPWORDS.has(s)) return null
  return s
}

/** Number of words in a phrase. */
export const wordCount = (text: string): number => tokenize(text).length
