import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, session, shell } from 'electron'
import type { JobProgress, MenuAction, ThemeSetting } from '@shared/types'
import { openDatabase } from './db/database'
import { Repo } from './db/repo'
import { applyTheme, readSettings, registerIpc } from './ipc'
import { buildMenu, focusedOrFirstWindow } from './menu'
import { JobRunner } from './services/jobs'
import { createFileLogger } from './services/logger'
import { createMainWindow, isTrustedUrl, showLegalDocs } from './window'

// Tests (and portable installs) can relocate all app data.
const dataOverride = process.env['CAIRN_USER_DATA']
if (dataOverride) {
  mkdirSync(dataOverride, { recursive: true })
  app.setPath('userData', dataOverride)
}

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason))

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

    const repo = new Repo(openDatabase(join(app.getPath('userData'), 'cairn.db')))
    const settings = readSettings(repo)
    applyTheme(settings)

    const sendToWindow = (channel: string, payload: unknown): void => {
      const win = mainWindow ?? focusedOrFirstWindow()
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    // Records rate limits and connectivity decisions during bulk jobs (Help > Show Connection Log).
    const logFile = join(app.getPath('userData'), 'connection.log')
    const jobs = new JobRunner(repo, (progress: JobProgress) => sendToWindow('job:progress', progress), {
      log: createFileLogger(logFile)
    })

    registerIpc({ repo, jobs, isTrustedUrl, getWindow: () => mainWindow })

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
