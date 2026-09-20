// Domain types and the renderer-facing API contract shared by main, preload and renderer.

export type LinkStatus = 'unknown' | 'ok' | 'broken'
export type SortKey = 'created' | 'updated' | 'title' | 'domain'
export type SortDirection = 'asc' | 'desc'
export type ViewMode = 'list' | 'grid' | 'headlines'
export type ThemeSetting = 'system' | 'light' | 'dark'
export type ExportFormat = 'html' | 'csv' | 'json'
export type JobKind = 'check-links' | 'fetch-metadata'

export interface Collection {
  id: number
  parentId: number | null
  name: string
  color: string | null
  position: number
}

export interface Bookmark {
  id: number
  url: string
  title: string
  note: string
  excerpt: string
  coverUrl: string | null
  faviconUrl: string | null
  domain: string
  collectionId: number | null
  tags: string[]
  favorite: boolean
  status: LinkStatus
  httpStatus: number | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface BookmarkInput {
  url: string
  title?: string
  note?: string
  excerpt?: string
  coverUrl?: string | null
  faviconUrl?: string | null
  collectionId?: number | null
  tags?: string[]
  favorite?: boolean
  createdAt?: string
}

export type BookmarkPatch = Partial<BookmarkInput>

export interface BulkPatch {
  collectionId?: number | null
  favorite?: boolean
  addTags?: string[]
  removeTags?: string[]
}

export type Scope =
  | { kind: 'all' }
  | { kind: 'unsorted' }
  | { kind: 'favorites' }
  | { kind: 'broken' }
  | { kind: 'trash' }
  | { kind: 'collection'; id: number }
  | { kind: 'tag'; name: string }

export interface BookmarkQuery {
  scope: Scope
  search?: string
  sort: SortKey
  direction: SortDirection
  limit: number
  offset: number
}

export interface BookmarkPage {
  items: Bookmark[]
  total: number
}

export interface Counts {
  all: number
  unsorted: number
  favorites: number
  broken: number
  trash: number
  byCollection: Record<number, number>
}

export interface TagInfo {
  name: string
  count: number
}

export interface PageMetadata {
  title: string
  excerpt: string
  coverUrl: string | null
  faviconUrl: string | null
  finalUrl: string
  status: number | null
}

export interface Settings {
  theme: ThemeSetting
  view: ViewMode
  sort: SortKey
  direction: SortDirection
  sidebarWidth: number
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  view: 'list',
  sort: 'created',
  direction: 'desc',
  sidebarWidth: 260
}

export interface ImportResult {
  added: number
  skipped: number
  collectionsCreated: number
  fileName: string
}

export interface JobProgress {
  id: string
  kind: JobKind
  done: number
  total: number
  finished: boolean
  cancelled: boolean
  /** True while the task is waiting for the internet connection to come back. */
  paused: boolean
  /** Human-readable status such as "waiting for the connection" (absent when everything is normal). */
  note?: string
  summary?: string
}

export type MenuAction =
  | 'new-bookmark'
  | 'new-collection'
  | 'import'
  | 'export-html'
  | 'export-csv'
  | 'export-json'
  | 'focus-search'
  | 'toggle-sidebar'
  | 'view-list'
  | 'view-grid'
  | 'view-headlines'
  | 'open-tools'
  | 'open-settings'
  | 'open-shortcuts'

export interface CairnApi {
  collections: {
    list(): Promise<Collection[]>
    create(input: { name: string; parentId?: number | null; color?: string | null }): Promise<Collection>
    update(id: number, patch: { name?: string; color?: string | null }): Promise<Collection>
    move(id: number, parentId: number | null, index: number): Promise<void>
    remove(id: number): Promise<{ trashed: number }>
  }
  bookmarks: {
    query(query: BookmarkQuery): Promise<BookmarkPage>
    get(id: number): Promise<Bookmark | null>
    findByUrl(url: string): Promise<Bookmark | null>
    create(input: BookmarkInput): Promise<Bookmark>
    createMany(inputs: BookmarkInput[]): Promise<{ created: number; skipped: number; ids: number[] }>
    update(id: number, patch: BookmarkPatch): Promise<Bookmark>
    bulk(ids: number[], patch: BulkPatch): Promise<void>
    trash(ids: number[]): Promise<void>
    restore(ids: number[]): Promise<void>
    purge(ids: number[]): Promise<void>
    emptyTrash(): Promise<number>
    refreshMetadata(id: number): Promise<Bookmark>
  }
  tags: {
    list(): Promise<TagInfo[]>
    rename(from: string, to: string): Promise<void>
    remove(name: string): Promise<void>
  }
  metadata: {
    fetch(url: string): Promise<PageMetadata>
  }
  tools: {
    findDuplicates(): Promise<Bookmark[][]>
    startJob(kind: JobKind): Promise<string | null>
    cancelJob(id: string): Promise<void>
  }
  data: {
    counts(): Promise<Counts>
    importFile(): Promise<ImportResult | null>
    exportFile(format: ExportFormat): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  app: {
    version(): Promise<string>
    platform: string
    openExternal(url: string): Promise<void>
    copyText(text: string): Promise<void>
    showLegal(): Promise<void>
  }
  on: {
    menuAction(cb: (action: MenuAction) => void): () => void
    jobProgress(cb: (progress: JobProgress) => void): () => void
    settingsChanged(cb: () => void): () => void
  }
}
