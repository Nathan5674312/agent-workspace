/**
 * A TEST RUN MUST NOT WRITE THE PROFILE OF THE APP NATHAN USES.
 *
 * MEASURED 2026-09-10, before src/main/profile.ts existed: one directory,
 * `%APPDATA%\agent-workspace`, held his real `settings.json` (Sep 6) beside a
 * `DevToolsActivePort` (Sep 8) left by an agent driving a build over CDP. Every
 * verification run this repo has ever done was editing his settings, and
 * nothing about that was visible from either side.
 *
 * `isPackaged` CANNOT BE THE TEST and that is the whole subtlety: it is TRUE
 * for `dist/win-unpacked`, which is exactly what an agent launches. The path of
 * the running executable is what separates a verification run from a user's
 * app, because an installed copy never runs from the repo's build directory.
 *
 * Read as text rather than imported: profile.ts reaches for `electron` at
 * module scope, which `node --test` has no business loading.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

test('a run out of the build directory gets its own userData', () => {
  const profile = read('src', 'main', 'profile.ts')
  assert.match(profile, /win-unpacked/, 'nothing recognises a run from dist/')
  assert.match(profile, /setPath\('userData'/, 'the profile is never actually redirected')
  assert.match(
    profile,
    /!app\.isPackaged/,
    'an unpackaged dev run is no longer counted as a test run',
  )
})

test('an explicit --user-data-dir still wins', () => {
  /**
   * The one workflow that needs a genuinely empty profile is watching
   * onboarding happen for real. Clobbering the switch here would take that
   * away and the loss would be silent — onboarding simply would not appear.
   */
  const profile = read('src', 'main', 'profile.ts')
  assert.match(profile, /--user-data-dir/, 'the switch is not consulted at all')
  assert.match(profile, /isTestRun && !chosen/, 'an explicit profile no longer wins')
})

test('profile.ts is imported before anything that reads userData', () => {
  /**
   * ORDER IS THE WHOLE MECHANISM. settings.ts resolves `settingsPath` at module
   * scope, and ESM evaluates every import before the importing module's body —
   * so this redirect only lands if its import sits ABOVE the one that reads it.
   * A tidy-up that alphabetises the import block would silently restore the bug
   * and no test but this one would notice.
   */
  const index = read('src', 'main', 'index.ts')
  const profileAt = index.indexOf("'./profile.js'")
  const settingsAt = index.indexOf("'./settings.js'")
  assert.ok(profileAt !== -1, 'index.ts does not import profile.js at all')
  assert.ok(settingsAt !== -1, 'index.ts no longer imports settings.js — update this guard')
  assert.ok(
    profileAt < settingsAt,
    'profile.js is imported after settings.js, so the redirect lands too late',
  )
})

test('settings still resolve under Electron userData, not a hardcoded path', () => {
  // The redirect only works because settings.ts asks Electron where userData
  // is. A literal path would route around profile.ts entirely.
  const settings = read('src', 'main', 'settings.ts')
  assert.match(settings, /app\.getPath\('userData'\)/, 'settings.json no longer follows userData')
})
