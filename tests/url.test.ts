import { describe, expect, it } from 'vitest'
import { coerceUrl, domainOf, extractUrls, redirectKey, urlKey } from '../src/shared/url'

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

  it('ignores the markers that only say where you came from', () => {
    const plain = urlKey('https://wizardzines.com/')
    expect(urlKey('https://wizardzines.com/?ref=blog.pragmaticengineer.com')).toBe(plain)
    expect(urlKey('https://wizardzines.com/?referrer=x&utm_source=newsletter')).toBe(plain)
    for (const param of ['ref', 'referer', 'referrer', 'fbclid', 'gclid', 'mc_eid', 'mkt_tok', 'si', 'spm', '_ga', 'igshid', 'srsltid', 'trk']) {
      expect(urlKey('https://example.com/a?' + param + '=123'), param).toBe(urlKey('https://example.com/a'))
    }
    // ...while the ones that choose the page are kept, so two real pages stay apart.
    for (const param of ['id', 'page', 'q', 'v', 't', 'src', 'source', 'from', 'lang', 'tab', 'p']) {
      expect(urlKey('https://example.com/a?' + param + '=123'), param).not.toBe(urlKey('https://example.com/a'))
    }
  })

  it('keeps meaningful differences', () => {
    expect(urlKey('https://example.com/a')).not.toBe(urlKey('https://example.com/b'))
    expect(urlKey('https://example.com/?id=1')).not.toBe(urlKey('https://example.com/?id=2'))
  })

  it('ignores campaign markers from Microsoft, GameSpot, newsletters and WordPress', () => {
    expect(urlKey('https://github.com/malxau/yori?WT.mc_id=x')).toBe(urlKey('https://github.com/malxau/yori'))
    expect(urlKey('https://www.gamespot.com/articles/a/1100-6517292/?ftag=CAD-01')).toBe(urlKey('https://www.gamespot.com/articles/a/1100-6517292'))
    expect(urlKey('https://www.makeuseof.com/a/?newsletter_popup=1')).toBe(urlKey('https://www.makeuseof.com/a'))
    expect(urlKey('https://blog.example.org/post/?doing_wp_cron=1532778369.45')).toBe(urlKey('https://blog.example.org/post'))
    expect(urlKey('https://blog.playstation.com/a/?et_rid=&et_cid=x&emcid=y')).toBe(urlKey('https://blog.playstation.com/a'))
  })

  it('ignores some names only on the sites where they are tracking', () => {
    expect(urlKey('https://twitter.com/levelsio/status/1565737122736259074?s=20&t=AgGLfP')).toBe(urlKey('https://twitter.com/levelsio/status/1565737122736259074'))
    expect(urlKey('https://www.forbes.com/sites/a/?sh=606238667106')).toBe(urlKey('https://www.forbes.com/sites/a'))
    expect(urlKey('https://www.theregister.com/2024/08/18/a/?td=rt-3a')).toBe(urlKey('https://www.theregister.com/2024/08/18/a'))
    expect(urlKey('https://www.makeuseof.com/a/?pubDate=20251204')).toBe(urlKey('https://www.makeuseof.com/a/'))
    expect(urlKey('https://www.amazon.com/gp/product/908302492X/ref=as_li_tl?ie=UTF8&camp=1789&creative=9325&creativeASIN=908302492X&linkCode=as2&tag=bb-20&linkId=01de'))
      .toBe(urlKey('https://www.amazon.com/gp/product/908302492X'))
    expect(urlKey('https://www.amazon.co.uk/dp/B0?tag=x')).toBe(urlKey('https://amazon.co.uk/dp/B0'))
    // ...and nowhere else: `t` is a YouTube timestamp, `tag` chooses the page on many sites.
    expect(urlKey('https://www.youtube.com/watch?v=abc&t=42')).not.toBe(urlKey('https://www.youtube.com/watch?v=abc'))
    expect(urlKey('https://example.com/posts?tag=rust')).not.toBe(urlKey('https://example.com/posts'))
  })

  it('treats a folder and its index page as one page', () => {
    expect(urlKey('https://tunnelblick.net/index.html')).toBe(urlKey('https://tunnelblick.net/'))
    expect(urlKey('http://www.dosdays.co.uk/index.php')).toBe(urlKey('https://www.dosdays.co.uk/'))
    expect(urlKey('https://www.labri.fr/perso/GTD/index.html')).toBe(urlKey('https://www.labri.fr/perso/GTD/'))
    expect(urlKey('http://www.menuetos.net/index.htm')).toBe(urlKey('https://www.menuetos.net'))
    expect(urlKey('https://example.com/Default.aspx')).toBe(urlKey('https://example.com/'))
    // A page served through the index script is not the folder.
    expect(urlKey('https://www.hyperion-entertainment.com/index.php/news')).not.toBe(urlKey('https://www.hyperion-entertainment.com/'))
    expect(urlKey('https://example.com/docs/index.html')).not.toBe(urlKey('https://example.com/'))
  })

  it('ignores repeated slashes', () => {
    expect(urlKey('https://bevy.org//')).toBe(urlKey('https://bevy.org/'))
    expect(urlKey('https://example.com/a//b')).toBe(urlKey('https://example.com/a/b'))
  })

  it('ignores case in GitHub account and repository names, but not in file paths', () => {
    expect(urlKey('https://github.com/jamiemcg/remarkable')).toBe(urlKey('https://github.com/jamiemcg/Remarkable'))
    expect(urlKey('https://github.com/shaarli/shaarli/')).toBe(urlKey('https://github.com/Shaarli/Shaarli'))
    expect(urlKey('https://github.com/o/r/blob/main/README.md')).not.toBe(urlKey('https://github.com/o/r/blob/main/readme.md'))
    expect(urlKey('https://example.com/Page')).not.toBe(urlKey('https://example.com/page'))
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

describe('redirectKey', () => {
  it('is the key of a new home for the page, and null when nothing moved or the page was only sent away', () => {
    expect(redirectKey('https://golang.org/ref/spec', 'https://go.dev/ref/spec')).toBe('go.dev/ref/spec')
    expect(redirectKey('https://github.com/geohot/tinygrad', 'https://github.com/tinygrad/tinygrad')).toBe('github.com/tinygrad/tinygrad')
    expect(redirectKey('http://example.com/a', 'https://www.example.com/a/')).toBeNull() // same page
    expect(redirectKey('https://example.com/a', undefined)).toBeNull()
    expect(redirectKey('https://example.com/a', 'https://example.com/')).toBeNull() // gone: sent to the front page
    expect(redirectKey('https://old.example/', 'https://new.example/')).toBe('new.example') // a front page that moved
    for (const dead of ['/login?next=/a', '/users/sign_in', '/signin', '/404', '/not-found', '/error.html']) {
      expect(redirectKey('https://example.com/a', 'https://example.com' + dead), dead).toBeNull()
    }
  })
})
