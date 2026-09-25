import { unlinkSync, writeFileSync } from 'node:fs'
import type { ApiSettings, ApiStatus } from '@shared/types'
import type { Repo } from '../db/repo'
import { generateKey } from './auth'
import { buildBookmarklet } from './bookmarklet'
import type { IngestService } from './ingest'
import { ApiServer } from './server'

const KEY_SETTING = 'apiKey'
const READ_KEY_SETTING = 'apiReadKey'

export interface ApiControllerDeps {
  repo: Repo
  ingest: IngestService
  version: string
  /**
   * Where to leave a note of the address and the read key while the server is up, so the command-line tool needs no
   * setting up. It sits in the app's own data folder, beside the library it describes.
   */
  discoveryFile?: string
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

  private keyFor(setting: string): string {
    const existing = this.deps.repo.getSettingRaw(setting)
    if (existing) return existing
    const created = generateKey()
    this.deps.repo.setSettingRaw(setting, created)
    return created
  }

  /** The key that may add bookmarks, created the first time it is needed. This is the one inside the bookmarklet. */
  key(): string {
    return this.keyFor(KEY_SETTING)
  }

  /** The key that may read the library: a different one, so the bookmarklet's key can never read anything. */
  readKey(): string {
    return this.keyFor(READ_KEY_SETTING)
  }

  /** Makes new keys: bookmarklets and scripts copied earlier stop working. */
  resetKey(): void {
    this.deps.repo.setSettingRaw(KEY_SETTING, generateKey())
    this.deps.repo.setSettingRaw(READ_KEY_SETTING, generateKey())
    this.deps.log?.('api-key-reset')
    this.writeDiscoveryFile()
  }

  /**
   * Writes (or removes) the note that tells a program on this computer where the API is and how to read from it.
   * Only the read key goes in: adding bookmarks still needs the key from Settings.
   */
  private writeDiscoveryFile(): void {
    const file = this.deps.discoveryFile
    if (!file) return
    try {
      if (this.server) {
        writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:' + this.server.port, port: this.server.port, readKey: this.readKey(), app: 'Cairn', apiVersion: 1 }, null, 2) + '\n', {
          encoding: 'utf8',
          mode: 0o600
        })
      } else {
        unlinkSync(file)
      }
    } catch {
      // Not written (or already gone): the tool can still be pointed at the API by hand.
    }
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
      this.writeDiscoveryFile()
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
      this.writeDiscoveryFile() // the note goes when the server does
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
      getReadKey: () => this.readKey(),
      version: this.deps.version,
      log: this.deps.log
    })
    try {
      await server.start(wanted.port)
      this.server = server
      this.error = null
      this.writeDiscoveryFile()
      this.deps.log?.('api-started', { port: wanted.port })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.deps.log?.('api-start-failed', { port: wanted.port, message: this.error })
    }
  }
}
