import { describe, expect, it } from 'vitest'
import type { MetadataResult } from '../src/main/services/metadata'
import { refreshBookmarkMetadata } from '../src/main/services/refresh'
import { makeRepo } from './helpers'

const meta = (over: Partial<MetadataResult> = {}): MetadataResult => ({
  title: 'Fresh title',
  excerpt: 'Fresh description',
  coverUrl: 'https://cdn.example/cover.png',
  faviconUrl: 'https://cdn.example/icon.png',
  finalUrl: 'https://x.example/',
  status: 200,
  retryAfterMs: null,
  ...over
})

describe('refreshBookmarkMetadata (the single-bookmark Refresh button)', () => {
  it('fetches the page and fills in what is missing', async () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://x.example/' })
    const updated = await refreshBookmarkMetadata(repo, b.id, async () => meta())
    expect(updated).toMatchObject({ title: 'Fresh title', excerpt: 'Fresh description', coverUrl: 'https://cdn.example/cover.png' })
  })

  it('never overwrites a title or description you wrote yourself, but does refresh the cover and icon', async () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://x.example/', title: 'My own title', excerpt: 'My own words', coverUrl: 'https://old.example/c.png' })
    const updated = await refreshBookmarkMetadata(repo, b.id, async () => meta())
    expect(updated).toMatchObject({ title: 'My own title', excerpt: 'My own words', coverUrl: 'https://cdn.example/cover.png' })
  })

  it.each([
    [404, /no longer exists/],
    [410, /no longer exists/],
    [429, /limiting requests/],
    [503, /limiting requests/],
    [500, /HTTP 500/]
  ])('reports an HTTP %i answer as an error and leaves the bookmark untouched', async (status, message) => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://x.example/', faviconUrl: 'https://x.example/real-icon.png' })
    // an error page comes back with a guessed default icon: that must not be saved
    const fetcher = async () => meta({ status, title: '', coverUrl: null, faviconUrl: 'https://x.example/favicon.ico' })
    await expect(refreshBookmarkMetadata(repo, b.id, fetcher)).rejects.toThrow(message)
    expect(repo.getBookmark(b.id)).toMatchObject({ faviconUrl: 'https://x.example/real-icon.png', title: 'x.example' })
  })

  it('explains a site that cannot be reached, and rejects unknown bookmarks', async () => {
    const repo = makeRepo()
    const b = repo.createBookmark({ url: 'https://x.example/' })
    const unreachable = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })
    await expect(refreshBookmarkMetadata(repo, b.id, async () => Promise.reject(unreachable))).rejects.toThrow('Could not reach the site (dns (ENOTFOUND))')
    await expect(refreshBookmarkMetadata(repo, 9999, async () => meta())).rejects.toThrow('Bookmark not found')
  })
})
