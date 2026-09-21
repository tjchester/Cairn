// Domain types and the renderer-facing API contract shared by main, preload and renderer.

export type LinkStatus = 'unknown' | 'ok' | 'broken'
export type SortKey = 'created' | 'updated' | 'title' | 'domain'
export type SortDirection = 'asc' | 'desc'
export type ViewMode = 'list' | 'grid' | 'headlines'
export type ThemeSetting = 'system' | 'light' | 'dark'
export type ExportFormat = 'html' | 'csv' | 'json'
export type JobKind = 'check-links' | 'fetch-metadata' | 'auto-tag'

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
  /** The subset of `tags` that were added automatically (built-in engine or local LLM) rather than by the user. */
  autoTags: string[]
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
  /** Tags in `tags` that came from auto-tagging (recorded so they can be reviewed or removed later). */
  tagSources?: Record<string, 'builtin' | 'llm'>
  /** What the page said about itself (from the details lookup), so it need not be fetched again for tagging. */
  signals?: PageSignals | null
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

/** What a page says about itself, kept locally so tags can be suggested without fetching it again. */
export interface PageSignals {
  /** Author-supplied: meta keywords, article:tag and JSON-LD keywords. */
  keywords: string[]
  ogType: string | null
  siteName: string | null
  /** Primary language subtag, e.g. "en". */
  lang: string | null
  /** Article section / category. */
  section: string | null
  /** The first ~2000 characters of the page's paragraphs. */
  text: string
}

export interface PageMetadata {
  title: string
  excerpt: string
  coverUrl: string | null
  faviconUrl: string | null
  finalUrl: string
  status: number | null
  signals?: PageSignals
}

// ------------------------------------------------------------------- tagging

export type SuggestionOrigin = 'builtin' | 'llm'
export type SuggestionSource = 'domain' | 'path' | 'file-type' | 'page-type' | 'metadata' | 'topic' | 'vocabulary' | 'llm'

export interface TagSuggestion {
  tag: string
  /** Confidence from 0 to 1. */
  score: number
  origin: SuggestionOrigin
  sources: SuggestionSource[]
  /** Human-readable explanations, e.g. "github.com is a code host". */
  reasons: string[]
  /** True if other bookmarks in the library already use this tag (so accepting it adds no new tag). */
  existing: boolean
}

/** A bookmark that is not saved yet (the Add dialog). */
export interface TaggingDraft {
  url: string
  title: string
  excerpt: string
  signals?: PageSignals | null
  tags?: string[]
}

export type TaggingTarget = { bookmarkId: number } | { draft: TaggingDraft }

export interface SuggestResult {
  suggestions: TagSuggestion[]
  /** Whether the optional local LLM contributed: off (not enabled), used, or failed (see `error`). */
  llm: 'off' | 'used' | 'failed'
  error?: string
}

/** The result of checking a connection to Ollama. */
export interface OllamaStatus {
  ok: boolean
  version?: string
  /** Names of the installed models. */
  models: string[]
  /** The configured model is installed. */
  modelReady: boolean
  message: string
}

export type TaggingMode = 'off' | 'suggest' | 'auto'

export interface LlmSettings {
  enabled: boolean
  /** Ollama server address. Loopback by default; anything else needs `allowRemote`. */
  baseUrl: string
  model: string
  /** Allow a server that is not on this computer (bookmark titles, URLs and descriptions are sent to it). */
  allowRemote: boolean
  /** Also send the first part of each page's text (off by default). */
  sendPageText: boolean
  /** Extra guidance appended to the prompt, e.g. "Prefer broad topics over product names." */
  instructions: string
}

export interface TaggingSettings {
  mode: TaggingMode
  maxTags: number
  /** Optional custom rules (JSON) layered over the built-in ones. */
  userRules: string
  llm: LlmSettings
}

export const DEFAULT_TAGGING: TaggingSettings = {
  mode: 'suggest',
  maxTags: 5,
  userRules: '',
  llm: { enabled: false, baseUrl: 'http://127.0.0.1:11434', model: '', allowRemote: false, sendPageText: false, instructions: '' }
}

export interface ProposalGroup {
  tag: string
  count: number
  avgScore: number
  existing: boolean
  origins: SuggestionOrigin[]
}

export interface ProposalItem {
  proposalId: number
  bookmarkId: number
  title: string
  url: string
  score: number
  reason: string
  origin: SuggestionOrigin
}

export interface TagRunInfo {
  id: number
  kind: string
  mode: string
  createdAt: string
  tagsApplied: number
  bookmarksTouched: number
  undone: boolean
}

export type AutoTagScope = 'untagged' | 'all' | 'ids'

export interface StartJobOptions {
  /** Auto-tag jobs: which bookmarks to consider (default: those without any tags). */
  scope?: AutoTagScope
  ids?: number[]
  useLlm?: boolean
}

/** The local API that lets a browser bookmarklet (and, later, command-line tools) talk to the running app. */
export interface ApiSettings {
  enabled: boolean
  /** Fixed on purpose: the bookmarklet stored in your browser contains it. */
  port: number
}

export const DEFAULT_API: ApiSettings = { enabled: false, port: 47821 }

export interface ApiStatus {
  enabled: boolean
  running: boolean
  port: number
  /** What the bookmarklet talks to, e.g. http://127.0.0.1:47821 */
  address: string
  /** Why it is not running although it is switched on (for example, the port is taken). */
  error: string | null
}

/** Sent to the window when a bookmark arrives through the local API (or finishes being filled in). */
export interface CaptureEvent {
  stage: 'saved' | 'exists' | 'enriched'
  id: number
  title: string
}

export interface Settings {
  theme: ThemeSetting
  view: ViewMode
  sort: SortKey
  direction: SortDirection
  sidebarWidth: number
  tagging: TaggingSettings
  api: ApiSettings
}

export type SettingsPatch = Partial<Omit<Settings, 'tagging' | 'api'>> & {
  tagging?: Partial<Omit<TaggingSettings, 'llm'>> & { llm?: Partial<LlmSettings> }
  api?: Partial<ApiSettings>
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  view: 'list',
  sort: 'created',
  direction: 'desc',
  sidebarWidth: 260,
  tagging: DEFAULT_TAGGING,
  api: DEFAULT_API
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
  | 'copy-bookmarklet'

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
    startJob(kind: JobKind, options?: StartJobOptions): Promise<string | null>
    cancelJob(id: string): Promise<void>
  }
  data: {
    counts(): Promise<Counts>
    importFile(): Promise<ImportResult | null>
    exportFile(format: ExportFormat): Promise<string | null>
  }
  settings: {
    get(): Promise<Settings>
    /** Merges the patch into the saved settings (`tagging` and `tagging.llm` are merged field by field). */
    set(patch: SettingsPatch): Promise<Settings>
  }
  tagging: {
    /** Suggests tags for a saved bookmark or a draft. The built-in engine answers instantly; the local LLM (if enabled and asked for) may take seconds. */
    suggest(target: TaggingTarget, withLlm: boolean): Promise<SuggestResult>
    /** Suggestions waiting for review, grouped by tag. */
    review: {
      count(): Promise<number>
      groups(): Promise<ProposalGroup[]>
      items(tag: string): Promise<ProposalItem[]>
      /** Applies a tag to everyone it was suggested for (or just the given bookmarks). Returns how many were tagged. */
      apply(tag: string, bookmarkIds?: number[]): Promise<number>
      /** Skips a suggestion; it will not be suggested for those bookmarks again. */
      reject(tag: string, bookmarkIds?: number[]): Promise<number>
      /** Never suggest this tag again. */
      never(tag: string): Promise<number>
      applyAll(): Promise<number>
      discardAll(): Promise<number>
    }
    ollama: {
      /** Checks the connection and the model; `overrides` lets Settings test values that are not saved yet. */
      status(overrides?: Partial<LlmSettings>): Promise<OllamaStatus>
    }
    runs: {
      /** The latest auto-tagging run that added tags and has not been undone. */
      last(): Promise<TagRunInfo | null>
      /** Removes the tags a run added. Returns how many were removed. */
      undo(runId: number): Promise<number>
      /** Removes every automatically added tag. */
      removeAuto(): Promise<number>
    }
  }
  /** The local API (browser bookmarklet, command-line tools). The secret key never reaches the renderer. */
  localApi: {
    status(): Promise<ApiStatus>
    /** Puts the bookmarklet on the clipboard. Fails if the API is not running. */
    copyBookmarklet(): Promise<void>
    /** Puts the secret key on the clipboard, for scripts that call the JSON endpoint. */
    copyKey(): Promise<void>
    /** Makes a new secret key: bookmarklets copied earlier stop working. */
    resetKey(): Promise<void>
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
    captureChanged(cb: (event: CaptureEvent) => void): () => void
  }
}
