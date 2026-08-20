/**
 * Appearance overrides: the main-process half (validation, clamping,
 * persistence) and the one invariant the renderer half rests on.
 *
 * Drives the REAL src/main/settings.ts. `./fixtures/ts-hooks.mjs` rewrites the
 * `.js` specifiers to `.ts` and redirects `electron` to the stub, so what runs
 * here is the module that ships, not a copy of it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './fixtures/ts-hooks.mjs'

// settings.ts computes settings.json's path at module scope from
// app.getPath('userData'), so the env has to be set before the import.
const PREV_USER_DATA = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'appearance-'))
process.env.TEST_USER_DATA = USER_DATA

const settings = await import('../src/main/settings.ts')
const { DEFAULT_APPEARANCE, ARTWORK_OPACITY_MAX, CH } = await import('../src/shared/ipc.ts')

// Leave the environment as it was found; later suites import other modules.
if (PREV_USER_DATA === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV_USER_DATA

const SETTINGS_FILE = join(USER_DATA, 'settings.json')

/** channel -> handler, captured from settings.ts's own register(). */
const H = new Map()
settings.register((channel, fn) => H.set(channel, fn))

const get = () => H.get(CH.settingsGet)()
const set = (a) => H.get(CH.settingsSetAppearance)(a)
const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))

const VALID = {
  transparency: 'reduced',
  motion: 'reduced',
  artwork: false,
  artworkOpacity: 0.1,
}

test('a vault with no settings.json reports the documented defaults', () => {
  settings.applySettings()
  assert.ok(!existsSync(SETTINGS_FILE), 'reading settings must not create the file')
  assert.deepEqual(get().appearance, DEFAULT_APPEARANCE)
})

test('a valid appearance round-trips through disk', () => {
  assert.deepEqual(set(VALID).appearance, VALID)
  assert.deepEqual(onDisk().appearance, VALID)
})

test('opacity above the ceiling is clamped, not rejected', () => {
  // The ceiling is the point: above ~0.20 the artwork lightens the Ink ground
  // the palette's contrast ratios were measured against.
  const got = set({ ...VALID, artworkOpacity: 0.9 }).appearance
  assert.equal(got.artworkOpacity, ARTWORK_OPACITY_MAX)
  assert.equal(onDisk().appearance.artworkOpacity, ARTWORK_OPACITY_MAX)

  assert.equal(set({ ...VALID, artworkOpacity: -1 }).appearance.artworkOpacity, 0)
})

test('a junk field falls back to its default and costs only itself', () => {
  const got = set({
    motion: null, // not in the union
    transparency: 'reduced', // valid, must survive
    artwork: 'yes', // a string, not a boolean
    artworkOpacity: Number.NaN,
  }).appearance

  assert.equal(got.transparency, 'reduced', 'a valid field was dropped with an invalid one')
  assert.equal(got.motion, DEFAULT_APPEARANCE.motion)
  assert.equal(got.artwork, DEFAULT_APPEARANCE.artwork)
  // NaN survives a bare Math.min/Math.max clamp, so this is the case that
  // proves the finiteness check is actually there.
  assert.equal(got.artworkOpacity, DEFAULT_APPEARANCE.artworkOpacity)
})

test('a hand-corrupted settings.json still boots, with defaults', () => {
  writeFileSync(SETTINGS_FILE, '{"appearance": "not an object"}', 'utf8')
  settings.applySettings()
  assert.deepEqual(get().appearance, DEFAULT_APPEARANCE)
})

test('appearance is additive — writing it does not disturb vaultDir', () => {
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({ vaultDir: 'C:/somewhere/else' }, null, 2),
    'utf8',
  )
  settings.applySettings()
  set(VALID)
  assert.equal(onDisk().vaultDir, 'C:/somewhere/else')
})

// ------------------------------------------------- the renderer's invariant

/**
 * 'system' must set NO attribute. If a `[data-*='system']` selector ever
 * appears, the OS `@media` blocks in app.css have been shadowed by a rule that
 * claims to be "the system setting" and is not — which is the exact failure
 * this whole design exists to avoid.
 */
test("appearance.css never styles a 'system' state", () => {
  const css = readFileSync(new URL('../src/renderer/appearance.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\[data-[a-z]+=['"]?system/)
})

/** app.css is another section's file; the overrides must not have leaked in. */
test('the OS media queries in app.css are untouched', () => {
  const css = readFileSync(new URL('../src/renderer/app.css', import.meta.url), 'utf8')
  assert.match(css, /@media \(prefers-reduced-transparency: reduce\)/)
  assert.match(css, /@media \(prefers-contrast: more\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(css, /\[data-contrast|\[data-transparency|\[data-motion|\[data-artwork/)
})
