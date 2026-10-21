/**
 * The `external` actor: an agent outside the app writing through the MCP
 * server. It passes the gate with no prompt (its own client already asked), so
 * the two fields it carries are the whole of its accountability, and a blank
 * one must be refused exactly as an in-app agent's blank reason is.
 */
import './fixtures/ts-hooks.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const consent = await import('../src/main/consent.ts')
const corner = await import('../src/main/corner.ts')

// The corner's own list, read the way consent-gate.test.mjs reads it.
const H = new Map()
corner.register((channel, fn) => H.set(channel, fn))
const pending = () => H.get('corner:items')().filter((i) => i.kind === 'consent').length
const vault = await import('../src/main/vault.ts')

const ext = { kind: 'external', agent: 'claude-code', evidence: 'the user said "save this"' }

test('an external actor with a name and evidence passes without raising a prompt', async () => {
  const before = pending()
  await consent.gate(ext, 'write', ['Notes/x.md'])
  await consent.withBatchConsent(ext, 'write', ['a', 'b'], async () => {})
  assert.equal(pending(), before, 'no consent was queued in the corner')
})

test('a blank name or blank evidence is refused, never assumed', async () => {
  for (const bad of [
    { kind: 'external', agent: '', evidence: 'x' },
    { kind: 'external', agent: 'claude-code', evidence: '   ' },
    { kind: 'external', agent: 'claude-code' },
    { kind: 'externals', agent: 'claude-code', evidence: 'x' },
  ]) {
    await assert.rejects(consent.gate(bad, 'write', ['x.md']), /consent:/, JSON.stringify(bad))
  }
})

test('its writes still get the backup every write gets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'consent-external-'))
  vault._setVaultDirForTest(dir)
  const first = await vault.save('Note.md', 'one\n', 0, ext)
  await vault.save('Note.md', 'two\n', first.mtime, ext)
  assert.equal(readFileSync(join(dir, 'Note.md'), 'utf8'), 'two\n')
  assert.ok(readdirSync(join(dir, '.backups')).some((f) => f.startsWith('Note.md.')))
})
