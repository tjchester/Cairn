import { create } from 'zustand'
import {
  DEFAULT_SETTINGS,
  type Bookmark,
  type BookmarkPatch,
  type CaptureEvent,
  type Collection,
  type Counts,
  type ExportFormat,
  type JobKind,
  type JobProgress,
  type Scope,
  type Settings,
  type SettingsPatch,
  type StartJobOptions,
  type TagInfo
} from '@shared/types'
import type { IconName } from './icons'
import { byName } from '@shared/collections'
import { useScheme } from './theme'
import { errorMessage, sameScope } from './util'

const api = window.cairn
const PAGE_SIZE = 100
const MAX_DEPTH = 1000

export interface ContextItem {
  label?: string
  icon?: IconName
  color?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  checked?: boolean
  onClick?: () => void
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
  action?: { label: string; onClick: () => void }
}

export type DialogState =
  | { type: 'add'; urls?: string[] }
  | { type: 'settings' }
  | { type: 'tools' }
  | { type: 'shortcuts' }
  | { type: 'review-tags' }
  | { type: 'tidy-tags' }
  | { type: 'confirm'; title: string; message: string; confirmLabel: string; danger?: boolean }
  | { type: 'prompt'; title: string; label: string; initial: string; confirmLabel: string; placeholder?: string }

interface Store {
  ready: boolean
  settings: Settings
  collections: Collection[]
  counts: Counts
  /** Suggested tags waiting for review. */
  pendingProposals: number
  tags: TagInfo[]
  scope: Scope
  search: string
  /** Show what is in the Archive in the ordinary lists as well. Off by default, and not remembered. */
  includeArchived: boolean
  /** In a collection, leave out what is filed in its sub-collections. Off by default, and not remembered. */
  directOnly: boolean
  items: Bookmark[]
  total: number
  loading: boolean
  selected: Set<number>
  anchorId: number | null
  editingId: number | null
  sidebarOpen: boolean
  expanded: Record<number, boolean>
  dialog: DialogState | null
  context: { x: number; y: number; items: ContextItem[] } | null
  toasts: Toast[]
  job: JobProgress | null

  init(): Promise<void>
  reload(options?: { keepDepth?: boolean }): Promise<void>
  loadMore(): Promise<void>
  refreshMeta(): Promise<void>
  refreshAll(): Promise<void>
  reloadSettings(): Promise<void>

  setScope(scope: Scope): void
  setSearch(text: string): void
  setIncludeArchived(on: boolean): void
  setDirectOnly(on: boolean): void
  /** Sends bookmarks to the Archive (or brings them back), rebuilding the folders they were in. */
  archiveBookmarks(ids: number[]): Promise<void>
  restoreBookmarks(ids: number[]): Promise<void>
  archiveCollection(id: number): Promise<void>
  restoreCollection(id: number): Promise<void>
  updateSettings(patch: SettingsPatch): Promise<void>
  toggleSidebar(): void
  toggleExpanded(id: number): void

  selectOnly(id: number): void
  toggleSelect(id: number): void
  selectRange(id: number): void
  selectAll(): Promise<void>
  clearSelection(): void
  moveSelection(delta: number): void
  setEditing(id: number | null): void

  saveBookmark(id: number, patch: BookmarkPatch): Promise<Bookmark | null>
  toggleFavorite(ids: number[]): Promise<void>
  moveToCollection(ids: number[], collectionId: number | null): Promise<void>
  addTags(ids: number[], tags: string[]): Promise<void>
  trashIds(ids: number[]): Promise<void>
  restoreIds(ids: number[]): Promise<void>
  purgeIds(ids: number[]): Promise<void>
  emptyTrash(): Promise<void>
  openBookmark(bookmark: Bookmark): Promise<void>
  copyLink(bookmark: Bookmark): Promise<void>
  /** Re-fetches one bookmark's title, description, cover and icon. Returns the updated bookmark, or null on failure. */
  refreshDetails(id: number): Promise<Bookmark | null>

  createCollection(parentId: number | null): Promise<void>
  renameCollection(id: number): Promise<void>
  colorCollection(id: number, color: string | null): Promise<void>
  deleteCollection(id: number): Promise<void>
  moveCollection(id: number, parentId: number | null, index: number): Promise<void>
  renameTag(name: string): Promise<void>
  deleteTag(name: string): Promise<void>

  importFile(): Promise<void>
  exportFile(format: ExportFormat): Promise<void>
  startJob(kind: JobKind, options?: StartJobOptions): Promise<void>
  cancelJob(): Promise<void>
  onJobProgress(progress: JobProgress): void

  /** Puts the browser bookmarklet on the clipboard (offering to turn the local API on first). */
  copyBookmarklet(): Promise<void>
  /** Puts back what a "Tidy tags" run changed. */
  undoTidy(id: number): Promise<void>
  resetApiKey(): Promise<void>
  onCapture(event: CaptureEvent): void

  openAdd(urls?: string[]): void
  openDialog(dialog: Extract<DialogState, { type: 'settings' | 'tools' | 'shortcuts' | 'review-tags' | 'tidy-tags' }>): void
  closeDialog(result?: unknown): void
  confirm(options: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean>
  prompt(options: { title: string; label: string; initial?: string; confirmLabel: string; placeholder?: string }): Promise<string | null>
  showContext(x: number, y: number, items: ContextItem[]): void
  hideContext(): void
  toast(message: string, kind?: Toast['kind'], action?: Toast['action']): number
  dismissToast(id: number): void
}

const emptyCounts: Counts = { all: 0, unsorted: 0, favorites: 0, broken: 0, trash: 0, archived: 0, byCollection: {} }

let requestSeq = 0
let loadingMore = false
let searchTimer: ReturnType<typeof setTimeout> | undefined
let toastSeq = 0
let dialogResolver: ((value: unknown) => void) | null = null

function loadExpanded(): Record<number, boolean> {
  try {
    return JSON.parse(localStorage.getItem('cairn.expanded') ?? '{}') as Record<number, boolean>
  } catch {
    return {}
  }
}

function saveExpanded(value: Record<number, boolean>): void {
  try {
    localStorage.setItem('cairn.expanded', JSON.stringify(value))
  } catch {
    // Not persisted; harmless.
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const useStore = create<Store>((set, get) => {
  /** Runs an action, surfacing failures as toasts instead of unhandled rejections. */
  async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (error) {
      get().toast(errorMessage(error), 'error')
      return undefined
    }
  }

  const ask = <T>(dialog: DialogState): Promise<T | null> =>
    new Promise((resolve) => {
      dialogResolver?.(null)
      dialogResolver = resolve as (value: unknown) => void
      set({ dialog })
    })

  return {
    ready: false,
    settings: DEFAULT_SETTINGS,
    collections: [],
    counts: emptyCounts,
    pendingProposals: 0,
    tags: [],
    scope: { kind: 'all' },
    search: '',
    includeArchived: false,
    directOnly: false,
    items: [],
    total: 0,
    loading: false,
    selected: new Set(),
    anchorId: null,
    editingId: null,
    sidebarOpen: true,
    expanded: loadExpanded(),
    dialog: null,
    context: null,
    toasts: [],
    job: null,

    // ------------------------------------------------------------- loading
    async init() {
      await get().reloadSettings()
      await get().refreshAll()
      set({ ready: true })
    },

    async reloadSettings() {
      const settings = await api.settings.get()
      useScheme(settings.scheme)
      set({ settings })
    },

    async reload(options = {}) {
      const seq = ++requestSeq
      const { scope, search, settings, items } = get()
      const limit = options.keepDepth ? Math.min(MAX_DEPTH, Math.max(PAGE_SIZE, items.length)) : PAGE_SIZE
      set({ loading: true })
      try {
        const page = await api.bookmarks.query({ scope, search, includeArchived: get().includeArchived, directOnly: get().directOnly, sort: settings.sort, direction: settings.direction, limit, offset: 0 })
        if (seq !== requestSeq) return
        const present = new Set(page.items.map((b) => b.id))
        // Forget bookmarks that have gone, but only when this page is the whole list: a selection may reach past it.
        const whole = page.items.length >= page.total
        set((s) => ({
          items: page.items,
          total: page.total,
          loading: false,
          selected: whole ? new Set([...s.selected].filter((id) => present.has(id))) : s.selected,
          editingId: s.editingId !== null && present.has(s.editingId) ? s.editingId : null
        }))
      } catch (error) {
        if (seq !== requestSeq) return
        set({ loading: false })
        get().toast(errorMessage(error), 'error')
      }
    },

    async loadMore() {
      const { items, total, loading, scope, search, settings } = get()
      if (loading || loadingMore || items.length >= total) return
      loadingMore = true
      const seq = requestSeq
      try {
        const page = await api.bookmarks.query({ scope, search, includeArchived: get().includeArchived, directOnly: get().directOnly, sort: settings.sort, direction: settings.direction, limit: PAGE_SIZE, offset: items.length })
        if (seq !== requestSeq) return
        set((s) => {
          const known = new Set(s.items.map((b) => b.id))
          return { items: [...s.items, ...page.items.filter((b) => !known.has(b.id))], total: page.total }
        })
      } catch (error) {
        get().toast(errorMessage(error), 'error')
      } finally {
        loadingMore = false
      }
    },

    async refreshMeta() {
      const [collections, counts, tags, pendingProposals] = await Promise.all([
        api.collections.list(),
        api.data.counts(),
        api.tags.list(),
        api.tagging.review.count()
      ])
      // A–Z everywhere the tags are shown (the sidebar, the tag picker, the editor).
      set({ collections, counts, tags: [...tags].sort((a, b) => byName.compare(a.name, b.name)), pendingProposals })
    },

    async refreshAll() {
      await Promise.all([get().refreshMeta(), get().reload({ keepDepth: true })])
    },

    // ---------------------------------------------------------- navigation
    setScope(scope) {
      if (sameScope(scope, get().scope) && !get().search) return
      clearTimeout(searchTimer)
      set({ scope, search: '', selected: new Set(), anchorId: null, editingId: null })
      void get().reload()
    },

    setSearch(text) {
      set({ search: text })
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => void get().reload(), 180)
    },

    async updateSettings(patch) {
      const previous = get().settings
      // Simple settings apply at once; the nested tagging block waits for the saved (merged, validated) result.
      const { tagging: _tagging, api: _api, ...simple } = patch
      set({ settings: { ...previous, ...simple } })
      const saved = await guard(() => api.settings.set(patch))
      if (!saved) {
        set({ settings: previous })
        return
      }
      set({ settings: saved })
      useScheme(saved.scheme)
      if (patch.sort !== undefined || patch.direction !== undefined) await get().reload()
    },

    setIncludeArchived(on) {
      set({ includeArchived: on })
      void get().reload()
    },

    setDirectOnly(on) {
      set({ directOnly: on })
      void get().reload()
    },

    async archiveBookmarks(ids) {
      const moved = await guard(() => api.archive.bookmarks(ids))
      if (moved === undefined) return
      get().toast(
        moved === 0 ? 'Already in the Archive' : plural(moved, 'bookmark') + ' sent to the Archive',
        moved === 0 ? 'info' : 'success',
        moved > 0 ? { label: 'Undo', onClick: () => void get().restoreBookmarks(ids) } : undefined
      )
      set({ selected: new Set() })
      await get().refreshAll()
    },

    async restoreBookmarks(ids) {
      const moved = await guard(() => api.archive.restoreBookmarks(ids))
      if (moved === undefined) return
      get().toast(moved === 0 ? 'Nothing to bring back' : plural(moved, 'bookmark') + ' brought back from the Archive', moved === 0 ? 'info' : 'success')
      set({ selected: new Set() })
      await get().refreshAll()
    },

    async archiveCollection(id) {
      const collection = get().collections.find((c) => c.id === id)
      const yes = await get().confirm({
        title: 'Send "' + (collection?.name ?? 'this collection') + '" to the Archive?',
        message: 'It keeps its bookmarks and sub-collections, and the folders it sits in are rebuilt inside the Archive. It is then left out of searches and exports.',
        confirmLabel: 'Send to Archive'
      })
      if (!yes) return
      const moved = await guard(() => api.archive.collections([id]))
      if (moved === undefined) return
      get().toast(moved > 0 ? 'Sent to the Archive' : 'Already in the Archive', moved > 0 ? 'success' : 'info', moved > 0 ? { label: 'Undo', onClick: () => void get().restoreCollection(id) } : undefined)
      await get().refreshAll()
    },

    async restoreCollection(id) {
      const moved = await guard(() => api.archive.restoreCollections([id]))
      if (moved === undefined) return
      get().toast(moved > 0 ? 'Brought back from the Archive' : 'Nothing to bring back', moved > 0 ? 'success' : 'info')
      await get().refreshAll()
    },

    toggleSidebar() {
      set((s) => ({ sidebarOpen: !s.sidebarOpen }))
    },

    toggleExpanded(id) {
      set((s) => {
        const expanded = { ...s.expanded, [id]: !(s.expanded[id] ?? false) }
        saveExpanded(expanded)
        return { expanded }
      })
    },

    // ----------------------------------------------------------- selection
    selectOnly(id) {
      // While the details pane is open it follows the selection, so clicking through the list (or moving with the
      // arrow keys) shows each bookmark in turn. The pane saves whatever was typed before it changes over.
      set((s) => ({ selected: new Set([id]), anchorId: id, editingId: s.editingId === null ? null : id }))
    },
    toggleSelect(id) {
      set((s) => {
        const next = new Set(s.selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { selected: next, anchorId: id }
      })
    },
    selectRange(id) {
      const { items, anchorId } = get()
      const from = items.findIndex((b) => b.id === (anchorId ?? id))
      const to = items.findIndex((b) => b.id === id)
      if (from < 0 || to < 0) return get().selectOnly(id)
      const [lo, hi] = from < to ? [from, to] : [to, from]
      set({ selected: new Set(items.slice(lo, hi + 1).map((b) => b.id)) })
    },
    async selectAll() {
      // Everything the list is showing, not only the part that has been scrolled into view.
      const { scope, search, includeArchived, directOnly } = get()
      const ids = await guard(() => api.bookmarks.matchingIds({ scope, search, includeArchived, directOnly }))
      set({ selected: new Set(ids ?? get().items.map((b) => b.id)) })
    },
    clearSelection() {
      set({ selected: new Set(), anchorId: null })
    },
    moveSelection(delta) {
      const { items, anchorId } = get()
      if (items.length === 0) return
      const current = items.findIndex((b) => b.id === anchorId)
      const next = Math.max(0, Math.min(items.length - 1, current < 0 ? (delta > 0 ? 0 : items.length - 1) : current + delta))
      const target = items[next]
      if (target) get().selectOnly(target.id)
    },
    setEditing(id) {
      set({ editingId: id })
    },

    // ----------------------------------------------------------- bookmarks
    async saveBookmark(id, patch) {
      const updated = await guard(() => api.bookmarks.update(id, patch))
      if (!updated) return null
      set((s) => ({ items: s.items.map((b) => (b.id === id ? updated : b)) }))
      void get().refreshMeta()
      return updated
    },

    async toggleFavorite(ids) {
      if (ids.length === 0) return
      const items = get().items.filter((b) => ids.includes(b.id))
      const makeFavorite = items.some((b) => !b.favorite)
      await guard(() => api.bookmarks.bulk(ids, { favorite: makeFavorite }))
      await get().refreshAll()
    },

    async moveToCollection(ids, collectionId) {
      if (ids.length === 0) return
      await guard(() => api.bookmarks.bulk(ids, { collectionId }))
      const name = collectionId === null ? 'Unsorted' : (get().collections.find((c) => c.id === collectionId)?.name ?? 'collection')
      get().toast(`Moved ${plural(ids.length, 'bookmark')} to ${name}`, 'success')
      await get().refreshAll()
    },

    async addTags(ids, tags) {
      if (ids.length === 0 || tags.length === 0) return
      await guard(() => api.bookmarks.bulk(ids, { addTags: tags }))
      await get().refreshAll()
    },

    async trashIds(ids) {
      if (ids.length === 0) return
      const ok = await guard(async () => (await api.bookmarks.trash(ids), true))
      if (!ok) return
      set((s) => ({ selected: new Set([...s.selected].filter((id) => !ids.includes(id))) }))
      get().toast(`Moved ${plural(ids.length, 'bookmark')} to Trash`, 'info', {
        label: 'Undo',
        onClick: () => void get().restoreIds(ids)
      })
      await get().refreshAll()
    },

    async restoreIds(ids) {
      if (ids.length === 0) return
      await guard(() => api.bookmarks.restore(ids))
      await get().refreshAll()
    },

    async purgeIds(ids) {
      if (ids.length === 0) return
      const yes = await get().confirm({
        title: 'Delete permanently?',
        message: `${plural(ids.length, 'bookmark')} will be deleted forever. This cannot be undone.`,
        confirmLabel: 'Delete permanently',
        danger: true
      })
      if (!yes) return
      await guard(() => api.bookmarks.purge(ids))
      await get().refreshAll()
    },

    async emptyTrash() {
      const count = get().counts.trash
      if (count === 0) return
      const yes = await get().confirm({
        title: 'Empty Trash?',
        message: `${plural(count, 'bookmark')} will be deleted forever. This cannot be undone.`,
        confirmLabel: 'Empty Trash',
        danger: true
      })
      if (!yes) return
      await guard(() => api.bookmarks.emptyTrash())
      await get().refreshAll()
    },

    async openBookmark(bookmark) {
      await guard(() => api.app.openExternal(bookmark.url))
    },

    async refreshDetails(id) {
      const pending = get().toast('Fetching details…', 'info')
      try {
        const updated = await api.bookmarks.refreshMetadata(id)
        get().dismissToast(pending)
        get().toast('Details refreshed', 'success')
        await get().refreshAll()
        return updated
      } catch (error) {
        get().dismissToast(pending)
        get().toast(errorMessage(error), 'error')
        return null
      }
    },

    async copyLink(bookmark) {
      await guard(() => api.app.copyText(bookmark.url))
      get().toast('Link copied', 'success')
    },

    // --------------------------------------------------------- collections
    async createCollection(parentId) {
      const name = await get().prompt({
        title: parentId === null ? 'New collection' : 'New sub-collection',
        label: 'Name',
        confirmLabel: 'Create',
        placeholder: 'e.g. Recipes'
      })
      if (!name?.trim()) return
      const created = await guard(() => api.collections.create({ name, parentId }))
      if (!created) return
      if (parentId !== null) {
        const expanded = { ...get().expanded, [parentId]: true }
        saveExpanded(expanded)
        set({ expanded })
      }
      await get().refreshMeta()
    },

    async renameCollection(id) {
      const current = get().collections.find((c) => c.id === id)
      if (!current) return
      const name = await get().prompt({ title: 'Rename collection', label: 'Name', initial: current.name, confirmLabel: 'Rename' })
      if (!name?.trim() || name === current.name) return
      await guard(() => api.collections.update(id, { name }))
      await get().refreshMeta()
    },

    async colorCollection(id, color) {
      await guard(() => api.collections.update(id, { color }))
      await get().refreshMeta()
    },

    async deleteCollection(id) {
      const current = get().collections.find((c) => c.id === id)
      if (!current) return
      const yes = await get().confirm({
        title: `Delete "${current.name}"?`,
        message: 'Its sub-collections are deleted too. The bookmarks inside are moved to the Trash, so you can still restore them.',
        confirmLabel: 'Delete collection',
        danger: true
      })
      if (!yes) return
      const result = await guard(() => api.collections.remove(id))
      if (!result) return
      if (result.trashed > 0) get().toast(`Moved ${plural(result.trashed, 'bookmark')} to Trash`, 'info')
      await get().refreshMeta()
      // If the collection being viewed (or one of its parents) was deleted, fall back to "All bookmarks".
      const { scope, collections } = get()
      if (scope.kind === 'collection' && !collections.some((c) => c.id === scope.id)) set({ scope: { kind: 'all' } })
      await get().reload()
    },

    async moveCollection(id, parentId, index) {
      await guard(() => api.collections.move(id, parentId, index))
      if (parentId !== null) {
        const expanded = { ...get().expanded, [parentId]: true }
        saveExpanded(expanded)
        set({ expanded })
      }
      await get().refreshMeta()
    },

    async renameTag(name) {
      const next = await get().prompt({ title: 'Rename tag', label: 'Tag name', initial: name, confirmLabel: 'Rename' })
      if (!next?.trim() || next === name) return
      await guard(() => api.tags.rename(name, next))
      const { scope } = get()
      if (scope.kind === 'tag' && scope.name.toLowerCase() === name.toLowerCase()) set({ scope: { kind: 'tag', name: next.replace(/^#+/, '').trim() } })
      await get().refreshAll()
    },

    async deleteTag(name) {
      const yes = await get().confirm({
        title: `Delete tag "${name}"?`,
        message: 'The tag is removed from every bookmark. The bookmarks themselves are not deleted.',
        confirmLabel: 'Delete tag',
        danger: true
      })
      if (!yes) return
      await guard(() => api.tags.remove(name))
      const { scope } = get()
      if (scope.kind === 'tag' && scope.name.toLowerCase() === name.toLowerCase()) set({ scope: { kind: 'all' } })
      await get().refreshAll()
    },

    // --------------------------------------------------------- import/export
    async importFile() {
      const result = await guard(() => api.data.importFile())
      if (!result) return
      get().toast(
        `Imported ${plural(result.added, 'bookmark')} from ${result.fileName}` +
          (result.skipped ? ` (${result.skipped} skipped as duplicates or invalid)` : ''),
        'success'
      )
      await get().refreshAll()
      if (result.added > 0 && get().counts.all > 0) {
        const fetchDetails = await get().confirm({
          title: 'Fetch covers and icons?',
          message: 'Imported bookmarks do not include preview images. Fetch them now in the background? This contacts each website once.',
          confirmLabel: 'Fetch details'
        })
        if (fetchDetails) await get().startJob('fetch-metadata')
      }
    },

    async exportFile(format) {
      // A backup always holds everything; the formats meant for another program ask about the Archive first.
      let includeArchived = false
      if (format !== 'json' && get().counts.archived > 0) {
        includeArchived = await get().confirm({
          title: 'Include archived bookmarks?',
          message: plural(get().counts.archived, 'bookmark') + ' sit in the Archive. They are left out of this export unless you want them; a JSON backup always holds everything.',
          confirmLabel: 'Include them'
        })
      }
      const path = await guard(() => api.data.exportFile(format, includeArchived))
      if (path) get().toast(`Exported to ${path}`, 'success')
    },

    async startJob(kind, options) {
      const id = await guard(() => api.tools.startJob(kind, options))
      if (id === null) get().toast('Another task is already running', 'info')
    },

    async cancelJob() {
      const job = get().job
      if (job && !job.finished) await guard(() => api.tools.cancelJob(job.id))
    },

    onJobProgress(progress) {
      set({ job: progress })
      if (progress.finished) {
        const label = progress.kind === 'check-links' ? 'Link check' : progress.kind === 'auto-tag' ? 'Auto-tagging' : 'Fetching details'
        const message = label + ' ' + (progress.cancelled ? 'cancelled' : 'finished') + (progress.summary ? ': ' + progress.summary : '')
        void get()
          .refreshAll()
          .then(() => {
            // Suggestions produced by a run are waiting for review: offer to open them.
            const review = progress.kind !== 'check-links' && get().pendingProposals > 0
            get().toast(message, progress.cancelled ? 'info' : 'success', review ? { label: 'Review', onClick: () => get().openDialog({ type: 'review-tags' }) } : undefined)
          })
      }
    },

    async copyBookmarklet() {
      const status = await guard(() => api.localApi.status())
      if (!status) return
      if (!status.enabled) {
        const yes = await get().confirm({
          title: 'Turn on the local API?',
          message:
            'The bookmarklet sends pages to Cairn through a small server that only this computer can reach. It runs only while Cairn is open, and every request needs a secret key that is built into the bookmarklet.',
          confirmLabel: 'Turn on and copy'
        })
        if (!yes) return
        await get().updateSettings({ api: { enabled: true } })
      }
      try {
        await api.localApi.copyBookmarklet()
      } catch (error) {
        get().toast(errorMessage(error), 'error')
        return
      }
      get().toast('Bookmarklet copied. In your browser, add a new bookmark and paste this as its address (URL).', 'success')
    },

    async undoTidy(id) {
      const result = await guard(() => api.tagging.tidy.undo(id))
      if (!result) return
      get().toast('Tidy undone: the tags are back as they were.', 'success')
      await get().refreshAll()
    },

    async resetApiKey() {
      const yes = await get().confirm({
        title: 'Make a new secret key?',
        message: 'Bookmarklets you copied earlier will stop working until you copy the new one into your browser.',
        confirmLabel: 'Make new key',
        danger: true
      })
      if (yes) {
        await guard(() => api.localApi.resetKey())
        get().toast('New key made. Copy the bookmarklet again.', 'success')
      }
      get().openDialog({ type: 'settings' })
    },

    onCapture(event) {
      if (event.stage === 'saved') get().toast('Saved from your browser: ' + event.title, 'success')
      else if (event.stage === 'exists') get().toast('Already saved: ' + event.title, 'info')
      // Details and suggested tags arrive later: bring the list and the review count up to date.
      void get().refreshAll()
    },

    // ------------------------------------------------------------------ ui
    openAdd(urls) {
      set({ dialog: { type: 'add', urls } })
    },
    openDialog(dialog) {
      set({ dialog })
    },
    closeDialog(result) {
      const resolve = dialogResolver
      dialogResolver = null
      set({ dialog: null })
      resolve?.(result ?? null)
    },
    async confirm(options) {
      return (await ask<boolean>({ type: 'confirm', ...options })) === true
    },
    prompt(options) {
      return ask<string>({ type: 'prompt', initial: '', ...options })
    },
    showContext(x, y, items) {
      set({ context: { x, y, items } })
    },
    hideContext() {
      if (get().context) set({ context: null })
    },
    toast(message, kind = 'info', action) {
      const id = ++toastSeq
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind, action }] }))
      setTimeout(() => get().dismissToast(id), action ? 8000 : kind === 'error' ? 7000 : 4500)
      return id
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }
  }
})
