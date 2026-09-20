import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu, screen, shell, type Rectangle } from 'electron'
import { isHttpUrl } from '@shared/url'

interface WindowState extends Rectangle {
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { x: 0, y: 0, width: 1280, height: 820, maximized: false }
const stateFile = (): string => join(app.getPath('userData'), 'window-state.json')

function loadState(): Partial<WindowState> & Pick<WindowState, 'width' | 'height' | 'maximized'> {
  try {
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8')) as Partial<WindowState>
    const width = Math.max(900, Number(saved.width) || DEFAULT_STATE.width)
    const height = Math.max(600, Number(saved.height) || DEFAULT_STATE.height)
    const maximized = saved.maximized === true
    const bounds = { x: Number(saved.x), y: Number(saved.y), width, height }
    // Only restore the position if the window would still be visible on a connected display.
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return bounds.x + 100 < a.x + a.width && bounds.x + width - 100 > a.x && bounds.y >= a.y - 20 && bounds.y + 100 < a.y + a.height
    })
    return visible && Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { ...bounds, maximized } : { width, height, maximized }
  } catch {
    return { width: DEFAULT_STATE.width, height: DEFAULT_STATE.height, maximized: false }
  }
}

function saveState(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
  const maximized = win.isMaximized()
  try {
    writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized }))
  } catch {
    // Non-fatal: the window just opens at its default size next time.
  }
}

/** URL of the renderer entry (dev server or packaged file). */
export function rendererEntry(): { kind: 'url'; url: string } | { kind: 'file'; path: string } {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return !app.isPackaged && devUrl ? { kind: 'url', url: devUrl } : { kind: 'file', path: join(__dirname, '../renderer/index.html') }
}

/** Reveals the license files (LICENSE, THIRD_PARTY_LICENSES.txt) in the file manager. */
export function showLegalDocs(): void {
  const dir = app.isPackaged ? join(process.resourcesPath, 'legal') : app.getAppPath()
  shell.showItemInFolder(join(dir, 'LICENSE'))
}

export function isTrustedUrl(url: string): boolean {
  const entry = rendererEntry()
  if (entry.kind === 'url') return url.startsWith(new URL(entry.url).origin)
  return url.startsWith(pathToFileURL(entry.path).href)
}

export function createMainWindow(backgroundColor: string): BrowserWindow {
  const state = loadState()
  const win = new BrowserWindow({
    ...state,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor,
    title: 'Cairn',
    icon: existsSync(join(__dirname, '../../build/icon.png')) ? join(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  let timer: NodeJS.Timeout | undefined
  const scheduleSave = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => saveState(win), 400)
  }
  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('close', () => saveState(win))

  // The app never navigates away from its own UI; web links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return
    event.preventDefault()
    if (isHttpUrl(url)) void shell.openExternal(url)
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  // Native cut/copy/paste menu for text fields.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const items: Electron.MenuItemConstructorOptions[] = params.isEditable
      ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]
      : [{ role: 'copy' }]
    Menu.buildFromTemplate(items).popup({ window: win })
  })

  const entry = rendererEntry()
  if (entry.kind === 'url') void win.loadURL(entry.url)
  else void win.loadFile(entry.path)
  return win
}
