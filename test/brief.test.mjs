/**
 * THE FLOOR: `ls` AND `cat`, NOTHING RUNNING, NO PROTOCOL.
 *
 * The design claim under `src/shared/brief.ts` is that a model which has never
 * seen this app, has no SDK, and cannot call a tool can still run a board,
 * because everything it needs is inside one readable file that explains itself.
 * These tests are that claim checked the only way it can be: by reading the file
 * the way such a reader would.
 *
 * The heaviest of them is the truncation test. A self-describing format is only
 * self-describing if the description arrives FIRST — a schema at the bottom of a
 * long file is a schema that a truncated read, a small context window or a
 * `head -c` never sees. So the first few hundred bytes are asserted on directly,
 * because that is what key order in this format is actually for.
 *
 * The other one that matters is staleness. A derived file that cannot tell you
 * it has gone out of date is worse than no file at all, since it is confidently
 * wrong rather than absent, and an agent acting on a plan for a board the person
 * has since redrawn is exactly the failure this design exists to prevent.
 *
 * Pure module. No filesystem, no DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { brief, briefPath, serializeBrief, staleAgainst, BRIEF_VERSION } = await import(
  '../src/shared/brief.ts'
)
const { compile } = await import('../src/shared/pipeline.ts')

const card = (id, text, x, y) => ({ id, type: 'text', text, x, y, width: 250, height: 60 })
const BOARD = {
  nodes: [
    card('a', 'pick the topic', 0, 0),
    card('b', 'write the hook', 0, 200),
    { id: 'c', type: 'file', file: 'System/Skills/reddit-voice/SKILL.md', x: 0, y: 400, width: 400, height: 400 },
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b' },
    { id: 'e2', fromNode: 'b', toNode: 'c', label: 'if it is any good' },
  ],
}

const STAMP = { mtime: 1_700_000_000_000, size: 812 }
const AT = 1_700_000_050_000
const make = (doc = BOARD, path = 'Pipelines/Morning.canvas') =>
  brief(compile(doc), path, STAMP, AT)

// ------------------------------------------------------- it explains itself

test('the explanation arrives before the data, so a truncated read still lands', () => {
  // A model with a small window, a `head -c`, a paste that got cut. The first
  // 400 bytes must already say what this is. This is the entire reason key order
  // is fixed in `brief()` rather than left to whatever the object literal did.
  const head = serializeBrief(make()).slice(0, 400)
  assert.match(head, /readThisFirst/)
  assert.match(head, /visual board/)
  assert.ok(
    !head.includes('"plan"'),
    'the plan reached the first 400 bytes before the explanation finished',
  )
})

test('a reader is told what the file is, what to do, and what not to touch', () => {
  const b = make()
  assert.ok(b.readThisFirst.length > 100, 'the description is too short to orient anyone')
  assert.ok(b.howToUseThis.length >= 5)
  assert.ok(b.doNot.length >= 3)
})

test('the loudest instruction is not to edit the board', () => {
  // The one irreversible mistake available from this file. It names the actual
  // path, because "the board" is ambiguous to a reader holding several.
  const b = make()
  assert.match(b.doNot[0], /Do not edit/)
  assert.match(b.doNot[0], /Pipelines\/Morning\.canvas/)
})

test('the guidance names the board a reader is actually holding', () => {
  const b = make(BOARD, 'Work/Q3 Launch.canvas')
  assert.match(b.readThisFirst, /Q3 Launch/)
  assert.match(b.readThisFirst, /Work\/Q3 Launch\.canvas/)
})

test('nothing in the guidance points at documentation the reader would have to find', () => {
  // A self-describing file that says "see the spec" is not self-describing. No
  // URLs, no filenames outside the vault, no version negotiation.
  const text = JSON.stringify([make().readThisFirst, ...make().howToUseThis, ...make().doNot])
  assert.ok(!/https?:\/\//.test(text), 'the guidance sends the reader to a URL')
  assert.ok(!/\.md\b(?!")/.test(text.replace(/SKILL\.md/g, '')), 'the guidance cites a doc file')
})

// ------------------------------------------------------------ it is derived

test('the brief says outright that it is derived and safe to delete', () => {
  const b = make()
  assert.equal(b.format.derived, true)
  assert.equal(b.format.safeToDelete, true)
  assert.equal(b.format.version, BRIEF_VERSION)
})

test('it carries the board it came from, so it can always be rebuilt', () => {
  const b = make()
  assert.equal(b.board.file, 'Pipelines/Morning.canvas')
  assert.equal(b.board.name, 'Morning')
  assert.deepEqual(b.board.stamp, STAMP)
})

// ----------------------------------------------------------- it knows it is stale

test('a changed mtime or a changed size both read as stale', () => {
  const b = make()
  assert.equal(staleAgainst(b, STAMP), false)
  assert.equal(staleAgainst(b, { ...STAMP, mtime: STAMP.mtime + 1 }), true)
  assert.equal(staleAgainst(b, { ...STAMP, size: STAMP.size + 1 }), true)
})

test('not knowing counts as stale', () => {
  // Recompiling needlessly costs milliseconds. Running a stale plan costs
  // whatever the plan does. The asymmetry decides the default.
  for (const bad of [null, undefined, {}, { board: {} }, { board: { stamp: {} } }]) {
    assert.equal(staleAgainst(bad, STAMP), true, `${JSON.stringify(bad)} was treated as fresh`)
  }
})

// ------------------------------------------------------------ it stays hidden

test('the brief is hidden beside its board, not visible next to the notes', () => {
  // Requirement: someone using this as an ordinary notes app never sees a trace
  // of the agent layer. Obsidian hides dotfiles; `Morning.agent.json` would not
  // be hidden and would fail that on its own.
  assert.equal(briefPath('Pipelines/Morning.canvas'), 'Pipelines/.Morning.canvas.brief.json')
  assert.equal(briefPath('Morning.canvas'), '.Morning.canvas.brief.json')
})

test('a brief path is always a dotfile, whatever the board is called', () => {
  for (const p of ['a.canvas', 'x/y/z.canvas', 'Some Long Name.canvas']) {
    const out = briefPath(p)
    assert.ok(out.split('/').pop().startsWith('.'), `${out} is not hidden`)
  }
})

// -------------------------------------------------------------- the payload

test('the steps a reader gets are the compiled ones, in order', () => {
  const b = make()
  assert.deepEqual(
    b.plan.steps.map((s) => s.id),
    ['a', 'b', 'c'],
  )
  assert.equal(b.runnable, true)
  assert.equal(b.whyNotRunnable, undefined)
})

test('an arrow label reaches the reader as the person wrote it', () => {
  const b = make()
  assert.equal(b.plan.steps.find((s) => s.id === 'c').conditions.b, 'if it is any good')
})

test('a board that is a map rather than a sequence explains itself in prose', () => {
  // Not an error code. The reader has to say something true to a person about
  // why their board did not run, and "cycle" is not that sentence.
  const loop = {
    nodes: [card('a', 'a', 0, 0), card('b', 'b', 0, 200)],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'b', toNode: 'a' },
    ],
  }
  const b = make(loop)
  assert.equal(b.runnable, false)
  assert.ok(b.whyNotRunnable.length > 0)
  assert.match(b.whyNotRunnable[0], /loop/)
})

test('an empty board says so instead of leaving the reason blank', () => {
  const b = make({ nodes: [], edges: [] })
  assert.equal(b.runnable, false)
  assert.deepEqual(b.whyNotRunnable, ['This board has no cards on it yet.'])
})

// ------------------------------------------------------------- it round-trips

test('a brief survives being written and read back as plain JSON', () => {
  // The floor: no parser of ours, no SDK. Whatever can read JSON can read this.
  const b = make()
  const back = JSON.parse(serializeBrief(b))
  assert.deepEqual(back, JSON.parse(JSON.stringify(b)))
})

test('the serialized form matches how every other file in a vault is written', () => {
  const text = serializeBrief(make())
  assert.ok(text.endsWith('\n'), 'no trailing newline')
  assert.match(text, /^\{\n {2}"readThisFirst"/, 'not two-space indented, or not explanation-first')
})
