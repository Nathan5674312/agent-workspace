/**
 * A BOARD IS ALREADY A PROGRAM.
 *
 * The design claim under `src/shared/pipeline.ts` is that nothing has to be
 * added to a canvas to make it runnable: an arrow already means order, a group
 * already means phase, a file card already means material. If that claim is
 * true then a board drawn by someone with no idea an agent would ever read it
 * compiles into a correct plan, and these tests are mostly that one sentence,
 * checked from several angles.
 *
 * The other half is the safety property, and it is the more important half.
 * `compile()` must not write to the `.canvas` document at all. That file is
 * shared with Obsidian, `docs/canvas-backlog.md` records that unknown-key
 * preservation on Obsidian's side is UNMEASURED, and the failure mode of
 * getting this wrong is a user's board quietly losing its groups and colours.
 * So the document is deep-frozen before every compile in this file: a mutation
 * throws in strict mode rather than showing up as a corrupted file weeks later.
 *
 * Pure module. No DOM, no filesystem.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { compile, PLAN_VERSION } = await import('../src/shared/pipeline.ts')
const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

/** Recursively freeze, so any write inside compile() throws instead of landing. */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

const card = (id, text, x, y) => ({ id, type: 'text', text, x, y, width: 250, height: 60 })
const box = (id, label, x, y, width, height) => ({ id, type: 'group', label, x, y, width, height })
const arrow = (id, fromNode, toNode, label) => ({
  id,
  fromNode,
  toNode,
  ...(label === undefined ? {} : { label }),
})

/**
 * The example board, and it is deliberately mundane: someone sketching how they
 * get a post out. Nobody drawing this is thinking about agents.
 */
const FLOWCHART = deepFreeze({
  nodes: [
    card('a', 'pick the topic', 0, 0),
    card('b', 'write the hook', 0, 200),
    card('c', 'record it', 0, 400),
    card('d', 'post it', 0, 600),
  ],
  edges: [arrow('e1', 'a', 'b'), arrow('e2', 'b', 'c'), arrow('e3', 'c', 'd')],
})

// ------------------------------------------------------------ the core claim

test('a plain flowchart compiles into its own reading order', () => {
  const plan = compile(FLOWCHART)
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual(plan.entry, ['a'])
  assert.equal(plan.runnable, true)
  assert.equal(plan.problems.length, 0)
})

test('the instruction is the card text, verbatim and unparsed', () => {
  // No syntax. Whatever the human typed is what the agent is handed, including
  // punctuation that a directive parser would have eaten.
  const odd = '@run: do the thing #now {maybe}'
  const plan = compile(deepFreeze({ nodes: [card('a', odd, 0, 0)], edges: [] }))
  assert.equal(plan.steps[0].text, odd)
})

test('a step knows what comes before and after it', () => {
  const plan = compile(FLOWCHART)
  const b = plan.steps.find((s) => s.id === 'b')
  assert.deepEqual(b.after, ['a'])
  assert.deepEqual(b.before, ['c'])
})

test('a file card carries the path, which is how you point at a skill', () => {
  const plan = compile(
    deepFreeze({
      nodes: [{ id: 'a', type: 'file', file: 'System/Skills/reddit-voice/SKILL.md', x: 0, y: 0, width: 400, height: 400 }],
      edges: [],
    }),
  )
  assert.equal(plan.steps[0].file, 'System/Skills/reddit-voice/SKILL.md')
})

// ------------------------------------------------------- the safety property

test('compile does not write one byte to the canvas document', () => {
  // Frozen input plus a byte-for-byte comparison of the serialised form. The
  // freeze catches a mutation at the moment it happens; the comparison catches
  // one that a non-strict code path swallowed.
  const authored = {
    nodes: [
      { id: 'a', type: 'file', file: 'Home.md', x: 0, y: 0, width: 400, height: 400, color: '4' },
      box('g', 'Cluster', -20, -20, 900, 500),
    ],
    edges: [arrow('e1', 'a', 'a', 'because')],
    metadataFromSomeFutureVersion: { version: 99 },
  }
  const before = serializeCanvas(parseCanvas(JSON.stringify(authored)))
  const doc = parseCanvas(before)
  deepFreeze(doc)
  compile(doc)
  assert.equal(serializeCanvas(doc), before)
})

// --------------------------------------------------------- groups are phases

test('a group label becomes the phase of the cards inside its box', () => {
  const plan = compile(
    deepFreeze({
      nodes: [
        box('g', 'Research', -50, -50, 400, 400),
        card('a', 'read the thread', 0, 0),
        card('b', 'somewhere else entirely', 5000, 5000),
      ],
      edges: [],
    }),
  )
  assert.equal(plan.steps.find((s) => s.id === 'a').phase, 'Research')
  assert.equal(plan.steps.find((s) => s.id === 'b').phase, undefined)
  assert.deepEqual(plan.phases, ['Research'])
})

test('nested groups give a card the innermost phase', () => {
  // "Draft" inside "Content" means the card is in the draft phase, not both.
  const plan = compile(
    deepFreeze({
      nodes: [
        box('outer', 'Content', -100, -100, 1000, 1000),
        box('inner', 'Draft', -50, -50, 400, 400),
        card('a', 'write it', 0, 0),
      ],
      edges: [],
    }),
  )
  assert.equal(plan.steps.find((s) => s.id === 'a').phase, 'Draft')
})

test('a group box is not itself a step', () => {
  const plan = compile(
    deepFreeze({ nodes: [box('g', 'Research', 0, 0, 400, 400), card('a', 'go', 10, 10)], edges: [] }),
  )
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['a'],
  )
  assert.equal(plan.excluded.length, 1)
  assert.equal(plan.excluded[0].id, 'g')
})

test('an edge between two groups is not reported as a broken edge', () => {
  // Drawing an arrow from one phase to another is a normal thing to do and the
  // board is not wrong. It is simply not a dependency between two units of work.
  const plan = compile(
    deepFreeze({
      nodes: [box('g1', 'One', 0, 0, 100, 100), box('g2', 'Two', 500, 0, 100, 100)],
      edges: [arrow('e1', 'g1', 'g2')],
    }),
  )
  assert.deepEqual(plan.problems, [])
})

// ------------------------------------------------------ boards that are maps

test('a cycle is reported rather than thrown, and the board is not runnable', () => {
  // Someone drew a loop. That is a legitimate mind-map and a terrible pipeline.
  // Throwing would make "this is not a sequence" look identical to a crash.
  const plan = compile(
    deepFreeze({
      nodes: [card('a', 'a', 0, 0), card('b', 'b', 0, 200), card('c', 'c', 0, 400)],
      edges: [arrow('e1', 'a', 'b'), arrow('e2', 'b', 'c'), arrow('e3', 'c', 'a')],
    }),
  )
  assert.equal(plan.runnable, false)
  const cycle = plan.problems.find((p) => p.kind === 'cycle')
  assert.ok(cycle, 'the loop was not reported')
  assert.deepEqual(cycle.nodes.sort(), ['a', 'b', 'c'])
})

test('a board with no cards at all is not runnable and is not an error', () => {
  const plan = compile(deepFreeze({ nodes: [], edges: [] }))
  assert.equal(plan.runnable, false)
  assert.deepEqual(plan.steps, [])
  assert.deepEqual(plan.problems, [])
})

test('an edge to a card that was deleted names the card, and the rest still compiles', () => {
  const plan = compile(
    deepFreeze({ nodes: [card('a', 'a', 0, 0)], edges: [arrow('e1', 'a', 'gone')] }),
  )
  const dangling = plan.problems.find((p) => p.kind === 'dangling-edge')
  assert.ok(dangling)
  assert.equal(dangling.missing, 'gone')
  assert.equal(plan.runnable, true, 'one bad edge should not sink a usable board')
})

// ----------------------------------------------------------------- ordering

test('the order is deterministic, because two agents must agree on what is next', () => {
  // Two independent branches from one root. Which runs "first" is arbitrary in
  // graph terms, so it is settled by the node array order, which every reader
  // of the file sees identically. Compiled twice to pin that it is not chance.
  const board = deepFreeze({
    nodes: [card('root', 'r', 0, 0), card('x', 'x', 300, 0), card('y', 'y', 600, 0)],
    edges: [arrow('e1', 'root', 'x'), arrow('e2', 'root', 'y')],
  })
  const first = compile(board).steps.map((s) => s.id)
  const second = compile(board).steps.map((s) => s.id)
  assert.deepEqual(first, second)
  assert.deepEqual(first, ['root', 'x', 'y'])
})

test('array order, not edge order, breaks the tie between two ready cards', () => {
  // Same graph as above with the two branches swapped in the nodes array. If the
  // tiebreak were edge order or insertion order this would not change.
  const plan = compile(
    deepFreeze({
      nodes: [card('root', 'r', 0, 0), card('y', 'y', 600, 0), card('x', 'x', 300, 0)],
      edges: [arrow('e1', 'root', 'x'), arrow('e2', 'root', 'y')],
    }),
  )
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['root', 'y', 'x'],
  )
})

test('index matches position, so a step can say where it is without the array', () => {
  const plan = compile(FLOWCHART)
  for (const [i, s] of plan.steps.entries()) assert.equal(s.index, i)
})

// --------------------------------------------------------------- conditions

test('an edge label is carried through as a condition, uninterpreted', () => {
  // "if yes" is what a flowchart already means. It is handed over as written
  // rather than parsed into a boolean, because parsing it would be a syntax.
  const plan = compile(
    deepFreeze({
      nodes: [card('a', 'ask him', 0, 0), card('b', 'ship it', 0, 200), card('c', 'redo it', 300, 200)],
      edges: [arrow('e1', 'a', 'b', 'if yes'), arrow('e2', 'a', 'c', 'if no')],
    }),
  )
  assert.equal(plan.steps.find((s) => s.id === 'b').conditions.a, 'if yes')
  assert.equal(plan.steps.find((s) => s.id === 'c').conditions.a, 'if no')
})

test('a plan states its schema version', () => {
  assert.equal(compile(FLOWCHART).version, PLAN_VERSION)
})
