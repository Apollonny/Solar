import type { SolarApi } from '../shared/types'

declare global {
  interface Window {
    api: SolarApi
  }
}

export {}
