import type { CairnApi } from '@shared/types'

declare global {
  interface Window {
    /** Injected by the preload script. */
    cairn: CairnApi
  }
}

export {}
