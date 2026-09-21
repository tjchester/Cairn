import { useCallback, useEffect, useRef, useState } from 'react'
import type { MenuAction } from '@shared/types'
import { extractUrls } from '@shared/url'
import { AddDialog } from './components/AddDialog'
import { BookmarkList } from './components/BookmarkList'
import { SettingsDialog, ShortcutsDialog, ToolsDialog } from './components/Dialogs'
import { Editor } from './components/Editor'
import { ReviewDialog } from './components/ReviewDialog'
import { Sidebar } from './components/Sidebar'
import { BulkBar, Toolbar } from './components/Toolbar'
import { ConfirmDialog, ContextMenu, PromptDialog, Toasts } from './components/ui'
import { useStore } from './store'
import { isTextInput } from './util'

const api = window.cairn

function DialogHost(): React.JSX.Element | null {
  const dialog = useStore((s) => s.dialog)
  if (!dialog) return null
  switch (dialog.type) {
    case 'add':
      return <AddDialog initialUrls={dialog.urls} />
    case 'settings':
      return <SettingsDialog />
    case 'tools':
      return <ToolsDialog />
    case 'shortcuts':
      return <ShortcutsDialog />
    case 'review-tags':
      return <ReviewDialog />
    case 'confirm':
      return <ConfirmDialog {...dialog} />
    case 'prompt':
      return <PromptDialog {...dialog} />
  }
}

export function App(): React.JSX.Element {
  const store = useStore
  const ready = useStore((s) => s.ready)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const sidebarWidth = useStore((s) => s.settings.sidebarWidth)
  const editing = useStore((s) => (s.editingId === null ? null : (s.items.find((b) => b.id === s.editingId) ?? null)))
  const searchRef = useRef<HTMLInputElement>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [dropActive, setDropActive] = useState(false)

  const focusSearch = useCallback(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [])

  // Startup + events from the main process.
  useEffect(() => {
    document.documentElement.dataset.platform = api.app.platform
    void store.getState().init()
    const offMenu = api.on.menuAction((action: MenuAction) => {
      const s = store.getState()
      switch (action) {
        case 'new-bookmark':
          return s.openAdd()
        case 'new-collection':
          return void s.createCollection(null)
        case 'import':
          return void s.importFile()
        case 'export-html':
          return void s.exportFile('html')
        case 'export-csv':
          return void s.exportFile('csv')
        case 'export-json':
          return void s.exportFile('json')
        case 'focus-search':
          return focusSearch()
        case 'toggle-sidebar':
          return s.toggleSidebar()
        case 'view-list':
          return void s.updateSettings({ view: 'list' })
        case 'view-grid':
          return void s.updateSettings({ view: 'grid' })
        case 'view-headlines':
          return void s.updateSettings({ view: 'headlines' })
        case 'open-tools':
          return s.openDialog({ type: 'tools' })
        case 'open-settings':
          return s.openDialog({ type: 'settings' })
        case 'open-shortcuts':
          return s.openDialog({ type: 'shortcuts' })
        case 'copy-bookmarklet':
          return void s.copyBookmarklet()
      }
    })
    const offJob = api.on.jobProgress((p) => store.getState().onJobProgress(p))
    const offSettings = api.on.settingsChanged(() => void store.getState().reloadSettings())
    const offCapture = api.on.captureChanged((e) => store.getState().onCapture(e))
    return () => {
      offMenu()
      offJob()
      offSettings()
      offCapture()
    }
  }, [store, focusSearch])

  // Keyboard shortcuts that are not menu accelerators.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = store.getState()
      if (s.dialog) return
      const mod = e.ctrlKey || e.metaKey
      const typing = isTextInput(e.target)

      if (e.key === 'Escape') {
        if (s.context) return s.hideContext()
        if (s.editingId !== null) return s.setEditing(null)
        if (s.selected.size > 0) return s.clearSelection()
        return
      }
      if (typing) return

      if (e.key === '/' && !mod) {
        e.preventDefault()
        return focusSearch()
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        return s.selectAll()
      }
      if (mod || e.altKey) return

      const ids = [...s.selected]
      const only = ids.length === 1 ? s.items.find((b) => b.id === ids[0]) : undefined
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          return s.moveSelection(1)
        case 'ArrowUp':
          e.preventDefault()
          return s.moveSelection(-1)
        case 'Enter':
          if (only && !only.deletedAt) return void s.openBookmark(only)
          return
        case 'e':
        case 'E':
          if (only && !only.deletedAt) return s.setEditing(only.id)
          return
        case 'f':
        case 'F':
          if (ids.length > 0 && s.scope.kind !== 'trash') return void s.toggleFavorite(ids)
          return
        case 'Delete':
        case 'Backspace':
          if (ids.length === 0) return
          return void (s.scope.kind === 'trash' ? s.purgeIds(ids) : s.trashIds(ids))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store, focusSearch])

  // Pasting a URL anywhere outside a text field starts "Add bookmark".
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (isTextInput(e.target) || store.getState().dialog) return
      const urls = extractUrls(e.clipboardData?.getData('text') ?? '')
      if (urls.length === 0) return
      e.preventDefault()
      store.getState().openAdd(urls)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [store])

  // Dragging a link (or several) from a browser onto the window.
  const onDragOver = (e: React.DragEvent): void => {
    const types = e.dataTransfer.types
    if (types.includes('text/uri-list') || (types.includes('text/plain') && !types.includes('application/x-cairn-bookmarks'))) {
      if (types.includes('application/x-cairn-bookmarks') || types.includes('application/x-cairn-collection')) return
      e.preventDefault()
      setDropActive(true)
    }
  }
  const onDrop = (e: React.DragEvent): void => {
    setDropActive(false)
    if (e.dataTransfer.types.includes('application/x-cairn-bookmarks') || e.dataTransfer.types.includes('application/x-cairn-collection')) return
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    const urls = extractUrls(text)
    if (urls.length === 0) return
    e.preventDefault()
    store.getState().openAdd(urls)
  }

  // Sidebar resizing.
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = store.getState().settings.sidebarWidth
    let latest = startWidth
    const move = (ev: PointerEvent): void => {
      latest = Math.max(180, Math.min(480, Math.round(startWidth + ev.clientX - startX)))
      setDragWidth(latest)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragWidth(null)
      if (latest !== startWidth) void store.getState().updateSettings({ sidebarWidth: latest })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const width = dragWidth ?? sidebarWidth

  return (
    <div
      className={`app${sidebarOpen ? '' : ' no-sidebar'}${dropActive ? ' drop-active' : ''}`}
      style={{ ['--sidebar-w' as string]: `${width}px` }}
      onDragOver={onDragOver}
      onDragLeave={(e) => e.currentTarget === e.target && setDropActive(false)}
      onDrop={onDrop}
      onClick={() => store.getState().hideContext()}
    >
      {sidebarOpen && (
        <>
          <Sidebar />
          <div className="resizer" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" />
        </>
      )}
      <main className="main">
        <Toolbar searchRef={searchRef} />
        <BulkBar />
        {ready ? <BookmarkList /> : <div className="list-scroll" />}
        {dropActive && <div className="drop-hint">Drop a link to save it</div>}
      </main>
      {editing && <Editor key={editing.id} bookmark={editing} />}
      <DialogHost />
      <ContextMenu />
      <Toasts />
    </div>
  )
}
