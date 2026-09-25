#!/usr/bin/env node
// A small command-line window onto a running Cairn. It reads; it never changes anything.
//
//   cairn search rust async --limit 5
//   cairn get 1428
//   cairn collections
//   cairn tags --limit 20
//   cairn stats
//
// It finds the app by itself: while Cairn is open with "Let my browser and other programs add bookmarks" switched
// on, it writes api.json into its data folder with the address and the read key. CAIRN_URL and CAIRN_READ_KEY (or
// --url and --key) override that.

import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = `Cairn, from the command line. It only reads.

  cairn search [words...]     search your bookmarks (the app's own syntax: #tag site:example.com is:favorite)
  cairn get <id>             one bookmark in full
  cairn collections          the collection tree, with how many bookmarks each holds
  cairn tags                 the tags you use, most used first
  cairn stats                how much of everything there is
  cairn ping                 check that Cairn is running

Options
  --limit N                  how many to show (search: 20, tags: 40)
  --offset N                 skip the first N (search)
  --scope S                  all (default), unsorted, favorites, broken, trash, tag:<name>, collection:<id or path>
  --sort S                   created (default), updated, title, domain
  --asc, --desc              which way round
  --archived                 include what is in the Archive
  --json                     print the answer as JSON
  --url U, --key K           where Cairn is, and the read key (otherwise found automatically)
  -h, --help                 this
`

/** Where the app keeps its data, and so its note of the address and read key. */
export function dataFolder(env = process.env, os = platform()) {
  if (env.CAIRN_USER_DATA) return env.CAIRN_USER_DATA
  if (os === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cairn')
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cairn')
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Cairn')
}

function discover(env) {
  try {
    const found = JSON.parse(readFileSync(join(dataFolder(env), 'api.json'), 'utf8'))
    if (typeof found?.url === 'string' && typeof found?.readKey === 'string') return found
  } catch {
    // Not running, or the API is switched off.
  }
  return null
}

/** Turns the arguments into a command, its words and its options. */
export function parseArgs(argv) {
  const options = {}
  const words = []
  const takesValue = new Set(['limit', 'offset', 'scope', 'sort', 'url', 'key'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=')
      if (takesValue.has(name)) options[name] = inline ?? argv[++i]
      else options[name] = true
    } else words.push(arg)
  }
  return { command: (words.shift() ?? '').toLowerCase(), words, options }
}

function connection(options, env) {
  const url = options.url ?? env.CAIRN_URL ?? discover(env)?.url
  const key = options.key ?? env.CAIRN_READ_KEY ?? discover(env)?.readKey
  if (!url || !key) {
    throw new Error(
      'Could not find a running Cairn.\n' +
        'Open the app and switch on "Let my browser and other programs on this computer add bookmarks" in Settings,\n' +
        'or pass --url http://127.0.0.1:47821 --key <read key>.'
    )
  }
  return { url: url.replace(/\/+$/, ''), key }
}

async function get(where, path, fetchImpl) {
  const response = await fetchImpl(where.url + path, { headers: { authorization: 'Bearer ' + where.key, accept: 'application/json' } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body?.error?.message ?? 'HTTP ' + response.status
    throw new Error(response.status === 401 ? 'Cairn did not accept the key. Check the read key in Settings, or let it be found automatically.' : message)
  }
  return body
}

const pad = (text, width) => String(text).padEnd(width)
const cut = (text, width) => (String(text).length > width ? String(text).slice(0, width - 1) + '…' : String(text))

function searchQuery(words, options) {
  const params = new URLSearchParams()
  if (words.length > 0) params.set('q', words.join(' '))
  params.set('limit', String(options.limit ?? 20))
  if (options.offset) params.set('offset', String(options.offset))
  if (options.scope) params.set('scope', options.scope)
  if (options.sort) params.set('sort', options.sort)
  if (options.asc) params.set('direction', 'asc')
  if (options.desc) params.set('direction', 'desc')
  if (options.archived) params.set('archived', '1')
  return '/api/v1/bookmarks?' + params.toString()
}

/** Runs one command. Returns the exit code; everything it prints goes through `io`. */
export async function run(argv, io = {}) {
  const out = io.out ?? ((line) => console.log(line))
  const err = io.err ?? ((line) => console.error(line))
  const env = io.env ?? process.env
  const fetchImpl = io.fetch ?? fetch
  const { command, words, options } = parseArgs(argv)

  if (options.help || command === '' || command === 'help') {
    out(USAGE)
    return 0
  }

  try {
    const where = connection(options, env)
    /** Prints an answer, as JSON when asked for it, and reports success. */
    const say = (value, text) => {
      out(options.json ? JSON.stringify(value, null, 2) : text())
      return 0
    }

    switch (command) {
      case 'search':
      case 'ls':
      case 'list': {
        const body = await get(where, searchQuery(words, options), fetchImpl)
        return say(body, () => {
          if (body.bookmarks.length === 0) return 'Nothing matched.'
          const lines = body.bookmarks.map((b) => pad(b.id, 7) + pad(cut(b.title, 58), 60) + cut(b.collection ?? 'Unsorted', 28))
          const shown = body.offset + body.bookmarks.length
          return [...lines, '', shown + ' of ' + body.total + (shown < body.total ? ' (--offset ' + shown + ' for more)' : '')].join('\n')
        })
      }
      case 'get':
      case 'show': {
        const id = Number(words[0])
        if (!Number.isInteger(id)) throw new Error('Which bookmark? Give the id, as "cairn get 1428".')
        const { bookmark } = await get(where, '/api/v1/bookmarks/' + id, fetchImpl)
        return say({ bookmark }, () =>
          [
            bookmark.title,
            bookmark.url,
            'Collection : ' + (bookmark.collection ?? 'Unsorted'),
            'Tags       : ' + (bookmark.tags.join(', ') || '(none)'),
            'Added      : ' + String(bookmark.createdAt).slice(0, 10),
            ...(bookmark.description ? ['', bookmark.description] : []),
            ...(bookmark.note ? ['', 'Note: ' + bookmark.note] : [])
          ].join('\n')
        )
      }
      case 'collections': {
        const body = await get(where, '/api/v1/collections', fetchImpl)
        return say(body, () =>
          body.collections.length === 0
            ? 'No collections yet.'
            : body.collections
                .slice()
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((c) => pad(c.id, 7) + pad(c.path + (c.role === 'archive' ? '  (Archive)' : ''), 54) + String(c.bookmarks).padStart(6))
                .join('\n')
        )
      }
      case 'tags': {
        const body = await get(where, '/api/v1/tags', fetchImpl)
        const limit = Number(options.limit ?? 40)
        const tags = body.tags.slice().sort((a, b) => b.bookmarks - a.bookmarks || a.name.localeCompare(b.name))
        return say({ tags }, () => (tags.length === 0 ? 'No tags yet.' : tags.slice(0, limit).map((t) => pad(t.name, 34) + String(t.bookmarks).padStart(6)).join('\n')))
      }
      case 'stats': {
        const body = await get(where, '/api/v1/stats', fetchImpl)
        return say(body, () => Object.entries(body).map(([name, value]) => pad(name, 14) + String(value).padStart(8)).join('\n'))
      }
      case 'ping': {
        const body = await get(where, '/api/v1/ping', fetchImpl)
        return say(body, () => body.app + ' ' + body.version + ' is running at ' + where.url)
      }
      default:
        err('No such command: ' + command + '\n')
        err(USAGE)
        return 2
    }
  } catch (error) {
    err(error instanceof Error ? error.message : String(error))
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) process.exit(await run(process.argv.slice(2)))
