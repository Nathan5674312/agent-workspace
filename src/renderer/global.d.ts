import type { Api } from '../shared/ipc.js'

declare global {
  interface Window {
    api: Api
  }
  /**
   * package.json's `version`, substituted by Rollup at build time — see
   * electron.vite.config.ts. A constant, not a call: there is nothing to fail
   * and nothing to await.
   */
  const __APP_VERSION__: string
}

export {}
