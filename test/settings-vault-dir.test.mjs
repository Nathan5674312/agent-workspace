/**
 * The vault-folder half of settings.ts: what load() will accept off disk, that
 * save() cannot leave a half-written file behind, and that a persisted folder is
 * only applied if it is still there.
 *
 * Drives the REAL src/main/settings.ts, same as appearance.test.mjs —
 * `./fixtures/ts-hooks.mjs` rewrites the `.js` specifiers to `.ts` and redirects
 * `electron` to the stub, so what runs here is the module that ships.
 *
 * "Not applied" is asserted as "the vault root did not move", never as "the root
 * equals some constant": applying a folder is a one-way call into vault.ts, so
 * the root at the start of a test is whatever the test before it left.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './fixtures/ts-hooks.mjs'

// settings.ts computes settings.json's path at module scope from
// app.getPath('userData'), so the env has to be set before the import.
const PREV_USER_DATA = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'settings-vault-'))
process.env.TEST_USER_DATA = USER_DATA

// `?vault-dir`, and not a bare specifier, because test/index.mjs imports every
// suite into ONE process: appearance.test.mjs imports settings.ts first, and a
// shared instance would have already frozen settings.json's path onto THAT
// suite's scratch directory, leaving everything written below invisible to the
// module under test. ESM caches by full URL, so the query buys a second
// instance bound to this suite's directory. vault.ts is imported by settings.ts
// without a query and so stays shared, which is what makes getVaultDir() below
// the real one.
const settings = await import('../src/main/settings.ts?vault-dir')
const { DEFAULT_APPEARANCE, CH } = await import('../src/shared/ipc.ts')

// Leave the environment as it was found; later suites import other modules.
if (PREV_USER_DATA === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV_USER_DATA

const SETTINGS_FILE = join(USER_DATA, 'settings.json')
const TMP_FILE = `${SETTINGS_FILE}.tmp`

/** channel -> handler, captured from settings.ts's own register(). */
const H = new Map()
settings.register((channel, fn) => H.set(channel, fn))

const get = () => H.get(CH.settingsGet)()
const set = (a) => H.get(CH.settingsSetAppearance)(a)
const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
const writeSettings = (text) => writeFileSync(SETTINGS_FILE, text, 'utf8')

// ------------------------------------------------------------- load() input

/**
 * Six shapes of bad settings.json. All must reach the same place — defaults, no
 * throw, vault root untouched — because the file sits in a user-writable
 * directory and a hand-edit must never stop the app booting.
 */
for (const [name, text] of [
  ['truncated JSON', '{"vaultDir": "C:/somewh'],
  ['valid JSON that is not an object', '"C:/a/vault"'],
  ['an array', '[]'],
  ['null', 'null'],
  ['a non-string vaultDir', '{"vaultDir": 42}'],
  ['an empty-string vaultDir', '{"vaultDir": ""}'],
]) {
  test(`load() falls back to defaults for ${name}`, () => {
    const before = get().vaultDir
    writeSettings(text)
    settings.applySettings()

    const s = get()
    assert.equal(s.vaultDir, before, 'a rejected file must leave the vault root alone')
    assert.equal(s.pendingVaultDir, null)
    assert.deepEqual(s.appearance, DEFAULT_APPEARANCE)
  })
}

test('a missing settings.json is not an error — it is the first run', () => {
  const before = get().vaultDir
  rmSync(SETTINGS_FILE, { force: true })
  settings.applySettings()

  assert.equal(get().vaultDir, before)
  assert.ok(!existsSync(SETTINGS_FILE), 'reading settings must not create the file')
})

// ---------------------------------------------------------- save() is atomic

test('save() writes through a temp file and leaves nothing behind', () => {
  rmSync(SETTINGS_FILE, { force: true })
  settings.applySettings()
  set({ ...DEFAULT_APPEARANCE, contrast: 'more' })

  assert.equal(onDisk().appearance.contrast, 'more')
  assert.ok(!existsSync(TMP_FILE), 'the temp file must be renamed, not copied and left')
})

/**
 * The defect temp+rename exists to prevent: writeFileSync truncates the
 * destination BEFORE writing it, so a crash between the two leaves a 0-byte
 * settings.json that load() reads as "no setting" — silently sending the app
 * back to the default vault with the user's folder gone from the file.
 *
 * The crash is staged rather than caused: a half-written temp file is exactly
 * what a process killed mid-save leaves behind. The assertion is that
 * settings.json still holds the last GOOD save, byte for byte.
 */
test('a crash mid-write cannot truncate settings.json', () => {
  rmSync(SETTINGS_FILE, { force: true })
  settings.applySettings()
  set({ ...DEFAULT_APPEARANCE, contrast: 'more' })
  const good = readFileSync(SETTINGS_FILE, 'utf8')

  writeFileSync(TMP_FILE, '{"appearance": {"cont', 'utf8')

  assert.equal(readFileSync(SETTINGS_FILE, 'utf8'), good, 'the destination was touched')
  settings.applySettings()
  assert.equal(get().appearance.contrast, 'more', 'the last good save did not survive')

  rmSync(TMP_FILE, { force: true })
})

/**
 * The test above cannot see a bare writeFileSync sneaking back in — it would
 * keep passing right up until the process actually died at the wrong moment. So
 * the invariant is pinned at the source instead: the only path written directly
 * is the temp one, and settingsPath is only ever reached by a rename.
 */
test('settings.ts never writes settingsPath directly', () => {
  const src = readFileSync(new URL('../src/main/settings.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /writeFileSync\(\s*settingsPath/)
  assert.match(src, /renameSync\(\s*tmp,\s*settingsPath\s*\)/)
})

// ----------------------------------------- applySettings() and the vault folder

test('a persisted vaultDir that exists IS applied', () => {
  const real = mkdtempSync(join(tmpdir(), 'vault-real-'))
  writeSettings(JSON.stringify({ vaultDir: real }))
  settings.applySettings()

  const s = get()
  assert.equal(s.vaultDir, real)
  // Applied means in use, so nothing is waiting on a restart and nothing is wrong.
  assert.equal(s.pendingVaultDir, null)
  assert.equal(s.rootMismatch, null)
})

test('a persisted vaultDir that no longer exists is NOT applied, and says why', () => {
  const before = get().vaultDir
  const gone = join(tmpdir(), 'vault-that-was-deleted-9f3a')
  rmSync(gone, { recursive: true, force: true })
  writeSettings(JSON.stringify({ vaultDir: gone }))
  settings.applySettings()

  const s = get()
  assert.notEqual(s.vaultDir, gone, 'the app booted pointed at a folder that is not there')
  assert.equal(s.vaultDir, before, 'the vault root moved anyway')

  // Surfaced, not swallowed: the modal renders rootMismatch, and the message has
  // to name the folder or the user cannot tell what to re-pick.
  assert.ok(s.rootMismatch, 'a refused vault folder was not reported at all')
  assert.ok(
    s.rootMismatch.includes(gone),
    `the message must name the missing folder, got: ${s.rootMismatch}`,
  )

  // "Restart to open it" would be a lie sitting directly under "it is missing".
  assert.equal(s.pendingVaultDir, null)

  // The choice stays on disk — the drive may come back, and dropping it would
  // discard a setting the user made.
  assert.equal(onDisk().vaultDir, gone)
})

test('a persisted vaultDir naming a FILE is refused too', () => {
  const before = get().vaultDir
  const file = join(USER_DATA, 'not-a-folder.md')
  writeFileSync(file, '# not a vault', 'utf8')
  writeSettings(JSON.stringify({ vaultDir: file }))
  settings.applySettings()

  const s = get()
  assert.equal(s.vaultDir, before)
  assert.ok(s.rootMismatch?.includes(file))
})

/**
 * checkRoots() lands asynchronously, long after applySettings() has run, and
 * index.ts pipes its result straight into setRootMismatch(). A healthy default
 * root makes that result null — which must NOT erase the reason the app is
 * sitting on the default root in the first place.
 */
test('a later checkRoots() result does not erase the refusal', () => {
  const gone = join(tmpdir(), 'vault-that-was-deleted-9f3a')
  writeSettings(JSON.stringify({ vaultDir: gone }))
  settings.applySettings()

  settings.setRootMismatch(null)
  assert.ok(get().rootMismatch?.includes(gone), 'the refusal was overwritten by checkRoots()')
})

test('a good vaultDir clears a previous refusal', () => {
  writeSettings(JSON.stringify({ vaultDir: join(tmpdir(), 'vault-that-was-deleted-9f3a') }))
  settings.applySettings()
  assert.ok(get().rootMismatch, 'precondition: a refusal is standing')

  const real = mkdtempSync(join(tmpdir(), 'vault-real-'))
  writeSettings(JSON.stringify({ vaultDir: real }))
  settings.applySettings()

  const s = get()
  assert.equal(s.vaultDir, real)
  assert.equal(s.rootMismatch, null)
})
