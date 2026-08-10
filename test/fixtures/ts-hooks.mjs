/**
 * Module-resolution hooks that let `node --test` import the project's real
 * TypeScript main-process sources.
 *
 * Two things stand in the way, neither of which is a reason to test a copy:
 *   1. The sources use NodeNext-style `./foo.js` specifiers that actually point
 *      at `./foo.ts`. Node's type-stripping does not rewrite those.
 *   2. They import `electron`, which does not resolve outside an Electron run.
 *
 * So: rewrite `.js` -> `.ts` when only the `.ts` exists, and redirect
 * `electron` to a stub. Everything else resolves normally, and the module body
 * executed is the real file on disk.
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ELECTRON_STUB = pathToFileURL(fileURLToPath(new URL('./electron-stub.mjs', import.meta.url))).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: ELECTRON_STUB, format: 'module', shortCircuit: true }
    }
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, format: 'module-typescript', shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})
