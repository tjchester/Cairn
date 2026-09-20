import type { Bookmark, Collection } from '@shared/types'
import { newFolder, newLink, toIsoDate, type ImportFolder, type ImportLink } from './importTree'

// The "Netscape bookmark file" is the HTML export format used by every major browser.
// It is not well-formed HTML (unclosed <DT>/<P>/<DD>), so it is parsed with a small tolerant tokenizer.

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  for (const m of tag.matchAll(re)) {
    attrs[(m[1] as string).toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  }
  return attrs
}

type Capture =
  | { kind: 'folder'; folder: ImportFolder; attrs: Record<string, string>; text: string }
  | { kind: 'link'; link: ImportLink; text: string }
  | { kind: 'note'; link: ImportLink; text: string }

export function parseNetscape(html: string): ImportFolder {
  const root = newFolder()
  const folderStack: ImportFolder[] = [root]
  const dlOpened: boolean[] = []
  let pendingFolder: ImportFolder | null = null
  let capture: Capture | null = null

  const top = (): ImportFolder => folderStack[folderStack.length - 1] as ImportFolder

  const finishNote = (): void => {
    if (capture?.kind === 'note') {
      const note = decodeEntities(capture.text).trim()
      if (note) capture.link.note = note
      capture = null
    }
  }

  for (const match of html.matchAll(/<[^>]*>|[^<]+/g)) {
    const token = match[0]
    if (!token.startsWith('<')) {
      if (capture) capture.text += token
      continue
    }
    const tag = /^<\s*(\/)?\s*([a-zA-Z0-9]+)/.exec(token)
    if (!tag) continue // comments, doctype
    const closing = tag[1] === '/'
    const name = (tag[2] as string).toLowerCase()

    if (name === 'dd' && !closing) {
      finishNote()
      const last = top().children.at(-1)
      if (last?.type === 'link') capture = { kind: 'note', link: last, text: '' }
      continue
    }
    finishNote()

    if (name === 'h3') {
      if (!closing) {
        capture = { kind: 'folder', folder: newFolder(), attrs: parseAttributes(token), text: '' }
      } else if (capture?.kind === 'folder') {
        capture.folder.name = decodeEntities(capture.text).trim()
        top().children.push(capture.folder)
        pendingFolder = capture.folder
        capture = null
      }
    } else if (name === 'a') {
      if (!closing) {
        const attrs = parseAttributes(token)
        const link = newLink(attrs.href ?? '', {
          tags: (attrs.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
          createdAt: toIsoDate(attrs.add_date),
          coverUrl: undefined
        })
        capture = { kind: 'link', link, text: '' }
      } else if (capture?.kind === 'link') {
        capture.link.title = decodeEntities(capture.text).replace(/\s+/g, ' ').trim()
        if (/^https?:\/\//i.test(capture.link.url)) top().children.push(capture.link)
        capture = null
      }
    } else if (name === 'dl') {
      if (!closing) {
        if (pendingFolder) {
          folderStack.push(pendingFolder)
          dlOpened.push(true)
          pendingFolder = null
        } else {
          dlOpened.push(false)
        }
      } else if (dlOpened.pop() && folderStack.length > 1) {
        folderStack.pop()
      }
    }
  }
  finishNote()
  return root
}

// ---------------------------------------------------------------- serialising

interface FolderNode {
  collection: Collection
  children: FolderNode[]
  bookmarks: Bookmark[]
}

function toEpoch(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000)
}

export function serializeNetscape(collections: Collection[], bookmarks: Bookmark[]): string {
  const nodes = new Map<number, FolderNode>(collections.map((c) => [c.id, { collection: c, children: [], bookmarks: [] }]))
  const roots: FolderNode[] = []
  for (const node of nodes.values()) {
    const parent = node.collection.parentId === null ? undefined : nodes.get(node.collection.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const unsorted: Bookmark[] = []
  for (const bookmark of bookmarks) {
    const node = bookmark.collectionId === null ? undefined : nodes.get(bookmark.collectionId)
    if (node) node.bookmarks.push(bookmark)
    else unsorted.push(bookmark)
  }

  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ]

  const writeBookmark = (b: Bookmark, indent: string): void => {
    const tags = b.tags.map((t) => t.replaceAll(',', ' ')).join(',')
    const attrs = [`HREF="${escapeHtml(b.url)}"`, `ADD_DATE="${toEpoch(b.createdAt)}"`]
    if (tags) attrs.push(`TAGS="${escapeHtml(tags)}"`)
    lines.push(`${indent}<DT><A ${attrs.join(' ')}>${escapeHtml(b.title || b.url)}</A>`)
    if (b.note) lines.push(`${indent}<DD>${escapeHtml(b.note)}`)
  }

  const writeFolder = (node: FolderNode, indent: string): void => {
    lines.push(`${indent}<DT><H3 ADD_DATE="${Math.floor(Date.now() / 1000)}">${escapeHtml(node.collection.name)}</H3>`)
    lines.push(`${indent}<DL><p>`)
    for (const child of node.children) writeFolder(child, `${indent}    `)
    for (const b of node.bookmarks) writeBookmark(b, `${indent}    `)
    lines.push(`${indent}</DL><p>`)
  }

  for (const root of roots) writeFolder(root, '    ')
  for (const b of unsorted) writeBookmark(b, '    ')
  lines.push('</DL><p>', '')
  return lines.join('\n')
}
