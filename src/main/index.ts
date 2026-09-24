import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, session, shell } from 'electron'
import type { JobProgress, MenuAction, ThemeSetting } from '@shared/types'
import { ApiController } from './api/controller'
import { IngestService } from './api/ingest'
import { openDatabase } from './db/database'
import { Repo } from './db/repo'
import { applyTheme, readSettings, registerIpc } from './ipc'
import { buildMenu, focusedOrFirstWindow } from './menu'
import { JobRunner } from './services/jobs'
import { createFileLogger } from './services/logger'
import { ORIGINAL_STATUS_HEADER, useNetworkStack } from './services/metadata'
import { TaggingService } from './tagging/service'
import { createMainWindow, isTrustedUrl, showLegalDocs } from './window'

// Tests (and portable installs) can relocate all app data.
const dataOverride = process.env['CAIRN_USER_DATA']
if (dataOverride) {
  mkdirSync(dataOverride, { recursive: true })
  app.setPath('userData', dataOverride)
}

/** Set once the log file is known, so a crash in the background is recorded where Help can show it. */
let logProblem: ((event: string, data: Record<string, unknown>) => void) | null = null

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
  logProblem?.('unhandled-rejection', { message: reason instanceof Error ? reason.message : String(reason) })
})

// Something failing deep inside a library (the network stack meeting an odd reply, say) should not throw a dialog at
// you in the middle of a run: it is written down, and the app carries on.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
  logProblem?.('uncaught-exception', { message: error instanceof Error ? error.message : String(error) })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.cairn.bookmarks')

    // Deny every permission prompt (camera, geolocation, notifications, ...): the UI needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

    // Look pages up through Chromium's network stack rather than Node's. Sites behind bot protection (Cloudflare and
    // the like) answer it as they answer a browser; Node's fetch is turned away with a challenge page, which arrives
    // as an HTTP 403 and reads like a dead link. The session is its own and is not written to disk, so cookies those
    // pages set are forgotten when the app closes.
    const pageSession = session.fromPartition('cairn-fetch')
    // A reply may only carry a status from 200 to 599. Some sites answer what they take for a bot with 999 (LinkedIn
    // does), and building a reply with that throws deep inside the network stack: the app showed a JavaScript error
    // and the request never finished. Bring such a status into range here, keeping the real number in a header.
    pageSession.webRequest.onHeadersReceived((details, callback) => {
      const code = Number(/^\S+\s+(\d+)/.exec(details.statusLine ?? '')?.[1] ?? 0)
      if (code >= 200 && code <= 599) return callback({})
      callback({
        statusLine: 'HTTP/1.1 599 Unusual Status',
        responseHeaders: { ...details.responseHeaders, [ORIGINAL_STATUS_HEADER]: [String(code)] }
      })
    })
    useNetworkStack((input, init) => pageSession.fetch(String(input), init))

    const repo = new Repo(openDatabase(join(app.getPath('userData'), 'cairn.db')))
    const settings = readSettings(repo)
    applyTheme(settings)

    const sendToWindow = (channel: string, payload: unknown): void => {
      const win = mainWindow ?? focusedOrFirstWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    // Records rate limits and connectivity decisions during bulk jobs (Help > Show Connection Log).
    const logFile = join(app.getPath('userData'), 'connection.log')
    const tagging = new TaggingService(repo, () => readSettings(repo).tagging)
    const log = createFileLogger(logFile)
    logProblem = log
    const jobs = new JobRunner(repo, (progress: JobProgress) => sendToWindow('job:progress', progress), {
      log,
      tagging
    })

    // The local API (browser bookmarklet, command-line tools): runs only while the app is open and switched on.
    const ingest = new IngestService({ repo, tagging, notify: (event) => sendToWindow('capture:changed', event) })
    const api = new ApiController({ repo, ingest, version: app.getVersion(), getSettings: () => readSettings(repo).api, log })
    void api.apply()
    app.on('will-quit', () => void api.stop())

    registerIpc({ repo, jobs, tagging, api, isTrustedUrl, getWindow: () => mainWindow })

    buildMenu({
      send: (action: MenuAction) => sendToWindow('menu:action', action),
      setTheme: (theme: ThemeSetting) => {
        repo.setSettingRaw('theme', theme)
        applyTheme(readSettings(repo))
        sendToWindow('settings:changed', null)
      },
      showLegal: showLegalDocs,
      showLog: () => (existsSync(logFile) ? shell.showItemInFolder(logFile) : void shell.openPath(app.getPath('userData')))
    })

    const open = (): void => {
      mainWindow = createMainWindow(nativeTheme.shouldUseDarkColors ? '#1b1c20' : '#f6f6f8')
      mainWindow.on('closed', () => (mainWindow = null))
    }
    open()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) open()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
