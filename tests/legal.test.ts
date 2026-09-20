import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

describe('licensing', () => {
  it('LICENSE is plain MIT with no icon carve-outs', () => {
    const license = read('LICENSE')
    expect(license.startsWith('MIT License')).toBe(true)
    expect(license).not.toMatch(/microsoft|excluded license|third-party icons/i)
  })

  it('does not bundle any non-MIT icon files', () => {
    expect(existsSync(resolve(root, 'resources/icons'))).toBe(false)
    expect(existsSync(resolve(root, 'ICONS.md'))).toBe(false)
  })

  it('ships third-party notices for the packages that end up in the app, including the icon set', () => {
    const notices = read('THIRD_PARTY_LICENSES.txt')
    const headings = notices.split(/\r?\n/).filter((line) => /^\S+ \d+\.\d+/.test(line))
    for (const name of ['@tabler/icons-react', '@tabler/icons', 'react', 'react-dom', 'zustand', 'zod', 'node-html-parser']) {
      expect(
        headings.some((line) => line.startsWith(`${name} `)),
        `${name} missing from THIRD_PARTY_LICENSES.txt (run npm run legal)`
      ).toBe(true)
    }
    expect(notices).toMatch(/Copyright \(c\) 2020-\d{4} Paweł Kuna/)
  })

  it('packages the license files with every build', () => {
    const config = read('electron-builder.yml')
    expect(config).toContain('legal/LICENSE')
    expect(config).toContain('legal/THIRD_PARTY_LICENSES.txt')
  })

  it('uses only explicit named imports from the icon package so the bundle stays small', () => {
    const icons = read('src/renderer/src/icons.tsx')
    expect(icons).not.toMatch(/import \* as .* from '@tabler\/icons-react'/)
    expect(icons).toMatch(/from '@tabler\/icons-react'/)
  })
})
