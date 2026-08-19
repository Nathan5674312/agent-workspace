/**
 * THE CONSENT GATE.
 *
 * src/main/consent.ts is the only thing standing between an autonomous agent
 * and someone's notes. It was written and shipped without tests, which for a
 * security mechanism means "it compiles" was the entire evidence base.
 *
 * These run against the REAL corner.ts, not a stub. The gate's whole claim is
 * that it does not settle without a human answering, and a stubbed prompt that
 * returns instantly would prove the opposite of what needs proving. So consent
 * is raised, observed sitting unanswered in the corner, and then answered
 * through the same `corner:decide` channel the renderer uses.
 *
 * The load-bearing assertion in the deny tests is not that the call rejected.
 * It is that THE DISK DID NOT CHANGE. A gate that throws after writing is not a
 * gate.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PREV_USER_DATA = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'consent-gate-userdata-'))
process.env.TEST_USER_DATA = USER_DATA

const corner = await import('../src/main/corner.ts')
const consent = await import('../src/main/consent.ts')
const vault = await import('../src/main/vault.ts')

if (PREV_USER_DATA === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV_USER_DATA

// channel -> handler, captured from corner's own register()
const H = new Map()
corner.register((channel, fn) => H.set(channel, fn))

const items = () => H.get('corner:items')()
const decide = (d) => H.get('corner:decide')(d)

const pendingConsents = () => items().filter((i) => i.kind === 'consent')

/** A fresh vault per test, so nothing inherits another's files. */
function scratchVault() {
  const dir = mkdtempSync(join(tmpdir(), 'consent-gate-vault-'))
  vault._setVaultDirForTest(dir)
  return dir
}

const USER = { kind: 'user' }
const agent = (over = {}) => ({
  kind: 'agent',
  sessionId: 's1',
  reason: 'filing today captures',
  ...over,
})

/**
 * Answer the next consent to appear.
 *
 * Polls rather than awaiting a signal because the operation under test is
 * mid-flight and has not returned — that is the point. Fails loudly on timeout
 * instead of hanging the suite, so "the gate never asked" is a test failure
 * rather than a stalled run.
 */
async function answerNext(allow, scope) {
  for (let i = 0; i < 200; i++) {
    const [c] = pendingConsents()
    if (c) {
      await decide(scope ? { id: c.id, allow, scope } : { id: c.id, allow })
      return c
    }
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('no consent was raised within 1s — the gate did not ask')
}

/** Settle-or-PENDING, for proving a call is genuinely blocked. */
const PENDING = Symbol('pending')
function settledWithin(p, ms) {
  let timer
  const sentinel = new Promise((r) => {
    timer = setTimeout(() => r(PENDING), ms)
  })
  return Promise.race([p.catch(() => 'rejected'), sentinel]).finally(() => clearTimeout(timer))
}

test.beforeEach(() => {
  consent._resetAllowancesForTest()
  for (const c of pendingConsents()) H.get('corner:dismiss')(c.id)
})

// ---------------------------------------------------------------- user actor

test('a user-originated save raises no consent at all', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')
  const { mtime } = await vault.read('a.md')

  await vault.save('a.md', 'two', mtime, USER)

  assert.equal(pendingConsents().length, 0, 'the user was prompted for their own edit')
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf-8'), 'two')
})

test('a user-originated mkdir and move raise no consent', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')

  await vault.mkdir('Sub', USER)
  await vault.move('a.md', 'Sub/a.md', USER)

  assert.equal(pendingConsents().length, 0)
  assert.ok(existsSync(join(dir, 'Sub', 'a.md')))
})

// --------------------------------------------------------------- agent actor

test('an agent move BLOCKS until answered, and a denial leaves the disk untouched', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')

  const p = vault.move('a.md', 'b.md', agent())

  // The claim is "does not happen until a human answers". Prove it is stuck.
  assert.equal(await settledWithin(p, 120), PENDING, 'the move settled without a human')
  assert.equal(pendingConsents().length, 1)

  await answerNext(false)
  await assert.rejects(p, (e) => e.name === 'ConsentDenied' && e.kind === 'move')

  // The assertion that matters.
  assert.ok(existsSync(join(dir, 'a.md')), 'the original was moved despite a denial')
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf-8'), 'one')
  assert.ok(!existsSync(join(dir, 'b.md')), 'the destination was written despite a denial')
})

test('an agent move proceeds once approved', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')

  const p = vault.move('a.md', 'b.md', agent())
  const raised = await answerNext(true)
  await p

  assert.ok(existsSync(join(dir, 'b.md')))
  assert.ok(!existsSync(join(dir, 'a.md')), 'the original is still at its old path')
  assert.match(raised.detail, /filing today captures/, "the agent's reason was not shown")
})

test('a denied agent save does not write, and a denied mkdir does not create', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')
  const { mtime } = await vault.read('a.md')

  const s = vault.save('a.md', 'CLOBBERED', mtime, agent())
  await answerNext(false)
  await assert.rejects(s, (e) => e.name === 'ConsentDenied')
  assert.equal(readFileSync(join(dir, 'a.md'), 'utf-8'), 'one', 'a denied save still wrote')

  const m = vault.mkdir('Nope', agent())
  await answerNext(false)
  await assert.rejects(m, (e) => e.name === 'ConsentDenied')
  assert.ok(!existsSync(join(dir, 'Nope')), 'a denied mkdir still created the folder')
})

// -------------------------------------------------------------------- batches

test('a batch of five moves asks ONCE, not five times', async () => {
  const dir = scratchVault()
  for (const n of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(dir, `${n}.md`), n)
  const ops = ['a.md -> x/a.md', 'b.md -> x/b.md', 'c.md -> x/c.md', 'd.md -> x/d.md', 'e.md -> x/e.md']

  mkdirSync(join(dir, 'x'))
  let asked = 0

  const p = consent.withBatchConsent(agent(), 'move', ops, async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      await vault.move(`${n}.md`, `x/${n}.md`, agent())
    }
  })

  // One prompt covers the whole run.
  const c = await answerNext(true)
  asked += 1
  await p

  assert.equal(asked, 1)
  assert.equal(pendingConsents().length, 0, 'the batch asked more than once')
  assert.match(c.detail, /5/, 'the prompt did not state how many files')
  for (const n of ['a', 'b', 'c', 'd', 'e']) {
    assert.ok(existsSync(join(dir, 'x', `${n}.md`)), `${n}.md did not move`)
  }
})

test('a batch grant is bounded by what was declared — a sixth move asks again', async () => {
  const dir = scratchVault()
  for (const n of ['a', 'b']) writeFileSync(join(dir, `${n}.md`), n)
  mkdirSync(join(dir, 'x'))

  // Declare ONE, attempt two.
  const p = consent.withBatchConsent(agent(), 'move', ['a.md -> x/a.md'], async () => {
    await vault.move('a.md', 'x/a.md', agent())
    await vault.move('b.md', 'x/b.md', agent())
  })

  await answerNext(true) // the batch grant, worth exactly 1
  await answerNext(false) // the over-run move must ask again; deny it

  await assert.rejects(p, (e) => e.name === 'ConsentDenied')
  assert.ok(existsSync(join(dir, 'x', 'a.md')), 'the granted move did not happen')
  assert.ok(existsSync(join(dir, 'b.md')), 'the ungranted move happened anyway')
})

// ---------------------------------------------------------------- allowances

test('"allow for this session" suppresses the next ask for the same kind', async () => {
  const dir = scratchVault()
  for (const n of ['a', 'b']) writeFileSync(join(dir, `${n}.md`), n)

  const first = vault.move('a.md', 'a2.md', agent())
  await answerNext(true, 'session')
  await first

  // Second move: no prompt should be raised at all.
  await vault.move('b.md', 'b2.md', agent())
  assert.equal(pendingConsents().length, 0, 'a session allowance did not suppress the second ask')
  assert.ok(existsSync(join(dir, 'b2.md')))
})

test('a session allowance does NOT cover a different kind', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')

  const mv = vault.move('a.md', 'a2.md', agent())
  await answerNext(true, 'session')
  await mv

  // move is trusted for the session; mkdir is not.
  const mk = vault.mkdir('Sub', agent())
  assert.equal(await settledWithin(mk, 120), PENDING, 'mkdir rode a move allowance')
  await answerNext(false)
  await assert.rejects(mk, (e) => e.name === 'ConsentDenied')
})

test('one agent session cannot spend another session\'s allowance', async () => {
  const dir = scratchVault()
  for (const n of ['a', 'b']) writeFileSync(join(dir, `${n}.md`), n)

  const first = vault.move('a.md', 'a2.md', agent({ sessionId: 's1' }))
  await answerNext(true, 'session')
  await first

  const other = vault.move('b.md', 'b2.md', agent({ sessionId: 's2' }))
  assert.equal(await settledWithin(other, 120), PENDING, 's2 inherited s1\'s allowance')
  await answerNext(false)
  await assert.rejects(other, (e) => e.name === 'ConsentDenied')
  assert.ok(existsSync(join(dir, 'b.md')), 's2 moved the file on s1\'s permission')
})

// --------------------------------------------------------------- malformed actors

test('an agent with a blank reason is refused before anything is asked', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')

  for (const reason of ['', '   ']) {
    await assert.rejects(
      vault.move('a.md', 'b.md', agent({ reason })),
      /non-empty reason/,
      `reason ${JSON.stringify(reason)} was accepted`,
    )
  }
  assert.equal(pendingConsents().length, 0, 'a malformed actor still raised a prompt')
  assert.ok(existsSync(join(dir, 'a.md')))
})

test('a missing or malformed actor is refused, not treated as a user', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'a.md'), 'one')

  // The failure this guards: annotations are erased at runtime, so a forgotten
  // argument arrives as undefined. Assuming the benign case there would make
  // every gate optional.
  for (const bad of [undefined, null, {}, { kind: 'root' }, 'user']) {
    await assert.rejects(vault.move('a.md', 'b.md', bad), /consent:/)
  }
  await assert.rejects(vault.move('a.md', 'b.md', agent({ sessionId: '' })), /sessionId/)

  assert.ok(existsSync(join(dir, 'a.md')), 'a malformed actor still moved the file')
})

test.after(() => {
  try {
    rmSync(USER_DATA, { recursive: true, force: true })
  } catch {}
})
