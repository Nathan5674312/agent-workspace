// `node --test test/` resolves this directory as a package (test/package.json
// declares main: index.mjs) and runs THIS FILE instead of globbing the folder.
// So every suite must be reachable from here.
//
// This used to be a single hard-coded import, which meant any test file added
// later was silently never executed by `npm test` — a suite that skips itself
// looks exactly like a suite that passes. Discover them instead.
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = (await readdir(here))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) throw new Error('no test files found in test/')

for (const f of files) {
  await import(pathToFileURL(join(here, f)).href)
}
