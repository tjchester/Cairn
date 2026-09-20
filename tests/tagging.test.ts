import { describe, expect, it } from 'vitest'
import type { PageSignals } from '../src/shared/types'
import { suggestTags, type EngineContext, type EngineInput } from '../src/main/tagging/engine'
import { compileRules, findTopics, parseUserRules } from '../src/main/tagging/rules'
import { canon, styleNewTag, tokenize } from '../src/main/tagging/text'
import { Vocabulary } from '../src/main/tagging/vocabulary'

const rules = compileRules()

function ctx(vocab: { name: string; count: number }[] = [], over: Partial<EngineContext> = {}, blocked: string[] = []): EngineContext {
  return { vocabulary: new Vocabulary(vocab), rules, blocked: new Set(blocked.map(canon)), maxTags: 5, ...over }
}

const signals = (over: Partial<PageSignals> = {}): PageSignals => ({ keywords: [], ogType: null, siteName: null, lang: 'en', section: null, text: '', ...over })
const tagsFor = (input: EngineInput, c: EngineContext = ctx()) => suggestTags(input, c).map((s) => s.tag)

describe('text helpers', () => {
  it('tokenizes words, keeping things like c++, c#, node.js and hyphenated terms whole', () => {
    expect(tokenize("Node.js & C++ vs C#: it's machine-learning!")).toEqual(['node.js', 'c++', 'vs', 'c#', 'it', 'machine-learning'])
  })

  it('compares tags loosely: case, punctuation and plurals are ignored', () => {
    expect(canon('Machine Learning')).toBe(canon('machine-learning'))
    expect(canon('Docs')).toBe(canon('doc'))
    expect(canon('Recipes')).toBe(canon('recipe'))
    expect(canon('news')).not.toBe(canon('new'))
    expect(canon('C++')).toBe('c++')
    expect(canon('node.js')).toBe(canon('NodeJS'))
  })

  it('styles new tags in lower-case-hyphen form and rejects poor ones', () => {
    expect(styleNewTag('Machine Learning')).toBe('machine-learning')
    expect(styleNewTag('  C++ ')).toBe('c++')
    expect(styleNewTag('Q&A')).toBe('qa')
    expect(styleNewTag('the')).toBeNull()
    expect(styleNewTag('2024')).toBeNull()
    expect(styleNewTag('x')).toBeNull()
    expect(styleNewTag('a'.repeat(40))).toBeNull()
  })
})

describe('rules', () => {
  it('finds topic phrases as whole words, longest first, counting repeats', () => {
    const tokens = tokenize('Machine learning and deep learning with PyTorch. More machine learning!').map(canon)
    const found = findTopics(rules, tokens)
    expect(found.get('machine-learning')).toBe(4) // "machine learning" x2, "deep learning", "pytorch"
    expect(found.has('ai')).toBe(false)
  })

  it('accepts custom rules, rejects malformed ones with a helpful message, and treats empty as none', () => {
    expect(parseUserRules('')).toEqual({ ok: true, rules: {} })
    expect(parseUserRules('{"domains": {"example.com": ["mine"]}}')).toEqual({ ok: true, rules: { domains: { 'example.com': ['mine'] } } })
    const bad = parseUserRules('{"domains": {"example.com": "mine"}}')
    expect(bad.ok).toBe(false)
    expect(parseUserRules('{nope').ok).toBe(false)
    expect(parseUserRules('{"unknown": 1}').ok).toBe(false)
  })

  it('layers custom rules over the built-in ones', () => {
    const custom = compileRules({ domains: { 'github.com': ['my-code'] }, topics: { garden: ['allotment'] } })
    const input = { url: 'https://github.com/x/y', title: 'My allotment plan', excerpt: '' }
    const tags = suggestTags(input, { vocabulary: new Vocabulary([]), rules: custom, blocked: new Set(), maxTags: 5 }).map((s) => s.tag)
    expect(tags).toContain('my-code') // custom domain rule replaced the built-in one
    expect(tags).not.toContain('code')
    expect(tags).toContain('garden') // custom topic synonym
  })
})

describe('built-in engine on generic pages', () => {
  // Each fixture is a plausible page (title, description, URL, page signals) and what it should - and should not - get.
  const fixtures: { name: string; input: EngineInput; expect: string[]; reject?: string[] }[] = [
    {
      name: 'a GitHub repository',
      input: {
        url: 'https://github.com/electron/electron',
        title: 'GitHub - electron/electron: Build cross-platform desktop apps with JavaScript, HTML, and CSS',
        excerpt: ':electron: Build cross-platform desktop apps with JavaScript, HTML, and CSS'
      },
      expect: ['code', 'javascript', 'html', 'css'],
      reject: ['github']
    },
    {
      name: 'a YouTube video',
      input: {
        url: 'https://www.youtube.com/watch?v=abc123',
        title: 'Rust in 100 seconds',
        excerpt: 'Learn the Rust programming language',
        signals: signals({ ogType: 'video.other' })
      },
      expect: ['video', 'rust', 'programming']
    },
    {
      name: 'a recipe page',
      input: {
        url: 'https://www.seriouseats.com/perfect-pancakes',
        title: 'Perfect Pancakes Recipe',
        excerpt: 'Fluffy pancakes: mix the ingredients, preheat the pan and simmer the syrup.'
      },
      expect: ['recipes', 'cooking']
    },
    {
      name: 'a research paper',
      input: {
        url: 'https://arxiv.org/abs/1706.03762',
        title: 'Attention Is All You Need',
        excerpt: 'We propose a new network architecture, the Transformer, for machine translation and deep learning.'
      },
      expect: ['research', 'papers', 'machine-learning']
    },
    {
      name: 'a PDF',
      input: { url: 'https://example.org/files/annual-report.pdf', title: 'Annual report', excerpt: '' },
      expect: ['pdf']
    },
    {
      name: 'documentation',
      input: {
        url: 'https://docs.docker.com/compose/gettingstarted/',
        title: 'Get started with Docker Compose',
        excerpt: 'A step by step tutorial for running multi-container applications with Docker Compose.'
      },
      expect: ['docker', 'docs', 'tutorial']
    },
    {
      name: 'a news article with page keywords',
      input: {
        url: 'https://www.bbc.com/news/science-environment-123',
        title: 'Renewable energy overtakes coal in record year',
        excerpt: 'Solar and wind power grew as global warming pressures governments.',
        signals: signals({ ogType: 'article', keywords: ['climate change', 'energy'] })
      },
      expect: ['news', 'climate']
    },
    {
      name: 'a travel guide',
      input: {
        url: 'https://www.lonelyplanet.com/japan/itinerary',
        title: '10 day Japan itinerary for first time visitors',
        excerpt: 'Flights, hotels and the best routes for backpacking across Japan.'
      },
      expect: ['travel']
    },
    {
      name: 'a personal finance article',
      input: {
        url: 'https://www.investopedia.com/terms/e/etf.asp',
        title: 'Exchange-Traded Fund (ETF): what it is and how it works',
        excerpt: 'An ETF is an investment that trades like a stock. Learn about index fund investing and retirement.'
      },
      expect: ['finance']
    },
    {
      name: 'a .edu course page',
      input: { url: 'https://cs.stanford.edu/courses/algorithms', title: 'Algorithms course syllabus', excerpt: 'Data structures and algorithms lecture notes' },
      expect: ['education', 'course', 'programming']
    }
  ]

  it.each(fixtures)('tags $name sensibly', ({ input, expect: wanted, reject }) => {
    const tags = tagsFor(input)
    for (const tag of wanted) expect(tags, 'expected ' + tag + ', got ' + tags.join(', ')).toContain(tag)
    for (const tag of reject ?? []) expect(tags).not.toContain(tag)
    expect(tags.length).toBeLessThanOrEqual(5)
  })

  it('returns nothing rather than guessing when there is no evidence', () => {
    expect(tagsFor({ url: 'https://example.com/', title: 'Untitled', excerpt: '' })).toEqual([])
    expect(tagsFor({ url: 'not a url', title: '', excerpt: '' })).toEqual([])
  })

  it('explains itself: each suggestion says why, and where the evidence came from', () => {
    const [first] = suggestTags({ url: 'https://github.com/a/b', title: 'A JavaScript library', excerpt: '' }, ctx())
    expect(first?.reasons.length).toBeGreaterThan(0)
    expect(first?.sources.length).toBeGreaterThan(0)
    expect(first?.origin).toBe('builtin')
    expect(first?.score).toBeGreaterThan(0.45)
    expect(first?.score).toBeLessThanOrEqual(1)
  })

  it('reinforces a tag that several signals agree on', () => {
    const one = suggestTags({ url: 'https://example.org/a', title: 'Docker basics', excerpt: '' }, ctx())[0]
    const two = suggestTags({ url: 'https://example.org/a', title: 'Docker basics', excerpt: 'Learn docker containers', signals: signals({ keywords: ['docker'] }) }, ctx())[0]
    expect(two?.tag).toBe('docker')
    expect(two!.score).toBeGreaterThan(one!.score)
    expect(two!.sources).toEqual(expect.arrayContaining(['topic', 'metadata']))
  })
})

describe('using the tags you already have', () => {
  const library = [
    { name: 'JS', count: 40 },
    { name: 'Docker', count: 12 },
    { name: 'recipes', count: 30 },
    { name: 'to-read', count: 200 },
    { name: 'work', count: 90 }
  ]

  it("reuses the library's own spelling instead of creating a near-duplicate", () => {
    const suggestions = suggestTags({ url: 'https://example.org/x', title: 'Advanced JavaScript patterns', excerpt: '' }, ctx(library))
    const js = suggestions.find((s) => s.tag === 'JS')
    expect(js).toBeDefined()
    expect(js?.existing).toBe(true)
    expect(suggestions.some((s) => s.tag === 'javascript')).toBe(false)
  })

  it('finds your own tags mentioned in the title or description, and prefers them', () => {
    const suggestions = suggestTags({ url: 'https://example.org/x', title: 'Docker networking explained', excerpt: '' }, ctx(library))
    expect(suggestions[0]?.tag).toBe('Docker')
    expect(suggestions[0]?.existing).toBe(true)
  })

  it('never proposes workflow tags such as to-read or work just because the words appear', () => {
    const tags = tagsFor({ url: 'https://example.org/x', title: 'Work to-read list for later', excerpt: 'reading work' }, ctx(library))
    expect(tags).not.toContain('to-read')
    expect(tags).not.toContain('work')
  })

  it('does not suggest tags the bookmark already has, or tags you blocked', () => {
    const input = { url: 'https://github.com/a/b', title: 'A Docker and JavaScript project', excerpt: '', tags: ['docker'] }
    const tags = tagsFor(input, ctx(library, {}, ['code']))
    expect(tags).not.toContain('Docker')
    expect(tags).not.toContain('code')
    expect(tags).toContain('JS')
  })
})

describe('page keywords', () => {
  it('trusts author keywords that map to a known topic, and keeps the topic name', () => {
    const tags = tagsFor({ url: 'https://example.org/a', title: 'Cluster notes', excerpt: '', signals: signals({ keywords: ['k8s'] }) })
    expect(tags).toContain('kubernetes')
  })

  it('ignores SEO junk: an unknown keyword must also appear in the title or description', () => {
    const junk = signals({ keywords: ['cheap watches', 'buy online', 'elixir'] })
    const tags = tagsFor({ url: 'https://example.org/a', title: 'Concurrency in Elixir', excerpt: '', signals: junk })
    expect(tags).toContain('elixir') // corroborated by the title
    expect(tags).not.toContain('cheap-watches')
    expect(tags).not.toContain('buy-online')
  })

  it('does not let keyword and page-text noise create tags by itself', () => {
    const noisy = signals({ text: 'Steve Jobs founded a company. The quick brown fox jumped over the lazy dog many times.' })
    expect(tagsFor({ url: 'https://example.org/a', title: 'Steve Jobs biography', excerpt: '', signals: noisy })).toEqual([])
  })
})
