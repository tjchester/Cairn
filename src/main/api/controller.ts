import type { ApiSettings, ApiStatus } from '@shared/types'
import type { Repo } from '../db/repo'
import { generateKey } from './auth'
import { buildBookmarklet } from './bookmarklet'
import type { IngestService } from './ingest'
import { ApiServer } from './server'

const KEY_SETTING = 'apiKey'

export interface ApiControllerDeps {
  repo: Repo
  ingest: IngestService
  version: string
  /** The current API settings (read each time, so changes made in Settings are seen). */
  getSettings: () => ApiSettings
  log?: (event: string, data?: Record<string, unknown>) => void
}

/**
 * Owns the local API's life: it runs only while the app is open and the setting is on, moves to a new port when the
 * setting changes, and keeps the secret key. The key lives in the database and is never sent to the window.
 */
export class ApiController {
  private server: ApiServer | null = null
  private error: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ApiControllerDeps) {}

  /** The secret key, created the first time it is needed. */
  key(): string {
    const existing = this.deps.repo.getSettingRaw(KEY_SETTING)
    if (existing) return existing
    const created = generateKey()
    this.deps.repo.setSettingRaw(KEY_SETTING, created)
    return created
  }

  /** Makes a new key: bookmarklets copied earlier stop working. */
  resetKey(): void {
    this.deps.repo.setSettingRaw(KEY_SETTING, generateKey())
    this.deps.log?.('api-key-reset')
  }

  bookmarklet(): string {
    return buildBookmarklet(this.deps.getSettings().port, this.key())
  }

  status(): ApiStatus {
    const settings = this.deps.getSettings()
    return {
      enabled: settings.enabled,
      running: this.server !== null,
      port: settings.port,
      address: 'http://127.0.0.1:' + settings.port,
      error: this.error
    }
  }

  /** Brings the server in line with the settings (start, stop or move). Calls are queued so quick changes cannot race. */
  apply(): Promise<ApiStatus> {
    const run = this.queue.then(() => this.reconcile())
    this.queue = run.catch(() => undefined)
    return run.then(() => this.status())
  }

  stop(): Promise<void> {
    const run = this.queue.then(async () => {
      const server = this.server
      this.server = null
      await server?.stop()
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async reconcile(): Promise<void> {
    const wanted = this.deps.getSettings()
    if (!wanted.enabled) {
      const server = this.server
      this.server = null
      this.error = null
      await server?.stop()
      return
    }
    if (this.server && this.server.port === wanted.port) return

    const old = this.server
    this.server = null
    await old?.stop()
    const server = new ApiServer({
      ingest: this.deps.ingest,
      repo: this.deps.repo,
      getKey: () => this.key(),
      version: this.deps.version,
      log: this.deps.log
    })
    try {
      await server.start(wanted.port)
      this.server = server
      this.error = null
      this.deps.log?.('api-started', { port: wanted.port })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.deps.log?.('api-start-failed', { port: wanted.port, message: this.error })
    }
  }
}
