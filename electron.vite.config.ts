import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

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
  },
})
