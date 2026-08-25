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

const { parseCanvas, serializeCanvas, edgeControlPoints, edgeCurve } = await import(
  '../src/shared/canvas.ts'
)

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
})

test('the label rides the curve, and is not the straight midpoint', () => {
  // Checked against the real exported function rather than a regex, and against
  // de Casteljau on the real control points rather than restated algebra — so a
  // wrong constant in the source cannot be matched by a wrong constant here.
  const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const deCasteljau = (pts, t) => {
    let cur = pts
    while (cur.length > 1) {
      const next = []
      for (let i = 0; i < cur.length - 1; i++) next.push(lerp(cur[i], cur[i + 1], t))
      cur = next
    }
    return cur[0]
  }
  // Deliberately asymmetric — right side out, TOP side in. A facing left/right
  // pair is symmetric and its t=0.5 point genuinely is the straight midpoint,
  // so that arrangement cannot tell a correct formula from a lazy one.
  const a = { x: 0, y: 0, width: 100, height: 100 }
  const b = { x: 400, y: 300, width: 100, height: 100 }
  const from = { x: 100, y: 50 }
  const to = { x: 450, y: 300 }

  const P = edgeControlPoints(a, from, b, to)
  const exact = deCasteljau(P, 0.5)
  const { mid } = edgeCurve(a, from, b, to, 0)
  assert.ok(Math.abs(mid.x - exact.x) < 1e-9, `x ${mid.x} != ${exact.x}`)
  assert.ok(Math.abs(mid.y - exact.y) < 1e-9, `y ${mid.y} != ${exact.y}`)

  const straight = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  assert.ok(
    Math.hypot(straight.x - exact.x, straight.y - exact.y) > 1,
    'the fixture cannot tell the curve midpoint from the straight one',
  )
})

test('an edge leaves a card perpendicular to the side it attaches to', () => {
  // The whole reason for the curve. The lead-out runs along the side's own
  // normal, which is what makes the line read as plugged into the card rather
  // than laid across the board. Asserted on the geometry, not on the source.
  const a = { x: 0, y: 0, width: 100, height: 100 }
  const b = { x: 400, y: 300, width: 100, height: 100 }
  const from = { x: 100, y: 50 } // right side of a
  const to = { x: 450, y: 300 } // top side of b

  const P = edgeControlPoints(a, from, b, to)
  // Leaving `a` through its right side: straight out along +x, no y drift.
  assert.ok(P[1].x > P[0].x, 'the lead-out does not leave the right side outward')
  assert.equal(P[1].y, P[0].y, 'the lead-out drifts off the side normal')
  // Arriving at `b` through its top side: the run into it is straight along -y.
  assert.ok(P[4].y < P[5].y, 'the lead-in does not approach the top side from above')
  assert.equal(P[4].x, P[5].x, 'the lead-in drifts off the side normal')
})

test('a curved edge is stroked, not filled', () => {
  // A <line> has no interior; a <path> does. Without fill="none" every edge is
  // a filled black region between its ends, which is the loudest possible
  // regression and the easiest to introduce.
  const path = VIEW.slice(VIEW.indexOf('d={curve.d}'), VIEW.indexOf('markerStart'))
  assert.ok(path.length > 0, 'the edge path no longer has the shape this test reads')
  assert.match(path, /fill="none"/, 'a curved edge is filled')
})
