/**
 * The door outside agents knock on (main/control.ts, shared/control.ts).
 *
 * What it must never do: act for a caller without the token, drive a window
 * that has a different vault open, or pass a path that climbs out of the vault.
 * What it must do: bring the window forward and tell it what to show.
 */
import './fixtures/ts-hooks.mjs'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const shared = await import('../src/shared/control.ts')
const vault = await import('../src/main/vault.ts')
const control = await import('../src/main/control.ts')

// One fake window that records what the app tells it.
const sent = []
let focused = 0
const win = {
  isDestroyed: () => false,
  isMinimized: () => false,
  restore() {},
  show() {},
  focus: () => focused++,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
}

// The suite loads every file into ONE process before running any test, so
// module state set at load time is overwritten by later files. The vault is set
// inside the test, and the window is handed in rather than patched onto the
// Electron stub, where it leaked into the settings suites.
const dir = mkdtempSync(join(tmpdir(), 'fate-control-'))
after(() => control.stop())

test('parseOpen takes the views the app has, and no path that climbs out', () => {
  assert.deepEqual(shared.parseOpen({ view: 'graph' }), { view: 'graph' })
  assert.deepEqual(shared.parseOpen({ view: 'canvas', path: 'Pipelines\\Whisper.canvas' }), { view: 'canvas', path: 'Pipelines/Whisper.canvas' })
  for (const bad of [null, {}, { view: 'terminal' }, { view: 'editor', path: '' }, { view: 'editor', path: '../x.md' }, { view: 'editor', path: 'C:/x.md' }, { view: 'editor', path: '/etc/x' }]) {
    assert.equal(shared.parseOpen(bad), null, JSON.stringify(bad))
  }
})

test('one vault, one file: two spellings of a path meet', () => {
  assert.equal(shared.controlFile('C:\\Vault\\'), shared.controlFile('c:/vault'))
  assert.notEqual(shared.controlFile('C:/Vault'), shared.controlFile('C:/Other'))
})

test('the app announces itself, and answers only the token, for its own vault', async () => {
  vault._setVaultDirForTest(dir)
  await control.start(() => [win])
  const file = shared.controlFile(dir)
  const info = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(info.vault, dir)
  const knock = (route, body, token = info.token) =>
    fetch(`http://127.0.0.1:${info.port}${route}`, {
      method: 'POST',
      headers: { 'x-fate-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  assert.equal((await knock('/open', { view: 'graph', vault: dir }, 'wrong')).status, 403)
  assert.equal((await knock('/open', { view: 'graph', vault: join(dir, 'elsewhere') })).status, 409)
  assert.equal((await knock('/open', { view: 'terminal', vault: dir })).status, 400)
  assert.equal(sent.length, 0, 'nothing refused reached the window')

  assert.equal((await knock('/open', { view: 'canvas', path: 'Board.canvas', vault: dir })).status, 200)
  assert.deepEqual(sent.at(-1), { channel: 'agents:open', payload: { view: 'canvas', path: 'Board.canvas' } })
  assert.equal(focused, 1, 'the window is brought forward')

  assert.equal((await knock('/changed', { vault: dir })).status, 200)
  assert.deepEqual(sent.at(-1), { channel: 'vault:changed', payload: null })

  control.stop()
  assert.ok(!existsSync(file), 'quitting takes the address down with it')
})
