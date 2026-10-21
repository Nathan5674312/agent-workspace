/**
 * The vault's standing orders reach the in-app agent.
 *
 * The bug this closes: the agent ran with no system prompt and no
 * settingSources, so a vault's AGENTS.md and CLAUDE.md never reached it and it
 * used the vault only when it happened to think of it. The wiring tests matter
 * as much as the reader: a green suite would pass just as happily with the call
 * in supervisor.ts deleted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { standingOrders } = await import(`file://${join(ROOT, 'src', 'shared', 'orders.ts')}`)

const fresh = () => mkdtempSync(join(tmpdir(), 'orders-'))

test('a vault with neither file gives nothing, not an empty block', () => {
  assert.equal(standingOrders(fresh()), undefined)
})

test('both files arrive verbatim, AGENTS.md first', () => {
  const vault = fresh()
  writeFileSync(join(vault, 'CLAUDE.md'), 'Read AGENTS.md first.\n')
  writeFileSync(join(vault, 'AGENTS.md'), 'Rule 0: read-only unless asked.\n')
  const out = standingOrders(vault)
  assert.ok(out.includes('<AGENTS.md>\nRule 0: read-only unless asked.\n</AGENTS.md>'))
  assert.ok(out.includes('<CLAUDE.md>\nRead AGENTS.md first.\n</CLAUDE.md>'))
  assert.ok(out.indexOf('<AGENTS.md>') < out.indexOf('<CLAUDE.md>'))
})

test('an empty file is skipped, and a huge one is cut and says so', () => {
  const vault = fresh()
  writeFileSync(join(vault, 'AGENTS.md'), '   \n')
  assert.equal(standingOrders(vault), undefined)
  writeFileSync(join(vault, 'CLAUDE.md'), 'x'.repeat(50))
  const out = standingOrders(vault, 10)
  assert.ok(out.includes(`${'x'.repeat(10)}\n\n(cut at 10 characters; read CLAUDE.md for the rest)`))
  assert.ok(!out.includes('x'.repeat(11)))
})

// ------------------------------------------------------------------ the wiring

const supervisor = readFileSync(join(ROOT, 'src', 'main', 'supervisor.ts'), 'utf8')
const agentHost = readFileSync(join(ROOT, 'src', 'main', 'agentHost.ts'), 'utf8')

test('the parent reads the orders on every turn, resumes included', () => {
  assert.match(supervisor, /orders: standingOrders\(getVaultDir\(\)\),/)
})

test('the child puts them in the system prompt and never loads settings from the vault', () => {
  assert.match(agentHost, /systemPrompt: msg\.orders,/)
  assert.ok(
    !/settingSources/.test(agentHost),
    "settingSources would load the vault's .claude/settings.json, and its hooks run shell commands",
  )
})
