/**
 * THE AGENT'S WRITE PATH.
 *
 * Until now the agent could only read: `tools` was pinned to Read/Glob/Grep and
 * there was nothing behind the consent gate to gate. These cover the tools that
 * changed that, at the layer where the damage would happen — the disk.
 *
 * Same shape as consent-gate.test.mjs, and for the same reason: the real
 * corner.ts, not a stub. A stubbed prompt that returns instantly would prove the
 * opposite of what needs proving. Consent is raised, observed sitting
 * unanswered, then answered through the `corner:decide` channel the renderer
 * uses.
 *
 * The load-bearing assertions are about FILES, never about return values. A
 * write that reports success and wrote nothing, or reports refusal and wrote
 * anyway, is exactly the bug these exist to catch.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PREV_USER_DATA = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'agent-write-userdata-'))
process.env.TEST_USER_DATA = USER_DATA

const corner = await import('../src/main/corner.ts')
const consent = await import('../src/main/consent.ts')
const vault = await import('../src/main/vault.ts')
const claude = await import('../src/main/claude.ts')

if (PREV_USER_DATA === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV_USER_DATA

const H = new Map()
corner.register((channel, fn) => H.set(channel, fn))

const items = () => H.get('corner:items')()
const decide = (d) => H.get('corner:decide')(d)
const pendingConsents = () => items().filter((i) => i.kind === 'consent')

/** A fresh vault per test, so nothing inherits another's files. */
function scratchVault() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-write-vault-'))
  vault._setVaultDirForTest(dir)
  consent._resetAllowancesForTest()
  return dir
}

/**
 * Run one agent operation and answer EVERY prompt it raises, the same way.
 *
 * Every prompt, not one: a write into a folder that does not exist yet
 * legitimately raises two — the folder, then the write — and a helper that
 * answered only the first would hang on exactly the case worth testing.
 *
 * The prompts are ANSWERED rather than pre-authorised, so the wait is real:
 * poll until the corner is actually holding one, then decide. Polling rather
 * than a fixed sleep because the gate is async all the way down and a sleep
 * long enough to be safe is long enough to make the suite unpleasant.
 */
async function withAnswer(allow, run) {
  let settled = false
  const prompts = []
  const done = run().finally(() => {
    settled = true
  })

  for (let i = 0; i < 400 && !settled; i++) {
    const next = pendingConsents()[0]
    if (next) {
      prompts.push(next)
      await decide({ id: next.id, allow })
    } else {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  const result = await done
  assert.ok(prompts.length > 0, 'the operation should have raised a consent prompt')
  return { result, prompt: prompts[0], prompts }
}

const OP_WRITE = (path, text, reason = 'recording what we agreed') => ({
  op: 'write',
  path,
  text,
  reason,
})

test('a write to a new path creates the note, once a human allows it', async () => {
  const dir = scratchVault()
  const { result, prompt, prompts } = await withAnswer(true, () =>
    claude.applyVaultOp('s1', OP_WRITE('Notes/New.md', '# New\n')),
  )

  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(dir, 'Notes/New.md'), 'utf8'), '# New\n')
  // The agent's stated reason is what the human was shown, verbatim. A prompt
  // that drops it is a bare yes/no, which consent.ts exists to refuse.
  assert.match(prompt.detail, /recording what we agreed/)
  // TWO prompts, and in this order: the folder is its own control with its
  // own dialog, because save() refuses to invent one from a typo'd path.
  assert.equal(prompts.length, 2, 'the folder and the write are separate asks')
  assert.match(prompts[0].title, /folder/i)
  rmSync(dir, { recursive: true, force: true })
})

test('a refusal writes NOTHING, and says so in words the agent can act on', async () => {
  const dir = scratchVault()
  const { result } = await withAnswer(false, () =>
    claude.applyVaultOp('s1', OP_WRITE('Nope.md', 'should never land')),
  )

  assert.equal(result.ok, false)
  assert.equal(existsSync(join(dir, 'Nope.md')), false, 'the file must not exist')
  // Told as a refusal, not as a fault: a model that reads a fault retries.
  assert.match(result.message, /did not allow/i)
  rmSync(dir, { recursive: true, force: true })
})

test('overwriting an existing note keeps the previous text under .backups/', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'Old.md'), 'the original text')

  const { result } = await withAnswer(true, () =>
    claude.applyVaultOp('s1', OP_WRITE('Old.md', 'the agent text')),
  )

  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(dir, 'Old.md'), 'utf8'), 'the agent text')

  const backups = readdirSync(join(dir, '.backups'))
  assert.equal(backups.length, 1, 'exactly one pre-edit copy')
  assert.match(backups[0], /^Old\.md\./)
  assert.equal(
    readFileSync(join(dir, '.backups', backups[0]), 'utf8'),
    'the original text',
    'the backup holds what was there BEFORE the agent wrote',
  )
  rmSync(dir, { recursive: true, force: true })
})

/**
 * THE ONE THE README CALLED MISSING.
 *
 * "lost-update handling for an agent editing a note the user has open." The
 * user's editor is holding an mtime from before the agent wrote. Their next save
 * must fail the guard and reach ConflictDialog — never silently overwrite the
 * agent, and never silently lose what they typed.
 *
 * Nothing new implements this. It falls out of the agent going through save()
 * like every other caller, which is the whole argument for routing agent writes
 * through vault.ts instead of giving the SDK its own Write tool.
 */
test("an agent write makes the user's stale save conflict instead of clobbering", async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'Shared.md'), 'v1')

  // What the editor is holding: the note as the user opened it.
  const opened = await vault.read('Shared.md')
  assert.equal(opened.text, 'v1')

  await withAnswer(true, () =>
    claude.applyVaultOp('s1', OP_WRITE('Shared.md', 'v2 from the agent')),
  )

  // The user now hits save on the buffer they have been typing in.
  await assert.rejects(
    () => vault.save('Shared.md', 'v2 from the user', opened.mtime, { kind: 'user' }),
    (e) => e.name === 'SaveConflict',
    'a save against the pre-agent stamp must raise SaveConflict',
  )

  // And the guard is a statement about the disk, not merely about control flow.
  assert.equal(
    readFileSync(join(dir, 'Shared.md'), 'utf8'),
    'v2 from the agent',
    'the refused save must not have written',
  )
  rmSync(dir, { recursive: true, force: true })
})

test('a move is gated too, and leaves an undo id behind', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'Inbox.md'), 'captured')

  const { result } = await withAnswer(true, () =>
    claude.applyVaultOp('s1', {
      op: 'move',
      from: 'Inbox.md',
      to: 'Filed.md',
      reason: 'filing the capture where it belongs',
    }),
  )

  assert.equal(result.ok, true)
  assert.match(result.message, /Undo id /)
  assert.equal(existsSync(join(dir, 'Filed.md')), true)
  assert.equal(existsSync(join(dir, 'Inbox.md')), false)
  rmSync(dir, { recursive: true, force: true })
})

test('a move refused leaves both paths exactly as they were', async () => {
  const dir = scratchVault()
  writeFileSync(join(dir, 'Inbox.md'), 'captured')

  const { result } = await withAnswer(false, () =>
    claude.applyVaultOp('s1', {
      op: 'move',
      from: 'Inbox.md',
      to: 'Filed.md',
      reason: 'filing the capture where it belongs',
    }),
  )

  assert.equal(result.ok, false)
  assert.equal(existsSync(join(dir, 'Inbox.md')), true, 'the source must still be there')
  assert.equal(existsSync(join(dir, 'Filed.md')), false, 'the destination must not exist')
  rmSync(dir, { recursive: true, force: true })
})

/**
 * An agent that cannot say why does not get to act. consent.ts enforces this on
 * the Actor; the check here is that applyVaultOp REPORTS it rather than letting
 * it surface as an unhandled rejection inside the supervisor's relay.
 */
test('a blank reason is refused before anything is written', async () => {
  const dir = scratchVault()
  const result = await claude.applyVaultOp('s1', OP_WRITE('Notes/Blank.md', 'x', '   '))

  assert.equal(result.ok, false)
  assert.match(result.message, /reason/i)
  assert.equal(existsSync(join(dir, 'Notes/Blank.md')), false)
  assert.equal(pendingConsents().length, 0, 'it must not even reach the human')
  rmSync(dir, { recursive: true, force: true })
})

test.after(() => rmSync(USER_DATA, { recursive: true, force: true }))
