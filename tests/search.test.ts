import { describe, expect, it } from 'vitest'
import { parseSearch, tokenize } from '../src/main/db/search'
import { makeRepo, q } from './helpers'

describe('parseSearch', () => {
  it('tokenizes quoted phrases', () => {
    expect(tokenize('foo "bar baz" #"my tag"')).toEqual(['foo', 'bar baz', '#my tag'])
  })

  it('understands operators', () => {
    const p = parseSearch('rust -async #tools site:www.github.com is:fav has:note "two words"')
    expect(p.text).toEqual(['rust', 'two words'])
    expect(p.exclude).toEqual(['async'])
    expect(p.tags).toEqual(['tools'])
    expect(p.sites).toEqual(['github.com'])
    expect(p.favorite).toBe(true)
    expect(p.hasNote).toBe(true)
  })
})

describe('searching', () => {
  const setup = () => {
    const repo = makeRepo()
    repo.createBookmark({ url: 'https://github.com/rust-lang/rust', title: 'Rust language', tags: ['dev', 'Rust'], favorite: true })
    repo.createBookmark({ url: 'https://blog.example.com/async', title: 'Async explained', note: 'great post', tags: ['dev'] })
    repo.createBookmark({ url: 'https://example.org/100%_sure', title: 'Percent sign' })
    return repo
  }
  const titles = (repo: ReturnType<typeof makeRepo>, search: string) =>
    repo.query(q({ search, sort: 'title', direction: 'asc' })).items.map((b) => b.title)

  it('matches substrings across title, url, note and tags', () => {
    const repo = setup()
    expect(titles(repo, 'rust')).toEqual(['Rust language'])
    expect(titles(repo, 'great')).toEqual(['Async explained'])
    expect(titles(repo, 'lang')).toEqual(['Rust language'])
  })

  it('ANDs words and supports exclusion', () => {
    const repo = setup()
    expect(titles(repo, 'dev async')).toEqual(['Async explained'])
    expect(titles(repo, 'dev -async')).toEqual(['Rust language'])
  })

  it('filters by tag, site and flags', () => {
    const repo = setup()
    expect(titles(repo, '#dev')).toEqual(['Async explained', 'Rust language'])
    expect(titles(repo, '#DEV site:example.com')).toEqual(['Async explained'])
    expect(titles(repo, 'is:favorite')).toEqual(['Rust language'])
    expect(titles(repo, 'has:note')).toEqual(['Async explained'])
  })

  it('treats LIKE wildcards literally', () => {
    const repo = setup()
    expect(titles(repo, '100%_')).toEqual(['Percent sign'])
    expect(titles(repo, '%')).toEqual(['Percent sign'])
    expect(titles(repo, '_')).toEqual(['Percent sign'])
  })
})
