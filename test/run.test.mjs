/**
 * THE QUEUE: WHERE A PIPELINE HAS GOT TO.
 *
 * `pipeline.ts` says what the steps are. This says which have happened, and it
 * is the difference between a diagram and a program. The cases that matter are
 * the ones that only show up when a run outlives the sitting it started in — a
 * branch taken, the other branch stranded, a question asked of somebody who has
 * gone to school and answers six hours later.
 *
 * Two rules carry most of the weight and most of these tests:
 *
 *   a step waiting on a person blocks its dependents, NOT the whole run
 *   a step is ready when every dependency is settled and at least one is done
 *
 * The second is the one that is easy to get wrong in a way nothing notices for
 * weeks: require all dependencies DONE and every join after a branch deadlocks;
 * require only one and a join fires before its other input has arrived. Both
 * failures are tested here directly, because both look like a run that is simply
 * "still going".
 *
 * Pure module. No filesystem, no DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { compile } = await import('../src/shared/pipeline.ts')
const {
  beginRun,
  record,
  ready,
  unreachable,
  settleUnreachable,
  awaiting,
  answer,
  isComplete,
  progress,
  stateOf,
  runPath,
  serializeRun,
  RUN_VERSION,
} = await import('../src/shared/run.ts')

const card = (id, text, x, y) => ({ id, type: 'text', text, x, y, width: 250, height: 60 })
const arrow = (id, fromNode, toNode, label) => ({
  id,
  fromNode,
  toNode,
  ...(label === undefined ? {} : { label }),
})

/** a -> b -> c, the plain case. */
const LINE = compile({
  nodes: [card('a', 'a', 0, 0), card('b', 'b', 0, 200), card('c', 'c', 0, 400)],
  edges: [arrow('e1', 'a', 'b'), arrow('e2', 'b', 'c')],
})

/** a branches to b or c on a labelled edge, and both rejoin at d. */
const BRANCH = compile({
  nodes: [
    card('a', 'ask him', 0, 0),
    card('b', 'ship it', 0, 200),
    card('c', 'redo it', 300, 200),
    card('d', 'tell him', 150, 400),
  ],
  edges: [
    arrow('e1', 'a', 'b', 'if yes'),
    arrow('e2', 'a', 'c', 'if no'),
    arrow('e3', 'b', 'd'),
    arrow('e4', 'c', 'd'),
  ],
})

/** Two independent chains from nothing, sharing no steps. */
const PARALLEL = compile({
  nodes: [
    card('x1', 'x1', 0, 0),
    card('x2', 'x2', 0, 200),
    card('y1', 'y1', 500, 0),
    card('y2', 'y2', 500, 200),
  ],
  edges: [arrow('e1', 'x1', 'x2'), arrow('e2', 'y1', 'y2')],
})

const STAMP = { mtime: 1_700_000_000_000, size: 400 }
const run0 = (board = 'Pipelines/P.canvas') => beginRun(board, STAMP, 1)
const done = (r, id) => record(r, id, { state: 'done' }, 2)
const ids = (steps) => steps.map((s) => s.id)

// -------------------------------------------------------------- the basics

test('a fresh run starts at the entry step and nowhere else', () => {
  assert.deepEqual(ids(ready(LINE, run0())), ['a'])
})

test('an unrecorded step is pending, not missing', () => {
  assert.equal(stateOf(run0(), 'a'), 'pending')
})

test('finishing a step opens exactly the one behind it', () => {
  const r = done(run0(), 'a')
  assert.deepEqual(ids(ready(LINE, r)), ['b'])
})

test('recording merges, so an output survives being marked done', () => {
  let r = record(run0(), 'a', { output: 'the topic is birds' }, 2)
  r = record(r, 'a', { state: 'done' }, 3)
  assert.equal(r.steps.a.output, 'the topic is birds')
  assert.equal(r.steps.a.state, 'done')
})

test('a run is not mutated by recording against it', () => {
  const before = run0()
  const after = done(before, 'a')
  assert.equal(stateOf(before, 'a'), 'pending', 'the original run was mutated')
  assert.equal(stateOf(after, 'a'), 'done')
})

// ------------------------------------------------------ waiting on a person

test('a step waiting on a person does not block an unrelated branch', () => {
  // The whole reason this file exists. The human is at school; the other chain
  // must not sit idle until they get home.
  const r = record(run0(), 'x1', { state: 'awaiting-human', question: 'which one?' }, 2)
  assert.deepEqual(ids(ready(PARALLEL, r)), ['y1'])
  assert.equal(progress(PARALLEL, r).waiting, 1)
})

test('a step waiting on a person does block what comes after it', () => {
  const r = record(run0(), 'x1', { state: 'awaiting-human', question: 'which one?' }, 2)
  assert.ok(!ids(ready(PARALLEL, r)).includes('x2'))
})

test('answering puts the step back in the queue and keeps the question', () => {
  let r = record(run0(), 'a', { state: 'awaiting-human', question: 'ship it?' }, 2)
  assert.deepEqual(ids(awaiting(LINE, r)), ['a'])
  r = answer(r, 'a', 'yes go on', 3)
  assert.equal(r.steps.a.answer, 'yes go on')
  assert.equal(r.steps.a.question, 'ship it?', 'the question was lost with the answer')
  assert.deepEqual(ids(ready(LINE, r)), ['a'])
})

test('an answer to a step that was not asked anything changes nothing', () => {
  // Far likelier to be a mixed-up step id than something the caller meant, and
  // applying it would overwrite real state.
  const r = done(run0(), 'a')
  assert.equal(answer(r, 'a', 'sure', 3), r)
})

// ----------------------------------------------------------------- branching

test('a join waits for the branch that was actually taken, and does not deadlock', () => {
  // Require every dependency DONE and this hangs forever, because only one of
  // b and c can happen. That failure looks exactly like a run still in progress.
  let r = done(run0(), 'a')
  r = record(r, 'b', { state: 'done' }, 3)
  r = record(r, 'c', { state: 'skipped' }, 3)
  assert.deepEqual(ids(ready(BRANCH, r)), ['d'])
})

test('a join does not fire before its other input has arrived', () => {
  // The opposite error: requiring only ONE done dependency runs the join early.
  let r = done(run0(), 'a')
  r = record(r, 'b', { state: 'done' }, 3)
  // c is still pending — not skipped, not done.
  assert.ok(!ids(ready(BRANCH, r)).includes('d'), 'the join fired with an input still pending')
})

test('a step whose every path was skipped is unreachable, and is not ready', () => {
  let r = done(run0(), 'a')
  r = record(r, 'b', { state: 'skipped' }, 3)
  r = record(r, 'c', { state: 'skipped' }, 3)
  assert.deepEqual(ids(ready(BRANCH, r)), [])
  assert.deepEqual(ids(unreachable(BRANCH, r)), ['d'])
})

test('asking what is unreachable does not change the run', () => {
  // Reads must not write. An agent asking "what can I do" that silently settled
  // steps would make the question unsafe to ask.
  let r = done(run0(), 'a')
  r = record(r, 'b', { state: 'skipped' }, 3)
  r = record(r, 'c', { state: 'skipped' }, 3)
  const snapshot = JSON.stringify(r)
  unreachable(BRANCH, r)
  assert.equal(JSON.stringify(r), snapshot)
})

test('skipping propagates down a chain until it settles', () => {
  // Skip a, and b and c and d all become impossible. One pass would leave a
  // tail of steps that can never run, and the run would sit at 90% forever.
  let r = record(run0(), 'a', { state: 'skipped' }, 2)
  r = settleUnreachable(BRANCH, r, 3)
  for (const id of ['b', 'c', 'd']) assert.equal(stateOf(r, id), 'skipped', `${id} was stranded`)
  assert.equal(isComplete(BRANCH, r), true)
})

test('settling is a no-op when nothing is stranded', () => {
  const r = done(run0(), 'a')
  assert.equal(JSON.stringify(settleUnreachable(BRANCH, r, 3)), JSON.stringify(r))
})

// ------------------------------------------------------------- completeness

test('a run is complete only when nothing can still move', () => {
  let r = run0()
  assert.equal(isComplete(LINE, r), false)
  r = done(done(r, 'a'), 'b')
  assert.equal(isComplete(LINE, r), false)
  r = done(r, 'c')
  assert.equal(isComplete(LINE, r), true)
})

test('complete does not mean it worked', () => {
  // Deliberately separate from progress(). If "are we done" came to mean "did
  // it work", a run of nothing but failures would report success.
  let r = record(run0(), 'a', { state: 'failed', error: 'the API was down' }, 2)
  r = settleUnreachable(LINE, r, 3)
  assert.equal(isComplete(LINE, r), true)
  const p = progress(LINE, r)
  assert.equal(p.failed, 1)
  assert.equal(p.done, 0)
  assert.equal(p.left, 0)
})

test('a failed step strands what depended on it rather than retrying forever', () => {
  const r = settleUnreachable(LINE, record(run0(), 'a', { state: 'failed' }, 2), 3)
  assert.equal(stateOf(r, 'b'), 'skipped')
})

test('progress counts what a person would want reported', () => {
  let r = done(run0(), 'a')
  r = record(r, 'b', { state: 'awaiting-human', question: 'ok?' }, 3)
  assert.deepEqual(progress(LINE, r), {
    total: 3,
    done: 1,
    skipped: 0,
    failed: 0,
    waiting: 1,
    left: 2,
  })
})

// -------------------------------------------------------------- on-disk shape

test('the run file is hidden beside its board, like the brief', () => {
  assert.equal(runPath('Pipelines/Morning.canvas'), 'Pipelines/.Morning.canvas.run.json')
  assert.equal(runPath('Morning.canvas'), '.Morning.canvas.run.json')
})

test('a run explains itself and carries the board it belongs to', () => {
  const r = run0('Work/Launch.canvas')
  assert.match(r.readThisFirst, /how far through a board/)
  assert.equal(r.board, 'Work/Launch.canvas')
  assert.deepEqual(r.boardStamp, STAMP)
  assert.equal(r.version, RUN_VERSION)
})

test('a run survives being written and read back as plain JSON', () => {
  const r = record(run0(), 'a', { state: 'done', output: 'birds' }, 2)
  assert.deepEqual(JSON.parse(serializeRun(r)), JSON.parse(JSON.stringify(r)))
  assert.ok(serializeRun(r).endsWith('\n'))
})
