import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { dataFolder, parseArgs, run } from '../bin/cairn.mjs'
import { ApiController } from '../src/main/api/controller'
import { IngestService } from '../src/main/api/ingest'
import { applySettingsPatch, readSettings } from '../src/main/settings'
import { DEFAULT_TAGGING } from '../src/shared/types'
import { TaggingService } from '../src/main/tagging/service'
import { makeRepo } from './helpers'

// The command-line tool, driven the way a person would drive it, against a real local API.

const dir = mkdtempSync(join(tmpdir(), 'cairn-cli-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const controllers: ApiController[] = []
afterEach(async () => {
  while (controllers.length) await controllers.pop()?.stop()
})

/** A port nothing is listening on, so the API can be given a real one. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => resolve(port))
    })
  })
}

async function runningCairn() {
  const repo = makeRepo()
  const dev = repo.createCollection({ name: 'Dev' })
  const rust = repo.createCollection({ name: 'Rust', parentId: dev.id })
  repo.createBookmark({ url: 'https://rust-lang.org/', title: 'The Rust language', collectionId: rust.id, tags: ['rust', 'docs'] })
  repo.createBookmark({ url: 'https://github.com/org/tool', title: 'A tool', collectionId: rust.id, tags: ['rust'], favorite: true })
  repo.createBookmark({ url: 'https://recipes.example/soup', title: 'Soup of the day', note: 'the good one' })

  const tagging = new TaggingService(repo, () => ({ ...DEFAULT_TAGGING, mode: 'off' }))
  const ingest = new IngestService({ repo, tagging, fetcher: async () => ({ title: '', excerpt: '', coverUrl: null, faviconUrl: null, finalUrl: '', status: 200, retryAfterMs: null }) })
  const discoveryFile = join(dir, 'api-' + controllers.length + '.json')
  const controller = new ApiController({ repo, ingest, version: '1.2.3', getSettings: () => readSettings(repo).api, discoveryFile })
  controllers.push(controller)
  applySettingsPatch(repo, { api: { enabled: true, port: await freePort() } })
  const status = await controller.apply()
  expect(status.running, status.error ?? '').toBe(true)
  return { repo, controller, discoveryFile, status }
}

/** Runs the tool and collects what it printed. */
async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const lines: string[] = []
  const errors: string[] = []
  const code = await run(args, { out: (l) => lines.push(l), err: (l) => errors.push(l), env, fetch })
  return { code, out: lines.join('\n'), err: errors.join('\n') }
}

describe('reading the arguments', () => {
  it('sorts the command from its words and its options', () => {
    expect(parseArgs(['search', 'rust', 'async', '--limit', '5', '--json'])).toEqual({
      command: 'search',
      words: ['rust', 'async'],
      options: { limit: '5', json: true }
    })
    expect(parseArgs(['tags', '--limit=12'])).toMatchObject({ command: 'tags', options: { limit: '12' } })
    expect(parseArgs([])).toMatchObject({ command: '' })
    expect(parseArgs(['--help'])).toMatchObject({ options: { help: true } })
  })

  it('knows where the app keeps its data on each platform', () => {
    expect(dataFolder({ CAIRN_USER_DATA: 'C:/elsewhere' }, 'win32')).toBe('C:/elsewhere')
    expect(dataFolder({ APPDATA: 'C:/Users/me/AppData/Roaming' }, 'win32')).toContain('Cairn')
    expect(dataFolder({ XDG_CONFIG_HOME: '/home/me/.config' }, 'linux')).toBe(join('/home/me/.config', 'Cairn'))
    expect(dataFolder({}, 'darwin')).toContain(join('Library', 'Application Support', 'Cairn'))
  })
})

describe('the command-line tool', () => {
  it('finds a running Cairn by itself, through the note it leaves', async () => {
    const { discoveryFile, controller } = await runningCairn()
    expect(existsSync(discoveryFile)).toBe(true)
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    expect(note).toMatchObject({ app: 'Cairn', port: expect.any(Number), readKey: controller.readKey() })
    expect(note.readKey).not.toBe(controller.key()) // never the key that may add bookmarks
    expect(note.url).toBe('http://127.0.0.1:' + note.port)

    const found = await cli(['ping'], { CAIRN_USER_DATA: dir.replace(/[^/\\]*$/, '') })
    expect(found.code).toBe(1) // ...but only where the app actually keeps its data
    const asked = await cli(['ping', '--url', note.url, '--key', note.readKey])
    expect(asked.code).toBe(0)
    expect(asked.out).toContain('Cairn 1.2.3 is running')
  })

  it('searches, and says how much more there is', async () => {
    const { discoveryFile } = await runningCairn()
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    const where = ['--url', note.url, '--key', note.readKey]

    const all = await cli(['search', ...where])
    expect(all.code).toBe(0)
    expect(all.out).toContain('The Rust language')
    expect(all.out).toContain('Dev/Rust')
    expect(all.out).toContain('3 of 3')

    expect((await cli(['search', 'soup', ...where])).out).toContain('Soup of the day')
    expect((await cli(['search', 'site:github.com', ...where])).out).toContain('A tool')
    expect((await cli(['search', '--scope', 'favorites', ...where])).out).toContain('A tool')
    expect((await cli(['search', '--scope', 'collection:Dev/Rust', '--limit', '1', ...where])).out).toContain('1 of 2 (--offset 1 for more)')
    expect((await cli(['search', 'nothing-like-this', ...where])).out).toBe('Nothing matched.')
  })

  it('shows one bookmark, the collections, the tags and the totals', async () => {
    const { discoveryFile, repo } = await runningCairn()
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    const where = ['--url', note.url, '--key', note.readKey]
    const id = repo.findByUrl('https://recipes.example/soup')?.id as number

    const one = await cli(['get', String(id), ...where])
    expect(one.out).toContain('Soup of the day')
    expect(one.out).toContain('https://recipes.example/soup')
    expect(one.out).toContain('Collection : Unsorted')
    expect(one.out).toContain('Note: the good one')

    expect((await cli(['collections', ...where])).out).toContain('Dev/Rust')
    expect((await cli(['tags', ...where])).out).toMatch(/rust\s+2/)
    expect((await cli(['stats', ...where])).out).toMatch(/bookmarks\s+3/)
  })

  it('prints JSON when asked, for piping into something else', async () => {
    const { discoveryFile } = await runningCairn()
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    const { out, code } = await cli(['search', 'rust', '--json', '--url', note.url, '--key', note.readKey])
    expect(code).toBe(0)
    const body = JSON.parse(out)
    expect(body.total).toBe(2)
    expect(body.bookmarks[0]).toMatchObject({ url: expect.any(String), title: expect.any(String), tags: expect.any(Array) })
  })

  it('says something useful when it cannot get in, or is asked for something it does not do', async () => {
    const { discoveryFile } = await runningCairn()
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))

    const lost = await cli(['stats'], { CAIRN_USER_DATA: join(dir, 'nowhere') })
    expect(lost.code).toBe(1)
    expect(lost.err).toContain('Could not find a running Cairn')

    const wrongKey = await cli(['stats', '--url', note.url, '--key', 'not-the-key'])
    expect(wrongKey.code).toBe(1)
    expect(wrongKey.err).toContain('did not accept the key')

    const unknown = await cli(['frobnicate', '--url', note.url, '--key', note.readKey])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toContain('No such command: frobnicate')

    expect((await cli(['get', 'nonsense', '--url', note.url, '--key', note.readKey])).err).toContain('Give the id')
    expect((await cli(['--help'])).out).toContain('cairn search')
  })

  it('takes the address and key from the environment as well', async () => {
    const { discoveryFile } = await runningCairn()
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    const { code, out } = await cli(['stats'], { CAIRN_URL: note.url, CAIRN_READ_KEY: note.readKey })
    expect(code).toBe(0)
    expect(out).toMatch(/collections\s+2/)
  })

  it('runs as a program, not only as a module', async () => {
    const { discoveryFile } = await runningCairn()
    const note = JSON.parse(readFileSync(discoveryFile, 'utf8'))
    const script = resolve(__dirname, '../bin/cairn.mjs')
    // Waited for without blocking: the API it talks to is running in this very process.
    const { stdout } = await promisify(execFile)(process.execPath, [script, 'stats', '--url', note.url, '--key', note.readKey], { encoding: 'utf8' })
    expect(stdout).toMatch(/bookmarks\s+3/)
  })

  it('takes its note away when the API stops', async () => {
    const { discoveryFile, controller, repo } = await runningCairn()
    expect(existsSync(discoveryFile)).toBe(true)
    applySettingsPatch(repo, { api: { enabled: false } })
    await controller.apply()
    expect(existsSync(discoveryFile)).toBe(false)
  })
})
