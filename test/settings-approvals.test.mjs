/**
 * The approvals half of settings.ts: that a persisted policy actually reaches
 * the GATE, and that nothing the file says can make the gate ask less than it
 * would have asked by default.
 *
 * Drives the REAL src/main/settings.ts and the REAL src/main/consent.ts, same
 * technique as settings-vault-dir.test.mjs — `./fixtures/ts-hooks.mjs` rewrites
 * the `.js` specifiers to `.ts` and redirects `electron` to the stub.
 *
 * The load-bearing idea under every assertion below: settings.ts holds NO
 * validator for this value. consent.ts owns the only one, and state() reads back
 * through `getApprovalsPolicy()`. So "what the file said" and "what is enforced"
 * cannot drift apart, and these tests are what holds that.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './fixtures/ts-hooks.mjs'

// settings.ts computes settings.json's path at module scope from
// app.getPath('userData'), so the env has to be set before the import.
const PREV_USER_DATA = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'settings-approvals-'))
process.env.TEST_USER_DATA = USER_DATA

// `?approvals` for the reason settings-vault-dir.test.mjs explains: test/index.mjs
// imports every suite into ONE process, and a shared settings.ts instance would
// have frozen settings.json's path onto whichever suite imported it first.
// consent.ts is imported WITHOUT a query on purpose — it must be the same module
// instance settings.ts installs into, or this suite would be checking a copy.
const settings = await import('../src/main/settings.ts?approvals')
const { getApprovalsPolicy, setApprovalsPolicy } = await import('../src/main/consent.ts')
const { CH, DEFAULT_APPROVALS } = await import('../src/shared/ipc.ts')

if (PREV_USER_DATA === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV_USER_DATA

const SETTINGS_FILE = join(USER_DATA, 'settings.json')

/** channel -> handler, captured from settings.ts's own register(). */
const H = new Map()
settings.register((channel, fn) => H.set(channel, fn))

const get = () => H.get(CH.settingsGet)()
const setApprovals = (a) => H.get(CH.settingsSetApprovals)(a)
const onDisk = () => JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
const writeSettings = (text) => writeFileSync(SETTINGS_FILE, text, 'utf8')

/**
 * consent-gate.test.mjs runs in this same process and installs policies of its
 * own. Every test here sets the state it depends on rather than inheriting it.
 */
const resetGate = () => setApprovalsPolicy(DEFAULT_APPROVALS)

// ------------------------------------------------------- boot installs policy

test('a persisted policy is installed in the gate at boot', () => {
  resetGate()
  writeSettings(JSON.stringify({ approvals: { mode: 'strict', timeoutMs: 45 } }))
  settings.applySettings()

  assert.deepEqual(getApprovalsPolicy(), { mode: 'strict', timeoutMs: 45 })
  assert.deepEqual(get().approvals, { mode: 'strict', timeoutMs: 45 })
})

test('an absent approvals key RESETS the gate rather than leaving the last one', () => {
  setApprovalsPolicy({ mode: 'strict', timeoutMs: 45 })
  writeSettings(JSON.stringify({ vaultDir: '' }))
  settings.applySettings()

  // applySettings() is the only thing that installs a policy, so a file that no
  // longer mentions one has to mean the default — not "whatever was in force".
  assert.equal(getApprovalsPolicy().mode, 'manual')
  assert.equal(getApprovalsPolicy().timeoutMs, undefined)
})

test('the policy is installed even when there is no persisted vaultDir', () => {
  // applySettings() returns early when there is no vaultDir. The install has to
  // happen BEFORE that return or this whole feature is dead on a fresh install.
  resetGate()
  writeSettings(JSON.stringify({ approvals: { mode: 'strict' } }))
  settings.applySettings()

  assert.equal(getApprovalsPolicy().mode, 'strict')
})

// --------------------------------------------------- nothing on disk is trusted

/**
 * Every one of these must land on 'manual' — still gated. The direction is the
 * point: a file a human edited, or an older build wrote, may never produce a gate
 * that asks LESS than the default.
 */
for (const [name, approvals] of [
  ['the mode that does not exist', { mode: 'off' }],
  ['a mode from some other product', { mode: 'smart' }],
  ['a non-string mode', { mode: 42 }],
  ['no mode at all', { timeoutMs: 100 }],
  ['an empty object', {}],
]) {
  test(`load() normalises ${name} to manual`, () => {
    resetGate()
    writeSettings(JSON.stringify({ approvals }))
    settings.applySettings()

    assert.equal(getApprovalsPolicy().mode, 'manual', 'the gate was weakened')
    assert.equal(get().approvals.mode, 'manual', 'state() reported the file, not the gate')
  })
}

for (const [name, text] of [
  ['approvals that is not an object', '{"approvals": "strict"}'],
  ['approvals that is null', '{"approvals": null}'],
  ['approvals that is an array', '{"approvals": []}'],
  ['truncated JSON', '{"approvals": {"mode": "stri'],
]) {
  test(`load() survives ${name}`, () => {
    resetGate()
    writeSettings(text)
    assert.doesNotThrow(() => settings.applySettings())
    assert.equal(getApprovalsPolicy().mode, 'manual')
  })
}

for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30', null]) {
  test(`a timeoutMs of ${String(bad)} means no timeout, never a zero-length one`, () => {
    resetGate()
    writeSettings(JSON.stringify({ approvals: { mode: 'manual', timeoutMs: bad } }))
    settings.applySettings()

    // A 0 that survived would deny every prompt the instant it opened.
    assert.equal(getApprovalsPolicy().timeoutMs, undefined)
  })
}

// ------------------------------------------------------------- the round trip

test('setApprovals persists the NORMALISED policy, so junk never round-trips', () => {
  resetGate()
  writeSettings('{}')
  settings.applySettings()

  const s = setApprovals({ mode: 'off', timeoutMs: -5 })

  assert.equal(s.approvals.mode, 'manual')
  assert.equal(s.approvals.timeoutMs, undefined)
  // The repaired value is what reaches the disk. Writing the argument instead
  // would leave `mode: "off"` in the file, reading back as manual forever while
  // looking to anyone opening the file like a setting that is in force.
  assert.equal(onDisk().approvals.mode, 'manual')
})

test('setApprovals applies live — no restart, unlike the vault folder', () => {
  resetGate()
  const s = setApprovals({ mode: 'strict', timeoutMs: 30 })

  assert.deepEqual(getApprovalsPolicy(), { mode: 'strict', timeoutMs: 30 })
  assert.deepEqual(s.approvals, { mode: 'strict', timeoutMs: 30 })
  assert.deepEqual(onDisk().approvals, { mode: 'strict', timeoutMs: 30 })
})

test('setApprovals leaves the other settings alone', () => {
  resetGate()
  writeSettings(
    JSON.stringify({ vaultDir: 'C:/does/not/exist', appearance: { transparency: 'reduced' } }),
  )
  settings.applySettings()

  setApprovals({ mode: 'strict' })

  const disk = onDisk()
  assert.equal(disk.vaultDir, 'C:/does/not/exist', 'a saved vault folder was dropped')
  assert.equal(disk.appearance.transparency, 'reduced', 'an appearance override was dropped')
})

test.after(() => {
  resetGate()
  rmSync(USER_DATA, { recursive: true, force: true })
})
