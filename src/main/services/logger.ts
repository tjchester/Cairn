import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

export type LogFn = (event: string, data?: Record<string, unknown>) => void

const MAX_BYTES = 256 * 1024
const KEEP_BYTES = 128 * 1024

/**
 * A tiny diagnostics log: one JSON object per line, appended to `file`. When it grows past 256 KB the oldest
 * half is dropped, so it never becomes a problem. It only records connection decisions and rate limits (site
 * names and error kinds), never page content, and failures to write are ignored.
 */
export function createFileLogger(file: string, now: () => Date = () => new Date()): LogFn {
  let writes = 0
  return (event, data = {}) => {
    try {
      appendFileSync(file, JSON.stringify({ at: now().toISOString(), event, ...data }) + '\n')
      if (++writes % 50 === 0 && statSync(file).size > MAX_BYTES) {
        const tail = readFileSync(file, 'utf8').slice(-KEEP_BYTES)
        writeFileSync(file, tail.slice(tail.indexOf('\n') + 1)) // start again on a whole line
      }
    } catch {
      // Diagnostics must never break the app.
    }
  }
}
