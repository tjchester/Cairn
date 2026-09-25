import { describe, expect, it } from 'vitest'
import { cssVariables, DEFAULT_SCHEME, findScheme, SCHEMES, withAlpha, type Palette, type ThemeMode } from '../src/shared/themes'

// A scheme may be pretty, but it has to be readable. These are the WCAG contrast rules, checked for every colour
// pair the interface actually puts together, in both the light and the dark palette of every scheme.

const channel = (hex: string, at: number): number => Number.parseInt(hex.slice(at, at + 2), 16) / 255

/** Relative luminance, as WCAG defines it. */
function luminance(hex: string): number {
  const parts = [channel(hex, 1), channel(hex, 3), channel(hex, 5)].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (parts[0] as number) + 0.7152 * (parts[1] as number) + 0.0722 * (parts[2] as number)
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Text pairings that must reach AA (4.5), and larger or non-text pairings that must reach 3. */
const readable: [keyof Palette, keyof Palette, number][] = [
  ['text', 'bg', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surface2', 4.5],
  ['text', 'sidebar', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'surface2', 4.5],
  ['muted', 'sidebar', 4.5],
  ['accentText', 'accent', 4.5],
  ['accent', 'surface', 3], // links and the selected row's label
  ['accent', 'sidebar', 3],
  ['danger', 'surface', 3],
  ['ok', 'surface', 3],
  ['warn', 'surface', 3],
  ['borderStrong', 'surface', 1.5] // a border only has to be visible
]

describe('colour schemes', () => {
  it('offers several, with a stable default', () => {
    expect(SCHEMES.length).toBeGreaterThanOrEqual(5)
    expect(new Set(SCHEMES.map((s) => s.id)).size).toBe(SCHEMES.length)
    expect(findScheme(DEFAULT_SCHEME).id).toBe(DEFAULT_SCHEME)
    expect(findScheme('no-such-scheme').id).toBe(DEFAULT_SCHEME) // an unknown one falls back
    expect(findScheme(undefined).id).toBe(DEFAULT_SCHEME)
  })

  it.each(SCHEMES.flatMap((scheme) => (['light', 'dark'] as ThemeMode[]).map((mode) => [scheme.name, mode, scheme] as const)))(
    '%s (%s) is readable',
    (_name, mode, scheme) => {
      const palette = mode === 'dark' ? scheme.dark : scheme.light
      for (const [front, back, least] of readable) {
        const ratio = contrast(palette[front], palette[back])
        expect(ratio, `${front} on ${back} (${palette[front]} on ${palette[back]})`).toBeGreaterThanOrEqual(least)
      }
    }
  )

  it.each(SCHEMES.map((s) => [s.name, s] as const))('%s is light where it says and dark where it says', (_name, scheme) => {
    expect(luminance(scheme.light.bg), 'light bg').toBeGreaterThan(0.6)
    expect(luminance(scheme.dark.bg), 'dark bg').toBeLessThan(0.1)
    // Cards must be distinguishable from the page behind them, and the sidebar from the list.
    expect(scheme.light.surface).not.toBe(scheme.light.sidebar)
    expect(scheme.dark.surface).not.toBe(scheme.dark.sidebar)
  })

  it('turns a palette into the variables the stylesheet uses', () => {
    const vars = cssVariables(findScheme('default'), 'light')
    expect(vars['--bg']).toBe('#f5f6f9')
    expect(vars['--accent-soft']).toBe('rgba(58, 99, 232, 0.12)')
    expect(vars['--hover']).toMatch(/^rgba\(/)
    expect(Object.keys(cssVariables(findScheme('ocean'), 'dark'))).toEqual(Object.keys(vars)) // every scheme fills them all
    expect(Object.values(vars).every((v) => v.trim().length > 0)).toBe(true)
  })

  it('reads a colour with an alpha', () => {
    expect(withAlpha('#3a63e8', 0.12)).toBe('rgba(58, 99, 232, 0.12)')
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
  })
})
