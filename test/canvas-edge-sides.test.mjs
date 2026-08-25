/**
 * Explicit edge sides — `fromSide` and `toSide`.
 *
 * The bug this closes: `edgeAnchor()` always derived the nearest pair of sides
 * from the geometry, so an edge the user routed by hand in Obsidian was drawn
 * somewhere else here. Both kinds live in the same file — Obsidian omits the
 * sides for edges it routed itself and writes them for edges you dragged — so
 * the choice has to be made per END, not per edge.
 *
 * The interesting assertion is the one that proves the override is OBSERVABLE.
 * A test that set `fromSide: 'right'` on two side-by-side cards would pass
 * whether or not the code read the field at all, because that is what the
 * geometry derives anyway. So the fixture below is deliberately arranged so the
 * derived answer and the stated answer disagree, and `edgeAnchor` — the real
 * exported function — is called to prove they do.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas, edgeAnchor, sidePoint } = await import(
  '../src/shared/canvas.ts'
)

const VIEW = readSource('CanvasView.tsx')

/** Two cards SIDE BY SIDE, so the derived route is horizontal. */
const A = { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100 }
const B = { id: 'b', type: 'text', text: 'b', x: 400, y: 0, width: 100, height: 100 }

const BOARD = {
  nodes: [A, B],
  edges: [
    // Stated sides that DISAGREE with the geometry: bottom -> top on a pair
    // that sits left-to-right.
    { id: 'stated', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top' },
    // Half stated. Deriving both because one was missing would move an anchor
    // the user placed.
    { id: 'half', fromNode: 'a', fromSide: 'top', toNode: 'b' },
    // Neither stated: this one must still derive.
    { id: 'derived', fromNode: 'a', toNode: 'b' },
  ],
}

// ------------------------------------------------------------------- format

test('stated sides survive a round trip, and absent ones are not invented', () => {
  const doc = parseCanvas(JSON.stringify(BOARD))
  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.edges[0].fromSide, 'bottom')
  assert.equal(back.edges[0].toSide, 'top')
  assert.equal(back.edges[1].fromSide, 'top')
  assert.equal('toSide' in back.edges[1], false, 'a side was materialised into the file')
  assert.equal('fromSide' in back.edges[2], false, 'a side was materialised into the file')
})

// -------------------------------------------------------------- observability

test('the fixture actually distinguishes stated from derived', () => {
  // Without this the two wiring tests below could pass against code that
  // ignores the file entirely. edgeAnchor is the REAL function the view falls
  // back to, so this pins that "bottom/top" is genuinely not what it returns.
  const { from, to } = edgeAnchor(A, B)
  assert.deepEqual(from, { x: 100, y: 50 }, 'derived source is not the right edge')
  assert.deepEqual(to, { x: 400, y: 50 }, 'derived target is not the left edge')

  // The stated route for the same pair, per the spec's side midpoints.
  const statedFrom = { x: A.x + A.width / 2, y: A.y + A.height } // bottom
  const statedTo = { x: B.x + B.width / 2, y: B.y } // top
  assert.notDeepEqual(from, statedFrom, 'the fixture cannot tell the two apart')
  assert.notDeepEqual(to, statedTo, 'the fixture cannot tell the two apart')
})

// ------------------------------------------------------------------- wiring

test('a stated side wins over the derived one, per end', () => {
  // THE LOAD-BEARING ASSERTION. Each end resolves independently against its own
  // field; passing `derived` wholesale would re-derive an anchor the user set.
  assert.match(
    VIEW,
    /sidePoint\(a, edge\.fromSide, derived\.from\)/,
    'the source end ignores fromSide',
  )
  assert.match(VIEW, /sidePoint\(b, edge\.toSide, derived\.to\)/, 'the target end ignores toSide')
})

test('an absent or unusable side falls back instead of throwing', () => {
  // A board that is slightly wrong should still draw. Obsidian leaves odd
  // values behind, and a canvas that renders nothing is worse than one that
  // renders an edge in the derived place.
  //
  // Called for real rather than grepped: `sidePoint` moved to shared/canvas.ts
  // when the edge geometry did, and a regex over the view could no longer see
  // it — nor could it ever have seen whether the fallback actually worked.
  const derived = { x: -1, y: -1 }
  const node = { x: 0, y: 0, width: 100, height: 100 }

  // The four the spec names resolve to their own side midpoints.
  assert.deepEqual(sidePoint(node, 'top', derived), { x: 50, y: 0 })
  assert.deepEqual(sidePoint(node, 'right', derived), { x: 100, y: 50 })
  assert.deepEqual(sidePoint(node, 'bottom', derived), { x: 50, y: 100 })
  assert.deepEqual(sidePoint(node, 'left', derived), { x: 0, y: 50 })

  // Everything else falls back to the geometry, and none of it throws.
  for (const junk of [undefined, null, '', 'sideways', 'TOP', 3, {}, [], true]) {
    assert.deepEqual(sidePoint(node, junk, derived), derived, `${JSON.stringify(junk)} did not fall back`)
  }
})
