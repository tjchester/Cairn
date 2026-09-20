import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuAction, ThemeSetting } from '@shared/types'

interface MenuHooks {
  send: (action: MenuAction) => void
  setTheme: (theme: ThemeSetting) => void
  showLegal: () => void
  showLog: () => void
}

export function buildMenu({ send, setTheme, showLegal, showLog }: MenuHooks): void {
  const isMac = process.platform === 'darwin'
  const action = (label: string, id: MenuAction, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(id)
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              action('Settings…', 'open-settings', 'Cmd+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        action('New Bookmark…', 'new-bookmark', 'CmdOrCtrl+N'),
        action('New Collection…', 'new-collection', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        action('Import Bookmarks…', 'import', 'CmdOrCtrl+Shift+I'),
        {
          label: 'Export Bookmarks',
          submenu: [
            action('Browser HTML…', 'export-html'),
            action('CSV…', 'export-csv'),
            action('Cairn backup (JSON)…', 'export-json')
          ]
        },
        { type: 'separator' },
        ...(isMac ? [] : [action('Settings…', 'open-settings', 'Ctrl+,'), { type: 'separator' } as const]),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        action('Find…', 'focus-search', 'CmdOrCtrl+F')
      ]
    },
    {
      label: 'View',
      submenu: [
        action('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        { type: 'separator' },
        action('List Layout', 'view-list', 'CmdOrCtrl+1'),
        action('Grid Layout', 'view-grid', 'CmdOrCtrl+2'),
        action('Headlines Layout', 'view-headlines', 'CmdOrCtrl+3'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'Match System', click: () => setTheme('system') },
            { label: 'Light', click: () => setTheme('light') },
            { label: 'Dark', click: () => setTheme('dark') }
          ]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' } as const, { role: 'reload' } as const, { role: 'toggleDevTools' } as const])
      ]
    },
    {
      label: 'Tools',
      submenu: [action('Find Duplicates, Check Links…', 'open-tools', 'CmdOrCtrl+Shift+T')]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        action('Keyboard Shortcuts', 'open-shortcuts', 'CmdOrCtrl+/'),
        { label: 'Licenses', click: showLegal },
        { label: 'Show Connection Log', click: showLog },
        { type: 'separator' },
        {
          label: 'Learn More About Electron',
          click: () => void shell.openExternal('https://www.electronjs.org')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function focusedOrFirstWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}
