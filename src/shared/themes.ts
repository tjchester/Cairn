// The colour schemes you can pick from. Each one describes a light and a dark palette; which of the two you see is
// still decided by Match system / Light / Dark, so a scheme is a choice of colour, not of brightness.
//
// Only the colours that carry meaning are listed. The tints that sit on top of them (the hover wash, the soft accent
// behind a selected row, the shadow under a dialog) are worked out from these, so they can never drift apart.

export type ThemeMode = 'light' | 'dark'

export interface Palette {
  /** Behind everything. */
  bg: string
  /** Cards, dialogs, inputs. */
  surface: string
  /** Chips, wells, the quieter surface. */
  surface2: string
  sidebar: string
  border: string
  borderStrong: string
  text: string
  /** Secondary text: this must stay legible on `surface`. */
  muted: string
  accent: string
  /** Text on top of the accent. */
  accentText: string
  danger: string
  ok: string
  warn: string
}

export interface ColorScheme {
  id: string
  name: string
  /** A word on what it is for, shown under the name. */
  note: string
  light: Palette
  dark: Palette
}

export const SCHEMES: readonly ColorScheme[] = [
  {
    id: 'default',
    name: 'Cairn',
    note: 'Neutral grey and blue',
    light: {
      bg: '#f5f6f9',
      surface: '#ffffff',
      surface2: '#f0f1f5',
      sidebar: '#eceef3',
      border: '#dfe1e8',
      borderStrong: '#c9ccd6',
      text: '#1c1e26',
      muted: '#616b80',
      accent: '#3a63e8',
      accentText: '#ffffff',
      danger: '#d1343b',
      ok: '#1f8f4e',
      warn: '#b26a00'
    },
    dark: {
      bg: '#17181c',
      surface: '#202127',
      surface2: '#2a2b33',
      sidebar: '#1b1c21',
      border: '#30323b',
      borderStrong: '#454855',
      text: '#e8e9ee',
      muted: '#9b9fad',
      accent: '#7c9bff',
      accentText: '#0d1230',
      danger: '#ff6b70',
      ok: '#4cc38a',
      warn: '#f0b34a'
    }
  },
  {
    id: 'slate',
    name: 'Slate',
    note: 'Cool and quiet',
    light: {
      bg: '#eef1f4',
      surface: '#ffffff',
      surface2: '#e7ebef',
      sidebar: '#e2e7ec',
      border: '#d3dae1',
      borderStrong: '#b6c0cb',
      text: '#16202b',
      muted: '#556575',
      accent: '#2d6a9f',
      accentText: '#ffffff',
      danger: '#c02c34',
      ok: '#1c7f4b',
      warn: '#9a6400'
    },
    dark: {
      bg: '#14181d',
      surface: '#1d232a',
      surface2: '#272f38',
      sidebar: '#171c22',
      border: '#2e3740',
      borderStrong: '#445162',
      text: '#e4eaf0',
      muted: '#96a5b4',
      accent: '#79b2e0',
      accentText: '#07141f',
      danger: '#ff7b80',
      ok: '#57c48d',
      warn: '#e8b25a'
    }
  },
  {
    id: 'ocean',
    name: 'Ocean',
    note: 'Teal and deep blue',
    light: {
      bg: '#eef5f5',
      surface: '#ffffff',
      surface2: '#e4eeef',
      sidebar: '#deebec',
      border: '#cbdedf',
      borderStrong: '#a7c6c8',
      text: '#10262a',
      muted: '#4f6e72',
      accent: '#0f6f74',
      accentText: '#ffffff',
      danger: '#c0392f',
      ok: '#1c7f52',
      warn: '#96650b'
    },
    dark: {
      bg: '#0e1a1d',
      surface: '#152427',
      surface2: '#1d3236',
      sidebar: '#101e21',
      border: '#26393d',
      borderStrong: '#3a5459',
      text: '#dfeced',
      muted: '#8fa8ab',
      accent: '#4fc3c9',
      accentText: '#04181a',
      danger: '#ff7a70',
      ok: '#53c98d',
      warn: '#e3b15c'
    }
  },
  {
    id: 'forest',
    name: 'Forest',
    note: 'Green on warm paper',
    light: {
      bg: '#f2f4ee',
      surface: '#ffffff',
      surface2: '#eaefe3',
      sidebar: '#e6ebdf',
      border: '#d7ddcb',
      borderStrong: '#b6c0a7',
      text: '#1b241a',
      muted: '#5d6a58',
      accent: '#2f6b36',
      accentText: '#ffffff',
      danger: '#bf3b2f',
      ok: '#2f6b36',
      warn: '#8f6200'
    },
    dark: {
      bg: '#151a15',
      surface: '#1e241d',
      surface2: '#293026',
      sidebar: '#182018',
      border: '#2d362b',
      borderStrong: '#45523f',
      text: '#e6ebe1',
      muted: '#9aa695',
      accent: '#7fc47f',
      accentText: '#0c1a0d',
      danger: '#f57f72',
      ok: '#7fc47f',
      warn: '#dfae55'
    }
  },
  {
    id: 'sand',
    name: 'Sand',
    note: 'Warm paper and amber',
    light: {
      bg: '#f7f3ec',
      surface: '#fffdf9',
      surface2: '#f1eadd',
      sidebar: '#efe8dc',
      border: '#e2d8c8',
      borderStrong: '#c8b99f',
      text: '#251e14',
      muted: '#6b6152',
      accent: '#9a5b18',
      accentText: '#ffffff',
      danger: '#bb3a2c',
      ok: '#1f7a48',
      warn: '#8a6200'
    },
    dark: {
      bg: '#1a1712',
      surface: '#241f19',
      surface2: '#302a22',
      sidebar: '#1d1915',
      border: '#373027',
      borderStrong: '#544a3c',
      text: '#efe7dc',
      muted: '#aa9d8c',
      accent: '#e0a458',
      accentText: '#1d1408',
      danger: '#ff8071',
      ok: '#62c08c',
      warn: '#e0a458'
    }
  },
  {
    id: 'violet',
    name: 'Violet',
    note: 'Purple, a little softer',
    light: {
      bg: '#f4f2f9',
      surface: '#ffffff',
      surface2: '#eeeaf6',
      sidebar: '#eae6f4',
      border: '#ddd6ec',
      borderStrong: '#bfb3d8',
      text: '#1f1a2c',
      muted: '#645a7d',
      accent: '#6340c4',
      accentText: '#ffffff',
      danger: '#c32f4a',
      ok: '#1f7f56',
      warn: '#96620a'
    },
    dark: {
      bg: '#17151f',
      surface: '#201d2b',
      surface2: '#2b2739',
      sidebar: '#1a1724',
      border: '#332e44',
      borderStrong: '#4b4463',
      text: '#e9e5f3',
      muted: '#a49cbb',
      accent: '#a992f5',
      accentText: '#140d2b',
      danger: '#ff7590',
      ok: '#5cc292',
      warn: '#e3ae5e'
    }
  },
  {
    id: 'contrast',
    name: 'High contrast',
    note: 'Strong edges, bold text',
    light: {
      bg: '#ffffff',
      surface: '#ffffff',
      surface2: '#eceef1',
      sidebar: '#f2f4f7',
      border: '#8b929c',
      borderStrong: '#4a5159',
      text: '#000000',
      muted: '#41474f',
      accent: '#0b46c2',
      accentText: '#ffffff',
      danger: '#a4141c',
      ok: '#0f6136',
      warn: '#7a4a00'
    },
    dark: {
      bg: '#000000',
      surface: '#101216',
      surface2: '#1c1f25',
      sidebar: '#08090b',
      border: '#6b737e',
      borderStrong: '#98a1ad',
      text: '#ffffff',
      muted: '#c3c9d1',
      accent: '#9dc0ff',
      accentText: '#00102e',
      danger: '#ff9a9f',
      ok: '#78d9a6',
      warn: '#ffc86b'
    }
  }
]

export const DEFAULT_SCHEME = 'default'

export function findScheme(id: string | undefined): ColorScheme {
  return SCHEMES.find((s) => s.id === id) ?? (SCHEMES[0] as ColorScheme)
}

/** #rrggbb with an alpha, for the washes laid over a palette. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const n = Number.parseInt(value.length === 3 ? value.replace(/(.)/g, '$1$1') : value, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Every CSS variable a palette provides, worked out once so the renderer and the tests agree. */
export function cssVariables(scheme: ColorScheme, mode: ThemeMode): Record<string, string> {
  const p = mode === 'dark' ? scheme.dark : scheme.light
  return {
    '--bg': p.bg,
    '--surface': p.surface,
    '--surface-2': p.surface2,
    '--sidebar': p.sidebar,
    '--border': p.border,
    '--border-strong': p.borderStrong,
    '--text': p.text,
    '--muted': p.muted,
    '--accent': p.accent,
    '--accent-text': p.accentText,
    '--accent-soft': withAlpha(p.accent, mode === 'dark' ? 0.18 : 0.12),
    '--danger': p.danger,
    '--ok': p.ok,
    '--warn': p.warn,
    '--hover': mode === 'dark' ? 'rgba(255, 255, 255, 0.07)' : withAlpha(p.text, 0.06),
    '--shadow': mode === 'dark' ? '0 8px 28px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4)' : '0 8px 28px rgba(15, 20, 40, 0.18), 0 1px 3px rgba(15, 20, 40, 0.12)'
  }
}
