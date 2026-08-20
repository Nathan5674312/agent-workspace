/**
 * Coordinates written to the file must be integers.
 *
 * JSON Canvas 1.0 declares node `x`, `y`, `width` and `height` as INTEGER.
 * `addCard` rounded; the drag — by far the commonest way a coordinate is
 * produced — did not. `toWorld` divides by the view scale `k`, and `k` is
 * fractional after any wheel notch and after `fit()` frames a board on open,
 * so `p.x - dx` is a float and it was assigned straight onto the node object
 * that gets stringified.
 *
 * Two costs. The file carries a value whose declared type it violates, with
 * seventeen significant digits of noise in something the user diffs in git.
 * And Obsidian rewrites it to an integer the next time it touches the board,
 * so the two apps take turns rewriting the same card forever.
 *
 * THE FIXTURE IS DELIBERATELY FRACTIONAL. An integer-only fixture cannot see a
 * `Math.round` at all — the rounding is invisible and the assertion passes with
 * it deleted. So the first test proves the arithmetic actually produces a float
 * before anything asserts that the view removes it, the same shape as
 * canvas-edge-sides proving derived and stated disagree.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')

/** A realistic post-zoom view transform. `k` is what `fit()` leaves behind. */
const K = 1.37
const TX = 11
const TY = 7
/** The view's own toWorld, which is where the fraction enters. */
const toWorld = (cx, cy) => ({ x: (cx - TX) / K, y: (cy - TY) / K })

// -------------------------------------------------------------- observability

test('the drag arithmetic really does produce a fractional coordinate', () => {
  // Without this the assertions below could pass against code with no rounding
  // in it at all, because every input happened to be a whole number.
  const p = toWorld(300, 200)
  const rawX = p.x - 3
  const rawY = p.y - 3
  assert.ok(!Number.isInteger(rawX), 'the fixture cannot see rounding on x')
  assert.ok(!Number.isInteger(rawY), 'the fixture cannot see rounding on y')
  assert.ok(Number.isInteger(Math.round(rawX)) && Number.isInteger(Math.round(rawY)))
})

test('a fractional coordinate survives into the serialized file', () => {
  // What the bug actually put on disk, so the cost is stated rather than
  // asserted about in prose.
  const doc = parseCanvas(
    JSON.stringify({
      nodes: [{ id: 'a', type: 'text', text: 't', x: 0, y: 0, width: 250, height: 60 }],
      edges: [],
    }),
  )
  const p = toWorld(300, 200)
  doc.nodes[0].x = p.x - 3
  const written = JSON.parse(serializeCanvas(doc))
  assert.ok(!Number.isInteger(written.nodes[0].x), 'the fixture did not reach the file')
  assert.ok(String(written.nodes[0].x).length > 6, 'the noise this produces is not represented')
})

// ------------------------------------------------------------------- wiring

test('the drag rounds both coordinates before writing them to the node', () => {
  // THE LOAD-BEARING ASSERTION.
  const move = VIEW.slice(VIEW.indexOf('const onMove ='), VIEW.indexOf('const draggedLast'))
  assert.ok(move.length > 0, 'onMove no longer has the shape this test reads')
  assert.match(move, /node\.x = Math\.round\(/, 'a drag writes a fractional x')
  assert.match(move, /node\.y = Math\.round\(/, 'a drag writes a fractional y')
})

test('a duplicate is placed on integers too', () => {
  // The offset is added to the source's coordinate, so a duplicate of a card
  // that predates this fix would otherwise carry the old fraction forward.
  const dup = VIEW.slice(VIEW.indexOf('const copy: CanvasNode'), VIEW.indexOf('doc.nodes.push(copy)'))
  assert.match(dup, /x: Math\.round\(node\.x \+ DUPLICATE_OFFSET\)/, 'a duplicate can land on a float')
  assert.match(dup, /y: Math\.round\(node\.y \+ DUPLICATE_OFFSET\)/, 'a duplicate can land on a float')
})

// ------------------------------------------------------- preservation rule

test('rounding is applied only to what the view moves, never to the rest', () => {
  // A board authored elsewhere with fractional coordinates must not be
  // silently rewritten just by being opened. Only the card the user actually
  // drags changes, and it changes because they moved it.
  const ODD = {
    nodes: [
      { id: 'a', type: 'text', text: 'a', x: 10.5, y: 20.25, width: 100, height: 100 },
      { id: 'b', type: 'text', text: 'b', x: 300.75, y: 0, width: 100, height: 100, color: '2' },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'keep' }],
    extra: { v: 1 },
  }
  const text = `${JSON.stringify(ODD, null, 2)}\n`
  assert.equal(serializeCanvas(parseCanvas(text)), text, 'merely opening a board rewrote it')
})
