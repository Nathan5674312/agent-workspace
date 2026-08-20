/**
 * Edge arrowheads — `fromEnd` and `toEnd`.
 *
 * The bug this closes: JSON Canvas defaults `toEnd` to `'arrow'` and `fromEnd`
 * to `'none'`, and Obsidian omits both for an ordinary directed edge. This view
 * drew no arrowheads at all, so every edge anyone else authored lost its
 * direction on screen. Nothing was ever written wrongly — the fields round-trip
 * fine — but the board did not look like the user's board.
 *
 * So the assertions come in two halves. The FORMAT half checks the fields
 * survive AND that rendering a default never writes that default into the file:
 * materialising `toEnd: 'arrow'` onto an edge that omitted it would be this
 * app editing a user's canvas to record a decision the spec already makes.
 *
 * The WIRING half reads CanvasView.tsx as text, because it cannot be imported
 * here — JSX plus a stylesheet import, neither of which `node --test` resolves.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readFileSync(
  new URL('../src/renderer/panes/vault/CanvasView.tsx', import.meta.url),
  'utf8',
)

/** Three edges: the omitted-defaults case, an explicit reversal, both ends off. */
const ENDS = {
  nodes: [
    { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', type: 'text', text: 'b', x: 400, y: 0, width: 100, height: 100 },
  ],
  edges: [
    // What Obsidian writes for a normal directed edge: neither end stated.
    { id: 'default', fromNode: 'a', toNode: 'b' },
    // Reversed: head at the source, nothing at the target.
    { id: 'reversed', fromNode: 'a', toNode: 'b', fromEnd: 'arrow', toEnd: 'none' },
    // A plain undirected line.
    { id: 'bare', fromNode: 'a', toNode: 'b', fromEnd: 'none', toEnd: 'none' },
  ],
}

// ------------------------------------------------------------------- format

test('an edge that omits its ends does not gain them on save', () => {
  // The one that would corrupt a user's file. `toEnd` defaults to 'arrow', so
  // it is tempting to normalise it onto the object while rendering. That writes
  // a decision into someone's canvas that the spec was already making for them,
  // and it shows up as a spurious diff the next time Obsidian touches the file.
  const doc = parseCanvas(JSON.stringify(ENDS))
  const back = JSON.parse(serializeCanvas(doc))
  assert.deepEqual(back.edges[0], { id: 'default', fromNode: 'a', toNode: 'b' })
  assert.equal('toEnd' in back.edges[0], false, 'a default was materialised into the file')
  assert.equal('fromEnd' in back.edges[0], false, 'a default was materialised into the file')
})

test('explicit ends survive a round trip in both directions', () => {
  const doc = parseCanvas(JSON.stringify(ENDS))
  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.edges[1].fromEnd, 'arrow')
  assert.equal(back.edges[1].toEnd, 'none')
  assert.equal(back.edges[2].fromEnd, 'none')
  assert.equal(back.edges[2].toEnd, 'none')
})

// ------------------------------------------------------------------- wiring

test('an absent toEnd means an arrow, and an absent fromEnd means none', () => {
  // THE LOAD-BEARING ASSERTION. Reading an absent `toEnd` as "no arrow" is the
  // exact bug being fixed, and it is invisible in a screenshot of a board whose
  // edges all happen to state their ends.
  assert.match(VIEW, /drawsArrow\(edge\.toEnd, 'arrow'\)/, 'toEnd does not default to arrow')
  assert.match(VIEW, /drawsArrow\(edge\.fromEnd, 'none'\)/, 'fromEnd does not default to none')
  assert.match(
    VIEW,
    /end === undefined \? fallback : end\) === 'arrow'/,
    'the default is not applied only to an absent value',
  )
})

test('both ends are drawn from one marker, reversed at the start', () => {
  // `auto-start-reverse` is what lets a single definition serve marker-start
  // and marker-end. Without it the start head points the wrong way, which reads
  // as a bidirectional edge rather than a reversed one.
  assert.match(VIEW, /orient="auto-start-reverse"/, 'the start marker is not reversed')
  assert.match(VIEW, /markerStart=/, 'fromEnd is never drawn')
  assert.match(VIEW, /markerEnd=/, 'toEnd is never drawn')
  assert.match(VIEW, /id="canvas-arrow"/, 'no arrow marker is defined')
})
