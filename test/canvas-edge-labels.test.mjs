/**
 * Edge labels.
 *
 * The bug this closes: `label` round-tripped through the file untouched and was
 * never drawn, so an edge someone annotated in Obsidian arrived here as an
 * unexplained line. The annotation is usually the reason the edge exists.
 *
 * The assertions worth having are about what happens when the field is NOT a
 * clean string. It is optional and nothing validates it on the way through
 * `parseCanvas`, so the render path has to survive absent, empty, whitespace
 * and non-string values without printing any of them onto a user's board.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')

const BOARD = {
  nodes: [
    { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', type: 'text', text: 'b', x: 400, y: 0, width: 100, height: 100 },
  ],
  edges: [
    { id: 'labelled', fromNode: 'a', toNode: 'b', label: 'because' },
    { id: 'empty', fromNode: 'a', toNode: 'b', label: '' },
    { id: 'blank', fromNode: 'a', toNode: 'b', label: '   ' },
    { id: 'none', fromNode: 'a', toNode: 'b' },
  ],
}

// ------------------------------------------------------------------- format

test('labels survive a round trip, including the empty one', () => {
  // An empty label is not the same as no label: the user cleared it, and
  // dropping the key would be this app editing their file.
  const doc = parseCanvas(JSON.stringify(BOARD))
  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.edges[0].label, 'because')
  assert.equal(back.edges[1].label, '')
  assert.equal(back.edges[2].label, '   ')
  assert.equal('label' in back.edges[3], false, 'a label was invented for an edge without one')
})

test('a label is never written by rendering it', () => {
  // Rendering must not normalise. Trimming for display is fine; trimming the
  // stored value would silently rewrite the user's canvas.
  const doc = parseCanvas(JSON.stringify(BOARD))
  JSON.parse(serializeCanvas(doc))
  const again = JSON.parse(serializeCanvas(doc))
  assert.equal(again.edges[2].label, '   ', 'the stored label was trimmed')
})

// ------------------------------------------------------------------- wiring

test('only a non-empty string is drawn', () => {
  // THE LOAD-BEARING ASSERTION. A truthiness check would put the word
  // "undefined" on the board for a numeric or object label, and a bare
  // `edge.label &&` would render a whitespace-only halo with nothing in it.
  assert.match(
    VIEW,
    /typeof edge\.label === 'string' \? edge\.label\.trim\(\) : ''/,
    'the label is not narrowed to a trimmed string',
  )
  assert.match(VIEW, /\{label && \(/, 'an empty label still renders an element')
})

test('the label sits at the midpoint of the line that was actually drawn', () => {
  // The line is a CURVE now, so the midpoint of `from`/`to` is no longer a
  // point on it — a label placed there floats off the edge it belongs to. The
  // property this test is named for is unchanged; the formula it pinned is not.
  assert.match(VIEW, /x=\{curve\.mid\.x\}/, 'label x is not the drawn midpoint')
  assert.match(VIEW, /y=\{curve\.mid\.y\}/, 'label y is not the drawn midpoint')
  assert.match(VIEW, /3 \* c1\.x \+ 3 \* c2\.x/, 'the midpoint ignores the control points')
})

test('the curve midpoint formula really is the point at t=0.5', () => {
  // The shortcut (P0 + 3C1 + 3C2 + P3) / 8 is only correct for a CUBIC at
  // exactly t=0.5. Checked against de Casteljau rather than restating the
  // algebra, so a wrong constant in the view cannot be matched by a wrong
  // constant here. A regex over the source cannot see an arithmetic error.
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const deCasteljau = (p0, c1, c2, p3, t) => {
    const a = lerp(p0, c1, t)
    const b = lerp(c1, c2, t)
    const c = lerp(c2, p3, t)
    return lerp(lerp(a, b, t), lerp(b, c, t), t)
  }
  // Deliberately asymmetric, so a formula that only works for a symmetric
  // curve — the easy thing to get away with — fails here.
  const p0 = { x: 10, y: 20 }
  const c1 = { x: 90, y: 20 }
  const c2 = { x: 140, y: 300 }
  const p3 = { x: 400, y: 260 }
  const shortcut = {
    x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8,
    y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8,
  }
  const exact = deCasteljau(p0, c1, c2, p3, 0.5)
  assert.ok(Math.abs(shortcut.x - exact.x) < 1e-9, `x ${shortcut.x} != ${exact.x}`)
  assert.ok(Math.abs(shortcut.y - exact.y) < 1e-9, `y ${shortcut.y} != ${exact.y}`)
  // And it is NOT the straight midpoint, which is what the old formula used.
  const straight = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 }
  assert.ok(
    Math.hypot(straight.x - exact.x, straight.y - exact.y) > 1,
    'the fixture cannot tell the curve midpoint from the straight one',
  )
})

test('an edge leaves a card perpendicular to the side it attaches to', () => {
  // The whole reason for the curve. A control point pulled straight out along
  // the side's own normal is what makes the line read as plugged into the card
  // rather than laid across the board.
  assert.match(VIEW, /const outward = /, 'the side normal is not derived')
  assert.match(VIEW, /from\.x \+ da\.x \* pull/, 'the first control point ignores the side')
  assert.match(VIEW, /to\.x \+ db\.x \* pull/, 'the second control point ignores the side')
  // Clamped, or a distant pair gets a handle so long the curve swings outside
  // both cards.
  assert.match(VIEW, /Math\.min\(Math\.max\(/, 'the handle length is unclamped')
})

test('a curved edge is stroked, not filled', () => {
  // A <line> has no interior; a <path> does. Without fill="none" every edge is
  // a filled black region between its ends, which is the loudest possible
  // regression and the easiest to introduce.
  const path = VIEW.slice(VIEW.indexOf('d={curve.d}'), VIEW.indexOf('markerStart'))
  assert.ok(path.length > 0, 'the edge path no longer has the shape this test reads')
  assert.match(path, /fill="none"/, 'a curved edge is filled')
})
