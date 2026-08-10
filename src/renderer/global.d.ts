import type { Api } from '../shared/ipc.js'

declare global {
  interface Window {
    api: Api
  }
}

export {}
