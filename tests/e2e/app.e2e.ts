import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { afterAll, beforeAll, describe, it } from 'vitest'
import type { CairnApi } from '../../src/shared/types'

expect.configure({ timeout: 10_000 })

// Drives the real built app (run `npm run build` first - `npm run test:e2e` does).
// The network is never needed: bookmarks are created with explicit titles, and the one
// URL that goes through the Add dialog uses the reserved `.invalid` TLD so it fails fast.

const root = resolve(__dirname, '../..')
const shots = join(root, 'tests/e2e/screenshots')
const userData = mkdtempSync(join(tmpdir(), 'cairn-e2e-'))
mkdirSync(shots, { recursive: true })

let app: ElectronApplication
let page: Page
const problems: string[] = []

async function launch(): Promise<void> {
  // Set CAIRN_E2E_EXE to test a packaged build (e.g. dist/win-unpacked/Cairn.exe) instead of the source tree.
  const env = { ...process.env, CAIRN_USER_DATA: userData }
  const exe = process.env['CAIRN_E2E_EXE']
  app = await electron.launch(exe ? { executablePath: exe, env } : { args: [root], env: { ...env, NODE_ENV: 'production' } })
  page = await app.firstWindow()
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForSelector('.sidebar')
}

const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`) })
const rows = () => page.locator('li.bm')
const cairn = <T>(fn: (api: CairnApi) => Promise<T>) => page.evaluate(`(${fn.toString()})(window.cairn)`) as Promise<T>

beforeAll(launch)
afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('Cairn (real app)', () => {
  it('starts sandboxed and empty', async () => {
    await expect(page.getByText('Your library is empty')).toBeVisible()
    await shot('01-empty')

    const isolation = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      ipcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer,
      api: Object.keys(window.cairn).sort()
    }))
    expect(isolation.require).toBe('undefined')
    expect(isolation.process).toBe('undefined')
    expect(isolation.ipcRenderer).toBe('undefined')
    expect(isolation.api).toEqual(['app', 'bookmarks', 'collections', 'data', 'metadata', 'on', 'settings', 'tagging', 'tags', 'tools'])

    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
  })

  it('rejects malformed IPC input and non-web URLs', async () => {
    await expect(cairn((api) => api.bookmarks.create({ url: 'javascript:alert(1)' }))).rejects.toThrow()
    await expect(cairn((api) => api.app.openExternal('file:///C:/Windows/System32/calc.exe'))).rejects.toThrow()
    await expect(cairn((api) => api.bookmarks.query({ scope: { kind: 'all' }, sort: 'created', direction: 'asc', limit: 1e9, offset: 0 }))).rejects.toThrow(/Invalid request/)
  })

  it('shows seeded data, sorted and searchable', async () => {
    await cairn(async (api) => {
      const dev = await api.collections.create({ name: 'Dev', color: '#3e63dd' })
      const rust = await api.collections.create({ name: 'Rust', parentId: dev.id })
      await api.collections.create({ name: 'Recipes' })
      const mk = (url: string, title: string, extra = {}) => api.bookmarks.create({ url, title, ...extra })
      await mk('https://www.rust-lang.org/', 'Rust Programming Language', { collectionId: rust.id, tags: ['rust', 'dev'], favorite: true, excerpt: 'A language empowering everyone to build reliable and efficient software.' })
      await mk('https://developer.mozilla.org/', 'MDN Web Docs', { collectionId: dev.id, tags: ['web', 'dev'] })
      await mk('https://news.ycombinator.com/', 'Hacker News', { tags: ['news'] })
      await mk('https://example.com/pasta', 'Best pasta recipe', { note: 'add lots of garlic' })
      return true
    })
    await page.reload()
    await page.waitForSelector('.bm')

    await expect(rows()).toHaveCount(4)
    await expect(page.locator('.sidebar')).toContainText('Dev')
    await expect(page.locator('.sidebar')).toContainText('Recipes')
    // Parent collection count includes its child.
    await expect(page.locator('.nav-item', { hasText: 'Dev' }).first().locator('.nav-count')).toHaveText('2')
    await shot('02-list')

    const search = page.getByLabel('Search bookmarks')
    await search.fill('garlic')
    await expect(rows()).toHaveCount(1)
    await expect(rows().first()).toContainText('Best pasta recipe')
    await search.fill('#dev -mozilla')
    await expect(rows()).toHaveCount(1)
    await expect(rows().first()).toContainText('Rust Programming Language')
    await search.fill('zzzz-nothing')
    await expect(page.getByText('No matches')).toBeVisible()
    await search.fill('')
    await expect(rows()).toHaveCount(4)
  })

  it('switches layouts and themes', async () => {
    await page.getByRole('button', { name: 'Grid layout' }).click()
    await expect(page.locator('.bm-list.grid')).toBeVisible()
    await shot('03-grid')
    await page.getByRole('button', { name: 'Headlines layout' }).click()
    await expect(page.locator('.bm-list.headlines')).toBeVisible()
    await shot('04-headlines')
    await page.getByRole('button', { name: 'List layout' }).click()

    // The main process owns the theme (nativeTheme). Playwright pins its own colour-scheme
    // emulation, so check the native side directly and emulate the media query for the screenshot.
    await cairn((api) => api.settings.set({ theme: 'dark' }))
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    await page.emulateMedia({ colorScheme: 'dark' })
    await shot('05-dark')
    await cairn((api) => api.settings.set({ theme: 'light' }))
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
    await page.emulateMedia({ colorScheme: 'light' })
  })

  it('navigates collections and tags from the sidebar', async () => {
    await page.locator('.nav-item', { hasText: 'Dev' }).first().click()
    await expect(rows()).toHaveCount(2)
    await page.locator('.nav-item', { hasText: 'Favorites' }).click()
    await expect(rows()).toHaveCount(1)
    await page.locator('.nav-item', { hasText: 'Unsorted' }).click()
    await expect(rows()).toHaveCount(2)
    await page.locator('.nav-item', { hasText: 'news' }).click()
    await expect(rows()).toHaveCount(1)
    await page.locator('.nav-item', { hasText: 'All bookmarks' }).click()
    await expect(rows()).toHaveCount(4)
  })

  it('edits a bookmark in the side panel and persists the changes', async () => {
    await rows().filter({ hasText: 'Hacker News' }).click()
    await page.keyboard.press('e')
    const editor = page.getByRole('complementary', { name: 'Edit bookmark' })
    await expect(editor).toBeVisible()
    await editor.getByLabel('Title').fill('HN front page')
    await editor.getByLabel('Title').blur()
    await editor.getByPlaceholder('Add a private note…').fill('read in the morning')
    await editor.getByPlaceholder('Add a private note…').blur()
    await editor.getByLabel('Tags').fill('daily')
    await editor.getByLabel('Tags').press('Enter')
    await expect(rows().filter({ hasText: 'HN front page' })).toHaveCount(1)
    await shot('06-editor')

    const saved = await cairn((api) => api.bookmarks.query({ scope: { kind: 'all' }, search: 'front', sort: 'created', direction: 'desc', limit: 5, offset: 0 }))
    expect(saved.items[0]).toMatchObject({ title: 'HN front page', note: 'read in the morning', tags: ['daily', 'news'] })
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
  })

  it('adds a bookmark through the dialog even when the page cannot be reached', async () => {
    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add bookmark' })
    await dialog.getByLabel('Link').fill('unreachable.invalid/some/page')
    await expect(dialog.getByText(/Couldn.t reach that page/)).toBeVisible({ timeout: 20_000 })
    await dialog.getByLabel('Title').fill('Offline page')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Bookmark saved')).toBeVisible()
    await expect(rows().filter({ hasText: 'Offline page' })).toHaveCount(1)
    await shot('07-added')

    // The same URL is flagged as a duplicate the next time.
    await page.getByRole('button', { name: 'Add' }).click()
    await page.getByRole('dialog', { name: 'Add bookmark' }).getByLabel('Link').fill('https://unreachable.invalid/some/page/')
    await expect(page.getByText(/Already saved as/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  it('offers "Refresh details" in the right-click menu and explains when the site cannot be reached', async () => {
    const row = rows().filter({ hasText: 'Offline page' })
    await row.click({ button: 'right' })
    const item = page.getByRole('menuitem', { name: 'Refresh details' })
    await expect(item).toBeEnabled()
    await shot('07b-context-menu')
    await item.click()
    // (an unreachable .invalid host fails in milliseconds, so the "Fetching details…" toast is too brief to assert on)
    await expect(page.getByText(/Could not reach the site/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Fetching details…')).toBeHidden() // the progress toast is replaced by the result

    // With several bookmarks selected the entry is disabled (it works on one bookmark at a time).
    await rows().first().click()
    await rows().nth(1).click({ modifiers: ['Shift'] })
    await rows().nth(1).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Refresh details' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  it('moves to Trash with undo, and restores', async () => {
    await rows().filter({ hasText: 'Offline page' }).click()
    await page.keyboard.press('Delete')
    await expect(rows().filter({ hasText: 'Offline page' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(rows().filter({ hasText: 'Offline page' })).toHaveCount(1)

    await rows().filter({ hasText: 'Offline page' }).click()
    await page.keyboard.press('Delete')
    await page.locator('.nav-item', { hasText: 'Trash' }).click()
    await expect(rows()).toHaveCount(1)
    await shot('08-trash')
    await rows().first().hover()
    await page.getByRole('button', { name: 'Restore' }).click()
    await expect(rows()).toHaveCount(0)
    await page.locator('.nav-item', { hasText: 'All bookmarks' }).click()
    await expect(rows()).toHaveCount(5)
  })

  it('drags a bookmark onto a collection', async () => {
    const source = rows().filter({ hasText: 'Best pasta recipe' })
    await source.dragTo(page.locator('.nav-item', { hasText: 'Recipes' }))
    await expect(page.getByText(/Moved 1 bookmark to Recipes/)).toBeVisible()
    await page.locator('.nav-item', { hasText: 'Recipes' }).click()
    await expect(rows()).toHaveCount(1)
    await page.locator('.nav-item', { hasText: 'All bookmarks' }).click()
  })

  it('multi-selects and bulk-tags', async () => {
    await rows().first().click()
    await rows().nth(1).click({ modifiers: ['Shift'] })
    await expect(page.getByText('2 selected')).toBeVisible()
    await shot('09-bulk')
    await page.getByRole('button', { name: 'Favorite', exact: true }).click()
    const favs = await cairn((api) => api.bookmarks.query({ scope: { kind: 'favorites' }, sort: 'created', direction: 'desc', limit: 10, offset: 0 }))
    expect(favs.total).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Escape')
  })

  it('finds duplicates in the tools dialog', async () => {
    await cairn(async (api) => {
      await api.bookmarks.create({ url: 'http://example.com/pasta/?utm_source=x', title: 'Pasta again' })
      return true
    })
    await page.getByRole('button', { name: 'Tools' }).click()
    const dialog = page.getByRole('dialog', { name: 'Duplicates & broken links' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Best pasta recipe')).toBeVisible()
    await expect(dialog.getByText('Pasta again')).toBeVisible()
    await shot('10-tools')
    await dialog.getByRole('button', { name: /Keep the oldest of each/ }).click()
    await expect(dialog.getByText('No duplicates found.')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  it('creates and deletes collections with confirmation', async () => {
    await page.getByRole('button', { name: 'New collection' }).click()
    await page.getByLabel('Name').fill('Temp')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.locator('.nav-item', { hasText: 'Temp' })).toBeVisible()
    await page.locator('.nav-item', { hasText: 'Temp' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Delete collection/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete collection' }).click()
    await expect(page.locator('.nav-item', { hasText: 'Temp' })).toHaveCount(0)
  })

  it('suggests tags in the Add dialog, hides the ones you took, and saves accepted ones as yours', async () => {
    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add bookmark' })
    await dialog.getByLabel('Link').fill('unreachable.invalid/docs/tutorial/intro-guide.pdf')
    const chips = dialog.getByLabel('Suggested tags')
    await expect(chips.getByRole('button', { name: /pdf/ })).toBeVisible({ timeout: 20_000 })
    await expect(chips.getByRole('button', { name: /docs/ })).toBeVisible()
    await shot('12-suggestions')
    await chips.getByRole('button', { name: /pdf/ }).click()
    await expect(dialog.locator('.tag-input .chip', { hasText: 'pdf' })).toBeVisible()
    await expect(chips.getByRole('button', { name: /pdf/ })).toBeHidden() // a tag you took is no longer offered
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Bookmark saved')).toBeVisible()

    const saved = await cairn((api) => api.bookmarks.query({ scope: { kind: 'all' }, search: 'intro-guide', sort: 'created', direction: 'desc', limit: 5, offset: 0 }))
    expect(saved.items[0]).toMatchObject({ tags: ['pdf'], autoTags: [] }) // clicked by the user, so it is the user's own tag
  })

  it('in Auto mode fills in tags for you and marks them as automatic', async () => {
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByText('Auto-tagging')).toBeVisible()
    await page.getByRole('button', { name: 'Auto', exact: true }).click()
    await expect(page.getByText(/Also adds them for you/)).toBeVisible()
    await shot('13-settings-tagging')
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Add' }).click()
    const dialog = page.getByRole('dialog', { name: 'Add bookmark' })
    await dialog.getByLabel('Link').fill('unreachable.invalid/recipes/pancakes.pdf')
    await expect(dialog.locator('.tag-input .chip.auto', { hasText: 'pdf' })).toBeVisible({ timeout: 20_000 })
    await expect(dialog.locator('.tag-input .chip.auto', { hasText: 'recipes' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Bookmark saved').last()).toBeVisible()

    const saved = await cairn((api) => api.bookmarks.query({ scope: { kind: 'all' }, search: 'pancakes', sort: 'created', direction: 'desc', limit: 5, offset: 0 }))
    expect(saved.items[0]?.autoTags).toEqual(expect.arrayContaining(['pdf', 'recipes']))
    await expect(page.locator('li.bm .tag-pill.auto', { hasText: 'recipes' })).toBeVisible() // dashed pill in the list

    // back to Suggest for the remaining tests
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Suggest', exact: true }).click()
    await page.keyboard.press('Escape')
  })

  it('offers Suggest tags in the editor', async () => {
    await rows().filter({ hasText: 'Rust Programming Language' }).click()
    await page.keyboard.press('e')
    const editor = page.getByRole('complementary', { name: 'Edit bookmark' })
    await editor.getByRole('button', { name: /Suggest tags/ }).click()
    const chips = editor.getByLabel('Suggested tags')
    await expect(chips.getByRole('button', { name: /programming/ })).toBeVisible()
    await chips.getByRole('button', { name: /programming/ }).click()
    await expect(editor.locator('.tag-input .chip', { hasText: 'programming' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  })

  it('rejects malformed custom rules with a clear message and keeps the old ones', async () => {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByText('Custom rules (advanced)').click()
    const box = page.getByLabel('Custom tagging rules')
    await box.fill('{nope')
    await box.blur()
    await expect(page.getByText(/Custom rules: Not valid JSON/)).toBeVisible()
    await box.fill('{"domains": {"example.net": ["my-tag"]}}')
    await box.blur()
    const settings = await cairn((api) => api.settings.get())
    expect(settings.tagging.userRules).toContain('example.net')
    await page.keyboard.press('Escape')
  })

  it('auto-tags in bulk, reviews suggestions by tag, and can undo', async () => {
    await cairn(async (api) => {
      await api.bookmarks.create({ url: 'https://unreachable.invalid/docker-one', title: 'Docker networking explained' })
      await api.bookmarks.create({ url: 'https://unreachable.invalid/docker-two', title: 'Docker Compose tutorial' })
      return true
    })
    await page.reload()
    await page.waitForSelector('.bm')

    await page.getByRole('button', { name: 'Tools' }).click()
    const tools = page.getByRole('dialog', { name: 'Duplicates & broken links' })
    await tools.getByRole('button', { name: 'Auto-tag untagged bookmarks' }).click()
    await expect(page.getByText(/tags? suggested for/).first()).toBeVisible({ timeout: 20_000 })
    await shot('14-autotag-tools')
    await tools.getByRole('button', { name: /Review suggestions/ }).click()

    // Suggestions are grouped by tag: one decision covers many bookmarks.
    const review = page.getByRole('dialog', { name: 'Review suggested tags' })
    const docker = review.locator('.review-group', { hasText: 'docker' })
    await expect(docker).toContainText('2 bookmarks')
    await docker.locator('.review-toggle').click()
    await expect(docker.locator('.review-items li')).toHaveCount(2)
    await shot('15-review')

    // Untick one bookmark and add the tag to the other only.
    await docker.locator('.review-items li').first().locator('input[type=checkbox]').uncheck()
    await docker.getByRole('button', { name: /Add to 1 selected/ }).click()
    await expect(page.getByText(/1 bookmark tagged/)).toBeVisible()
    const tagged = await cairn((api) => api.bookmarks.query({ scope: { kind: 'all' }, search: '#docker', sort: 'created', direction: 'desc', limit: 5, offset: 0 }))
    expect(tagged.total).toBe(1)
    expect(tagged.items[0]?.autoTags).toContain('docker')

    // The other one is still pending: skip it, and it disappears from the review.
    await review.locator('.review-group', { hasText: 'docker' }).getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(review.locator('.review-group', { hasText: 'docker' })).toHaveCount(0)

    // Add everything that is left in one go, then undo that whole run from Tools.
    const remaining = await cairn((api) => api.tagging.review.count())
    expect(remaining).toBeGreaterThan(0)
    await review.getByRole('button', { name: /Add all/ }).click()
    await expect(page.getByText(/tags? added/).first()).toBeVisible()
    expect(await cairn((api) => api.tagging.review.count())).toBe(0)
    const run = await cairn((api) => api.tagging.runs.last())
    expect(run).toMatchObject({ kind: 'review-all', undone: false })
    await expect(review.getByText('Nothing to review.')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Tools' }).click()
    await page.getByRole('dialog', { name: 'Duplicates & broken links' }).getByRole('button', { name: /Undo last run/ }).click()
    await expect(page.getByText(/Removed \d+ automatic tag/)).toBeVisible()
    const after = await cairn((api) => api.tagging.runs.last())
    expect(after?.id).not.toBe(run?.id) // that run is undone; the earlier one (docker) is now the latest
    await page.keyboard.press('Escape')
  })

  it('has no renderer errors or CSP violations', () => {
    expect(problems).toEqual([])
  })

  it('keeps data across restarts and remembers settings', async () => {
    await cairn((api) => api.settings.set({ view: 'grid' }))
    const before = await cairn((api) => api.data.counts())
    await app.close()
    await launch()
    await page.waitForSelector('.bm')
    const after = await cairn((api) => api.data.counts())
    expect(after).toEqual(before)
    await expect(page.locator('.bm-list.grid')).toBeVisible()
    await shot('11-after-restart')
  })
})
