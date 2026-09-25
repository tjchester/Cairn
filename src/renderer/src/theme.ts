import { cssVariables, DEFAULT_SCHEME, findScheme, type ThemeMode } from '@shared/themes'

// Puts a colour scheme on the page. Light or dark is still decided by the Appearance setting, which the main process
// hands to the system; the renderer only has to read which of the two is in force.

const CACHE_KEY = 'cairn.scheme'
let current = DEFAULT_SCHEME

const darkQuery = (): MediaQueryList => window.matchMedia('(prefers-color-scheme: dark)')

export const currentMode = (): ThemeMode => (darkQuery().matches ? 'dark' : 'light')

function paint(): void {
  const scheme = findScheme(current)
  const mode = currentMode()
  const root = document.documentElement
  for (const [name, value] of Object.entries(cssVariables(scheme, mode))) root.style.setProperty(name, value)
  root.dataset.scheme = scheme.id
  root.dataset.mode = mode
  root.style.colorScheme = mode
}

/**
 * Shows a scheme, and remembers it so the next start paints it before the settings have loaded (the saved settings
 * remain the source of truth; this is only to avoid a flash of the wrong colours).
 */
export function useScheme(id: string | undefined): void {
  current = findScheme(id).id
  try {
    localStorage.setItem(CACHE_KEY, current)
  } catch {
    // Not remembered; harmless.
  }
  paint()
}

/** Paints the scheme from the last run, and follows the system when Appearance is set to match it. */
export function startTheming(): () => void {
  try {
    current = findScheme(localStorage.getItem(CACHE_KEY) ?? undefined).id
  } catch {
    current = DEFAULT_SCHEME
  }
  paint()
  const query = darkQuery()
  const onChange = (): void => paint()
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
