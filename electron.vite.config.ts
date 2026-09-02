import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/**
 * The version, baked in at build time.
 *
 * The About panel has to show which build is running, and the renderer cannot
 * ask: `app.getVersion()` is main-process only, and adding an IPC round trip
 * for a string that is fixed at compile time would be a channel that exists to
 * report a constant. Read here, substituted by Rollup, gone by runtime.
 *
 * JSON.stringify, not a bare template: `define` performs textual substitution,
 * so the value must arrive as a valid JS literal including its quotes.
 */
const APP_VERSION = JSON.stringify(
  (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string })
    .version,
)

export default defineConfig({
  main: {
    build: {
      /**
       * TWO entries, not one. `agentHost.ts` is imported by nothing — the
       * supervisor launches it as a separate OS process by path — so without
       * naming it here Rollup would tree-shake it out of existence and every
       * agent run would fail with "module not found" at spawn time.
       *
       * Both land in `out/main/`, which is what makes
       * `join(__dirname, 'agentHost.js')` in supervisor.ts resolve in dev and in
       * the packaged app without a branch.
       */
      lib: {
        entry: [
          resolve(__dirname, 'src/main/index.ts'),
          resolve(__dirname, 'src/main/agentHost.ts'),
        ],
      },
      rollupOptions: { external: ['electron'] },
    },
  },
  preload: {
    build: { lib: { entry: resolve(__dirname, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    plugins: [react()],
    define: { __APP_VERSION__: APP_VERSION },
  },
})
