import { describe, expect, it } from 'vitest'
import { coerceUrl, domainOf, extractUrls, urlKey } from '../src/shared/url'

describe('coerceUrl', () => {
  it('adds https to bare hostnames', () => {
    expect(coerceUrl('example.com')).toBe('https://example.com/')
    expect(coerceUrl('  example.com/a?b=1 ')).toBe('https://example.com/a?b=1')
  })

  it('keeps http and https URLs', () => {
    expect(coerceUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
  })

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com', 'mailto:a@b.co', '', 'not a url'])(
    'rejects %j',
    (input) => {
      expect(() => coerceUrl(input)).toThrow()
    }
  )
})

describe('urlKey', () => {
  it('ignores scheme, www, fragment, trailing slash and tracking params', () => {
    const a = urlKey('https://www.Example.com/path/?utm_source=x&b=2&a=1#section')
    const b = urlKey('http://example.com/path?a=1&b=2')
    expect(a).toBe(b)
  })

  it('keeps meaningful differences', () => {
    expect(urlKey('https://example.com/a')).not.toBe(urlKey('https://example.com/b'))
    expect(urlKey('https://example.com/?id=1')).not.toBe(urlKey('https://example.com/?id=2'))
  })
})

describe('domainOf / extractUrls', () => {
  it('strips www and lowercases', () => {
    expect(domainOf('https://WWW.Example.com/x')).toBe('example.com')
    expect(domainOf('garbage')).toBe('')
  })

  it('extracts unique URLs from pasted text and trims punctuation', () => {
    const text = 'see https://a.com/x, and (https://b.org/y). again https://a.com/x'
    expect(extractUrls(text)).toEqual(['https://a.com/x', 'https://b.org/y'])
  })
})
