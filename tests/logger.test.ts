import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileLogger } from '../src/main/services/logger'

const dir = mkdtempSync(join(tmpdir(), 'cairn-log-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('createFileLogger', () => {
  it('appends one JSON object per line, with a timestamp', () => {
    const file = join(dir, 'a.log')
    const log = createFileLogger(file, () => new Date('2026-01-02T03:04:05.000Z'))
    log('outage-start', { streak: 3, recentFailures: ['a.example:dns'] })
    log('job-end')
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: '2026-01-02T03:04:05.000Z', event: 'outage-start', streak: 3, recentFailures: ['a.example:dns'] },
      { at: '2026-01-02T03:04:05.000Z', event: 'job-end' }
    ])
  })

  it('never grows without bound, and keeps whole lines when it trims', () => {
    const file = join(dir, 'b.log')
    const log = createFileLogger(file)
    for (let i = 0; i < 4000; i++) log('rate-limited', { host: 'github.com', n: i, pad: 'x'.repeat(150) })
    expect(statSync(file).size).toBeLessThan(400 * 1024)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBeGreaterThan(100)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(lines.at(-1) as string).n).toBe(3999) // the newest entries survive
  })

  it('never throws, even when the file cannot be written', () => {
    const log = createFileLogger(join(dir, 'missing-folder', 'x.log'))
    expect(() => log('anything', { a: 1 })).not.toThrow()
  })
})
