/**
 * The sync switch's one promise to everyone who is not Nathan: it is OFF unless
 * they turned it on. A vault that happens to be a git repo must never be
 * committed and pushed because someone installed an app.
 *
 * Its own settings instance (`?vault-sync`), because test/index.mjs loads every
 * suite into one process and settings.ts fixes its file path at import. The
 * vault is a plain folder, so the pass the switch starts finds no repo and
 * touches nothing, including the repositories vault-sync.test.mjs builds.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREV = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'settings-vault-sync-'))
process.env.TEST_USER_DATA = USER_DATA
const settings = await import('../src/main/settings.ts?vault-sync')
if (PREV === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV
const vault = await import('../src/main/vault.ts')
const { CH } = await import('../src/shared/ipc.ts')

const H = new Map()
settings.register((channel, fn) => H.set(channel, fn))
const FILE = join(USER_DATA, 'settings.json')

test('off by default, on only by an explicit true, and the choice survives a restart', async () => {
  vault._setVaultDirForTest(mkdtempSync(join(tmpdir(), 'settings-vault-sync-vault-')))

  writeFileSync(FILE, JSON.stringify({}))
  settings.applySettings()
  assert.equal(H.get(CH.settingsGet)().vaultSync, false, 'absent is off')

  writeFileSync(FILE, JSON.stringify({ vaultSync: 'yes' }))
  settings.applySettings()
  assert.equal(H.get(CH.settingsGet)().vaultSync, false, 'anything but true is off')

  assert.equal((await H.get(CH.settingsSetVaultSync)(true)).vaultSync, true)
  assert.equal(JSON.parse(readFileSync(FILE, 'utf8')).vaultSync, true, 'on is written down')
  settings.applySettings()
  assert.equal(H.get(CH.settingsGet)().vaultSync, true, 'and read back after a restart')

  assert.equal((await H.get(CH.settingsSetVaultSync)(false)).vaultSync, false)
  assert.equal('vaultSync' in JSON.parse(readFileSync(FILE, 'utf8')), false, 'off removes the key: the file records decisions, not defaults')

  const status = await H.get(CH.vaultSyncNow)()
  assert.equal(status.enabled, false, 'turned off, a manual pass does nothing')
})
