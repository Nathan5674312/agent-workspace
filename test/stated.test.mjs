/**
 * The stated-turns log: what the user said, kept and handed back.
 *
 * The feature exists because the benchmark showed the agent writing notes only
 * when it felt like it. So the tests that matter most here are not "does append
 * work" — they are the two that prove the agent is out of the loop: the parent
 * records on every turn, and the parent hands the record back without being
 * asked. A green suite that never checked the wiring would pass just as happily
 * with the calls deleted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * Imported directly, with no skip guard. An earlier version fell back to a
 * built file and skipped when it was absent — eleven tests quietly did nothing
 * while the suite reported green. If this import breaks, the suite should break.
 */
const stated = await import(`file://${join(ROOT, 'src', 'shared', 'stated.ts')}`)

const fresh = () => mkdtempSync(join(tmpdir(), 'stated-'))

test('a turn is recorded as one JSON line under System/, not as a note', () => {
  const vault = fresh()
  assert.equal(stated.record('the fiscal week starts on Wednesday', 's1', vault), true)

  const file = join(vault, 'System', 'stated.jsonl')
  assert.ok(existsSync(file), 'the log must live under System/, which is machinery not knowledge')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.text, 'the fiscal week starts on Wednesday')
  assert.equal(entry.session, 's1')
  assert.ok(Date.parse(entry.at) > 0, 'every entry is timestamped')
})

test('the text is kept verbatim — this log never summarises', () => {
  const vault = fresh()
  const said = 'Amounts are in CENTS.\n\nNever use floats for money — the ledger is audited.'
  stated.record(said, 's1', vault)
  const entry = JSON.parse(readFileSync(join(vault, 'System', 'stated.jsonl'), 'utf8').trim())
  assert.equal(entry.text, said, 'a paraphrase here would be an inference, which is the whole thing this avoids')
})

test('empty and whitespace-only turns are not recorded', () => {
  const vault = fresh()
  assert.equal(stated.record('', 's1', vault), false)
  assert.equal(stated.record('   \n  ', 's1', vault), false)
  assert.equal(existsSync(join(vault, 'System', 'stated.jsonl')), false)
})

test('a failed write never throws — losing a log line must not fail the turn', () => {
  // A file where the System/ directory needs to be: mkdir will fail.
  const vault = fresh()
  writeFileSync(join(vault, 'System'), 'not a directory', 'utf8')
  assert.equal(stated.record('something', 's1', vault), false)
})

test('a half-written final line is skipped rather than poisoning the read', () => {
  const vault = fresh()
  stated.record('first', 's1', vault)
  const file = join(vault, 'System', 'stated.jsonl')
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"at":"2026-01-01T00:00`, 'utf8')

  const all = stated.readAll(vault)
  assert.equal(all.length, 1, 'the good line survives a killed process mid-append')
  assert.equal(all[0].text, 'first')
})

test('readAll on a vault with no log is empty, not an error', () => {
  assert.deepEqual(stated.readAll(fresh()), [])
})

test('the preamble replays earlier turns and says they are the user speaking', () => {
  const vault = fresh()
  stated.record('the fiscal week starts on Wednesday', 'old', vault)

  const p = stated.preamble({ excludeSession: 'new', vaultDir: vault })
  assert.ok(p.includes('the fiscal week starts on Wednesday'))
  assert.match(p, /user has told you/i)
  assert.match(p, /not a summary|not anything an agent/i,
    'it must be clear this is what was SAID, not what some agent concluded')
})

test('the current session\'s own turns are not replayed back at it', () => {
  const vault = fresh()
  stated.record('older rule from before', 'old', vault)
  stated.record('what I just typed', 'current', vault)

  const p = stated.preamble({ excludeSession: 'current', vaultDir: vault })
  assert.ok(p.includes('older rule from before'))
  assert.ok(!p.includes('what I just typed'), 'already in context; replaying it wastes budget')
})

test('an empty log produces no preamble at all', () => {
  assert.equal(stated.preamble({ vaultDir: fresh() }), undefined)
})

test('when the budget is tight the NEWEST turns are kept', () => {
  const vault = fresh()
  stated.record(`ancient ${'x'.repeat(300)}`, 's1', vault)
  stated.record(`recent ${'y'.repeat(300)}`, 's2', vault)

  const p = stated.preamble({ budget: 400, vaultDir: vault })
  assert.ok(p.includes('recent'), 'a rule stated recently is likelier to still hold')
  assert.ok(!p.includes('ancient'))
  assert.match(p, /1 older turn not shown/, 'dropping history silently would hide the gap')
})

test('a budget too small for even one turn yields no preamble', () => {
  const vault = fresh()
  stated.record('x'.repeat(500), 's1', vault)
  assert.equal(stated.preamble({ budget: 10, vaultDir: vault }), undefined)
})

// ------------------------------------------------------------------ the wiring
/**
 * Source-level, deliberately. The point of this feature is that recording and
 * recall do NOT depend on anyone choosing to do them, so the assertion has to be
 * that the calls exist at the one place every turn passes through.
 */
const supervisor = readFileSync(join(ROOT, 'src', 'main', 'supervisor.ts'), 'utf8')
const agentHost = readFileSync(join(ROOT, 'src', 'main', 'agentHost.ts'), 'utf8')

test('the parent records every turn, without asking the model', () => {
  assert.match(supervisor, /stated\.record\(text, session\.id, getVaultDir\(\)\)/,
    'capture must sit on the path every turn takes')
})

test('the parent hands back earlier turns on a NEW session only', () => {
  assert.match(supervisor, /stated:\s*session\.sdkSessionId\s*\n?\s*\?\s*undefined/,
    'a resumed session already has these turns in context')
  assert.match(supervisor, /stated\.preamble\(\{ excludeSession: session\.id,/)
})

test('the child still never touches the vault — it receives the text, it does not fetch it', () => {
  assert.ok(
    !/from '\.\/vault\.js'/.test(agentHost),
    'agentHost importing vault.ts would walk past the consent gate this whole design rests on',
  )
  assert.match(agentHost, /stated: string \| undefined/, 'it arrives as data on HostStart')
})

test('the recalled block leads the prompt, and is not passed off as a system rule', () => {
  assert.match(agentHost, /msg\.stated \? `\$\{msg\.stated\}/,
    'it is the user\'s own words and belongs in front of their request')
  assert.ok(
    !/systemPrompt:\s*msg\.stated/.test(agentHost),
    'attributing the user\'s words to the system invites the model to read them as policy',
  )
})
