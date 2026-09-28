import { describe, expect, it } from 'vitest'
import { parseCsv } from '../src/main/services/csv'
import { detectFormat, exportText, importText } from '../src/main/services/importExport'
import { parseNetscape } from '../src/main/services/netscape'
import type { ImportFolder, ImportLink } from '../src/main/services/importTree'
import { makeRepo, q } from './helpers'

// Shaped like a real Chrome/Firefox export: unclosed <DT>/<p>/<DD>, entities, nested folders.
const BROWSER_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://example.com/a?x=1&amp;y=2" ADD_DATE="1700000100" TAGS="one,two">Tom &amp; Jerry &#39;s page</A>
        <DD>A note about it
        <DT><H3>Dev</H3>
        <DL><p>
            <DT><A HREF="https://rust-lang.org/">Rust</A>
        </DL><p>
        <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    </DL><p>
    <DT><A HREF="https://toplevel.example/">Top level</A>
</DL><p>
`

const links = (folder: ImportFolder): ImportLink[] =>
  folder.children.flatMap((c) => (c.type === 'link' ? [c] : links(c)))

describe('Netscape HTML', () => {
  it('parses folders, nesting, entities, tags, dates and notes; skips non-http links', () => {
    const root = parseNetscape(BROWSER_EXPORT)
    const bar = root.children.find((c): c is ImportFolder => c.type === 'folder')
    expect(bar?.name).toBe('Bookmarks bar')

    const first = bar?.children.find((c): c is ImportLink => c.type === 'link')
    expect(first).toMatchObject({
      url: 'https://example.com/a?x=1&y=2',
      title: "Tom & Jerry 's page",
      tags: ['one', 'two'],
      note: 'A note about it',
      createdAt: '2023-11-14T22:15:00.000Z'
    })

    const dev = bar?.children.find((c): c is ImportFolder => c.type === 'folder')
    expect(dev?.name).toBe('Dev')
    expect(links(dev as ImportFolder).map((l) => l.url)).toEqual(['https://rust-lang.org/'])

    expect(links(root).map((l) => l.url)).not.toContain('javascript:void(0)')
    expect(root.children.some((c) => c.type === 'link' && c.url === 'https://toplevel.example/')).toBe(true)
  })

  it('treats a date of 0 (or anything before the web) as unknown rather than 1970', () => {
    const root = parseNetscape('<DL><p><DT><A HREF="https://a.example/" ADD_DATE="0">A</A><DT><A HREF="https://b.example/" ADD_DATE="315532800">B</A></DL>')
    expect(links(root).map((l) => l.createdAt)).toEqual([undefined, undefined])
    const repo = makeRepo()
    importText(repo, 'bookmarks.html', '<DL><p><DT><A HREF="https://a.example/" ADD_DATE="0">A</A></DL>')
    expect(repo.allActiveBookmarks()[0]?.createdAt.startsWith('1970')).toBe(false)
  })

  it('imports into collections and skips duplicates on re-import', () => {
    const repo = makeRepo()
    const first = importText(repo, 'bookmarks.html', BROWSER_EXPORT)
    expect(first).toMatchObject({ added: 3, skipped: 0, collectionsCreated: 2 })
    expect(repo.listCollections().map((c) => c.name).sort()).toEqual(['Bookmarks bar', 'Dev'])

    const again = importText(repo, 'bookmarks.html', BROWSER_EXPORT)
    expect(again).toMatchObject({ added: 0, skipped: 3, collectionsCreated: 0 })
  })
})

describe('CSV', () => {
  it('parses quotes, commas, embedded newlines and BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n"q""uote",z\r\n')
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'line1\nline2'],
      ['q"uote', 'z']
    ])
  })

  it('imports a Raindrop-style CSV with folder paths and tags', () => {
    const repo = makeRepo()
    const csv = [
      'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
      '1,"Hello, world",n,e,https://a.com/x,Dev/Rust,"a, b",2024-01-02T03:04:05Z,,,true',
      '2,No folder,,,https://b.com/y,,,,,,'
    ].join('\n')
    expect(importText(repo, 'export.csv', csv)).toMatchObject({ added: 2, collectionsCreated: 2 })
    const a = repo.findByUrl('https://a.com/x')
    expect(a).toMatchObject({ title: 'Hello, world', favorite: true, tags: ['a', 'b'], createdAt: '2024-01-02T03:04:05.000Z' })
    expect(repo.collectionPath(a?.collectionId ?? null)).toEqual(['Dev', 'Rust'])
    expect(repo.findByUrl('https://b.com/y')?.collectionId).toBeNull()
  })

  it('requires a url column', () => {
    expect(() => importText(makeRepo(), 'x.csv', 'title,note\na,b')).toThrow(/url/)
  })

  it('neutralises spreadsheet formulas on export and restores them on import', () => {
    const repo = makeRepo()
    repo.createBookmark({ url: 'https://evil.example', title: '=HYPERLINK("http://x","click")' })
    const csv = exportText(repo, 'csv')
    expect(csv).toContain(`'=HYPERLINK`)
    const other = makeRepo()
    importText(other, 'x.csv', csv)
    expect(other.findByUrl('https://evil.example')?.title).toBe('=HYPERLINK("http://x","click")')
  })
})

describe('round trips', () => {
  const seed = () => {
    const repo = makeRepo()
    const dev = repo.createCollection({ name: 'Dev', color: '#3366ff' })
    const rust = repo.createCollection({ name: 'Rust', parentId: dev.id })
    repo.createCollection({ name: 'Empty' })
    repo.createBookmark({
      url: 'https://a.com/1',
      title: 'Ünïcode "quotes" & <tags>',
      note: 'multi\nline note',
      excerpt: 'desc',
      tags: ['x', 'y z'],
      favorite: true,
      collectionId: rust.id,
      createdAt: '2024-05-06T07:08:09.000Z'
    })
    repo.createBookmark({ url: 'https://b.com/2', title: 'Loose' })
    return repo
  }

  const snapshot = (repo: ReturnType<typeof makeRepo>) =>
    repo
      .query(q({ sort: 'title', direction: 'asc' }))
      .items.map((b) => ({ url: b.url, title: b.title, tags: b.tags, path: repo.collectionPath(b.collectionId) }))

  it.each(['json', 'html', 'csv'] as const)('%s export can be re-imported', (format) => {
    const source = seed()
    const target = makeRepo()
    const text = exportText(source, format)
    expect(detectFormat(`backup.${format}`, text)).toBe(format)
    importText(target, `backup.${format}`, text)
    expect(snapshot(target)).toEqual(snapshot(source))
  })

  it('json keeps notes, favorites, dates, colors and empty collections', () => {
    const source = seed()
    const target = makeRepo()
    importText(target, 'b.json', exportText(source, 'json'))
    expect(target.findByUrl('https://a.com/1')).toMatchObject({
      note: 'multi\nline note',
      excerpt: 'desc',
      favorite: true,
      createdAt: '2024-05-06T07:08:09.000Z'
    })
    expect(target.listCollections().find((c) => c.name === 'Dev')?.color).toBe('#3366ff')
    expect(target.listCollections().some((c) => c.name === 'Empty')).toBe(true)
  })

  it('rejects malformed JSON', () => {
    expect(() => importText(makeRepo(), 'x.json', '{nope')).toThrow(/not valid JSON/)
    expect(() => importText(makeRepo(), 'x.json', '{"bookmarks": 5}')).toThrow(/not a Cairn/)
  })
})
