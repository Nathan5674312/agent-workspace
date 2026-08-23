/**
 * WHAT NEEDS DOING, AND BY WHOM.
 *
 * `run.ts` says what happened; this says what should happen now. The tests that
 * carry weight are the routing ones, because getting those wrong is not a
 * crash — it is a tool people mute. Waking an agent for something only a person
 * can answer burns a turn and changes nothing. Pinging the person for something
 * an agent could just do is the notification noise that ends with the phone on
 * silent. So every finding says `by`, and that is asserted directly.
 *
 * The other half is the claim, and it is not hypothetical on this machine: there
 * are two Claude sessions here and they have already collided in one repo this
 * week. A lease with an EXPIRY rather than a flag, because the common ending for
 * an agent is not "releases the claim", it is "stops existing", and a lock
 * nothing can clear is worse than no lock at all.
 *
 * Pure. `now` is passed in, so these sit at an exact instant with no clock.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { compile } = await import('../src/shared/pipeline.ts')
const { beginRun, record } = await import('../src/shared/run.ts')
const { attention, claim, release, heldBy, wakeAt, needsHuman, summarise } = await import(
  '../src/shared/attention.ts'
)

const card = (id, text, x, y) => ({ id, type: 'text', text, x, y, width: 250, height: 60 })
const LINE = compile({
  nodes: [card('a', 'pick the topic', 0, 0), card('b', 'write it', 0, 200), card('c', 'post it', 0, 400)],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b' },
    { id: 'e2', fromNode: 'b', toNode: 'c' },
  ],
})

const T = 1_700_000_000_000
const STAMP = { mtime: T - 99_999, size: 512 }
const fresh = () => beginRun('Content/Post.canvas', STAMP, T)
const at = (plan, run, now = T, stamp = STAMP) => attention(plan, run, stamp, now)
const kinds = (items) => items.map((i) => i.kind)

// ------------------------------------------------------------------ routing

test('work an agent can do is routed to an agent', () => {
  const items = at(LINE, fresh())
  assert.deepEqual(kinds(items), ['work'])
  assert.equal(items[0].by, 'agent')
  assert.deepEqual(items[0].steps.map((s) => s.id), ['a'])
})

test('a question is routed to a person, and says an agent cannot clear it', () => {
  const r = record(fresh(), 'a', { state: 'awaiting-human', question: 'which topic?' }, T)
  const items = at(LINE, r)
  assert.deepEqual(kinds(items), ['question'])
  assert.equal(items[0].by, 'human')
  assert.equal(needsHuman(items), true)
})

test('work outranks a question, because finishing it may answer the question', () => {
  // Two independent chains: one has work, the other is parked on a person.
  const plan = compile({
    nodes: [card('x', 'do this', 0, 0), card('y', 'ask him', 500, 0)],
    edges: [],
  })
  const r = record(fresh(), 'y', { state: 'awaiting-human', question: 'which?' }, T)
  assert.deepEqual(kinds(at(plan, r)), ['work', 'question'])
})

test('a board with only agent work does not wake a person', () => {
  assert.equal(needsHuman(at(LINE, fresh())), false)
})

// ------------------------------------------------------------- the claim

test('a claimed board reports held and nothing else', () => {
  // Nothing else, deliberately. A caller that sees the ready work alongside the
  // claim will take it, which is the collision the claim exists to prevent.
  const r = claim(fresh(), 'desktop-session', T + 60_000, T)
  const items = at(LINE, r)
  assert.deepEqual(kinds(items), ['held'])
  assert.equal(items[0].by, 'nobody')
})

test('a second agent cannot take a board someone else holds', () => {
  const r = claim(fresh(), 'agent-one', T + 60_000, T)
  assert.equal(claim(r, 'agent-two', T + 60_000, T), null)
})

test('re-claiming your own board extends it rather than failing', () => {
  // An agent part way through long work renewing its lease is the normal case,
  // not a conflict.
  const r = claim(fresh(), 'agent-one', T + 60_000, T)
  const again = claim(r, 'agent-one', T + 120_000, T)
  assert.ok(again)
  assert.equal(again.claim.until, T + 120_000)
})

test('an expired claim frees the board without anyone clearing it', () => {
  // The whole reason it is an expiry and not a flag. An agent that dies does not
  // release anything, and a lock nothing can clear is worse than no lock.
  const r = claim(fresh(), 'agent-that-died', T + 60_000, T)
  const later = T + 60_001
  assert.equal(heldBy(r, later), null)
  assert.deepEqual(kinds(at(LINE, r, later)), ['work'])
  assert.ok(claim(r, 'somebody-else', later + 60_000, later))
})

test('releasing gives the board back, and releasing what you never held is safe', () => {
  const r = claim(fresh(), 'agent-one', T + 60_000, T)
  assert.equal(heldBy(release(r, 'agent-one', T), T), null)
  assert.equal(release(r, 'agent-two', T), r, 'someone else released a claim that was not theirs')
})

// -------------------------------------------------------------- staleness

test('a changed board reports stale and suppresses everything else', () => {
  // Every other answer is computed FROM the plan. If the plan no longer
  // describes the board on disk, reporting ready work invites acting on a step
  // that may not exist any more.
  const moved = { mtime: STAMP.mtime + 1, size: STAMP.size }
  const items = at(LINE, fresh(), T, moved)
  assert.deepEqual(kinds(items), ['stale'])
  assert.match(items[0].detail, /finished steps stay finished/)
})

// ---------------------------------------------------------------- schedule

test('a wake time in the past is reported only when there is nothing else', () => {
  // A wake time is a request that somebody look. If there is already work, the
  // looking has happened, and saying so again is the noise that gets tools muted.
  let r = wakeAt(fresh(), T - 1)
  assert.deepEqual(kinds(at(LINE, r)), ['work'], 'a due notice was added on top of real work')

  // Same board with its only entry step already running: nothing is ready, so
  // the schedule is now the useful thing to say.
  r = record(r, 'a', { state: 'running' }, T)
  assert.deepEqual(kinds(at(LINE, r)), ['due'])
})

test('a wake time in the future says nothing', () => {
  const r = record(wakeAt(fresh(), T + 60_000), 'a', { state: 'running' }, T)
  assert.deepEqual(kinds(at(LINE, r)), [])
})

test('a board that never set a wake time is not due', () => {
  const r = record(fresh(), 'a', { state: 'running' }, T)
  assert.deepEqual(kinds(at(LINE, r)), [])
})

// ------------------------------------------------------------- nothing to do

test('a finished board wants nothing', () => {
  let r = fresh()
  for (const id of ['a', 'b', 'c']) r = record(r, id, { state: 'done' }, T)
  assert.deepEqual(at(LINE, r), [])
})

test('a board mid-flight with every branch blocked wants nothing, not a placeholder', () => {
  const r = record(fresh(), 'a', { state: 'running' }, T)
  assert.deepEqual(at(LINE, r), [])
})

// ------------------------------------------------------------- the one line

test('the summary asks the actual question rather than announcing that one exists', () => {
  // "1 item needs attention" is what trains people to ignore notifications.
  const r = record(fresh(), 'a', { state: 'awaiting-human', question: 'dark or type-only?' }, T)
  assert.equal(summarise('Post', LINE, r, at(LINE, r)), 'Post: dark or type-only?')
})

test('the summary counts progress when there is work rather than a question', () => {
  const r = record(fresh(), 'a', { state: 'done' }, T)
  assert.equal(summarise('Post', LINE, r, at(LINE, r)), 'Post: 1 of 3 done, 1 ready')
})

test('the summary says something true when there is nothing to do', () => {
  let r = fresh()
  for (const id of ['a', 'b', 'c']) r = record(r, id, { state: 'done' }, T)
  assert.equal(summarise('Post', LINE, r, at(LINE, r)), 'Post: nothing to do')
})
