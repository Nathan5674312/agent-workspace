/**
 * Shift-to-align, and Shift-to-keep-the-shape.
 *
 * `alignLines` and `snapOffset` are the arithmetic behind holding Shift while
 * dragging a page. They used to live in CanvasView because nothing else needed
 * them, and this file re-declared them from the same constants — a regex over
 * the source cannot tell whether the maths is right, and getting a snap subtly
 * wrong is invisible until a board will not line up.
 *
 * They moved to `shared/guides.ts` when the guide lines landed, because drawing
 * a guide means knowing WHICH line was matched and not merely by how much. So
 * these tests import the real thing now, and the re-declaration is gone. The
 * constants stay pinned to the view by the two regex assertions below: the view
 * still owns GRID (it publishes it to CSS so the dots and the snap cannot
 * disagree) and SNAP_RANGE, and passes both in.
 *
 * The wiring that calls them is pinned in canvas-selection.test.mjs, and the
 * guides themselves in canvas-guides.test.mjs.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const VIEW = readSource('CanvasView.tsx')

const { alignLines, snapOffset: rawSnapOffset, gridLines: rawGridLines } = await import(
  '../src/shared/guides.ts'
)

/** Kept in step with the view by the assertion below, not by hand. */
const SNAP_RANGE = 120
const snapOffset = (start, size, lines) => rawSnapOffset(start, size, lines, SNAP_RANGE)

test('the range these tests assume is the range the view uses', () => {
  // Without this the whole file can pass against a view that snaps at a
  // completely different distance.
  assert.match(VIEW, new RegExp(`const SNAP_RANGE = ${SNAP_RANGE}\\b`), 'SNAP_RANGE drifted')
})

test('a page offers its two edges and its centre to align against', () => {
  assert.deepEqual(alignLines(100, 60), [100, 130, 160])
})

test('nothing in range means no movement at all', () => {
  // The page must land exactly where the pointer put it. A snap that always
  // pulled somewhere would make Shift unusable for free placement.
  assert.equal(snapOffset(0, 100, [9999]), 0)
  assert.equal(snapOffset(0, 100, []), 0)
})

test('a near miss is pulled flush', () => {
  // Left edge at 105, a neighbour's left edge at 100: close the 5.
  assert.equal(snapOffset(105, 50, [100]), -5)
  assert.equal(snapOffset(95, 50, [100]), 5)
})

test('the closest line wins when several are in range', () => {
  // 105 is 5 from 100 and 15 from 120. The nearer one takes it.
  assert.equal(snapOffset(105, 10, [100, 120]), -5)
})

test('an edge can meet a centre, not just another edge', () => {
  // A 100-wide page whose CENTRE lands on 200: start must go to 150.
  assert.equal(snapOffset(160, 100, [200]), -10)
})

test('a right edge can meet a left edge, which is how pages sit flush', () => {
  // Page starts at 95 and is 100 wide, so its right edge is 195. A neighbour's
  // left edge at 200 pulls it 5 right, leaving the two touching exactly.
  assert.equal(snapOffset(95, 100, [200]), 5)
})

test('exactly at the range boundary does not snap', () => {
  // Strictly-less-than, so the boundary is a clean no-op rather than a value
  // that flickers between snapped and not as the pointer jitters.
  //
  // Measured from the RIGHT EDGE, which is this page's nearest line to the
  // target: a 10-wide page at 0 offers 0, 5 and 10, so a line at 130 is exactly
  // SNAP_RANGE from the closest of them. Measuring from `start` instead would
  // have made the fixture wrong rather than the code — the first draft of this
  // test did exactly that and failed against correct behaviour.
  assert.equal(snapOffset(0, 10, [10 + SNAP_RANGE]), 0)
  assert.notEqual(snapOffset(0, 10, [10 + SNAP_RANGE - 1]), 0)
})

test('the resize ratio comes from the house page, not the page being dragged', () => {
  // So Shift RESTORES the page proportion on a page already dragged out of
  // shape, rather than preserving the mistake.
  const resize = VIEW.slice(VIEW.indexOf('if (resize.current) {'), VIEW.indexOf('if (drag.current) {'))
  assert.ok(resize.length > 0, 'the resize branch no longer has the shape this test reads')
  assert.match(resize, /PAGE_SIZE\.width \/ PAGE_SIZE\.height/, 'the ratio is not the house ratio')
  // Driven by whichever dimension moved further, so the gesture follows the drag.
  assert.match(resize, /Math\.abs\(w - r\.w0\) >= Math\.abs\(h - r\.h0\)/, 'the ratio ignores the drag direction')
  // And then lands on a neighbour's exact size.
  assert.match(resize, /w = other\.width/, 'Shift does not adopt a neighbour size')
  assert.match(resize, /h = other\.height/, 'Shift does not adopt a neighbour size')
})

// ------------------------------------------------------------------- grid

const GRID = 24
const gridLines = (start, size) => rawGridLines(start, size, GRID)

test('the grid spacing these tests assume is the one the view uses', () => {
  assert.match(VIEW, new RegExp(`const GRID = ${GRID}\\b`), 'GRID drifted')
})

test('the dots and the snap read the same constant', () => {
  // They were two numbers, one in the stylesheet and one implied by "align to
  // other pages only". That is exactly how a page ends up aligned to a
  // neighbour and still sitting between the dots.
  assert.match(VIEW, /setProperty\('--canvas-grid', String\(GRID\)\)/, 'the grid is not published to CSS')
  const css = readSource('canvas.css')
  assert.match(css, /var\(--canvas-grid/, 'the stylesheet still hardcodes a spacing')
})

test('a page with nothing near it still lands on a dot', () => {
  // Shift always does something, which is what makes it read as a snap rather
  // than an occasional one. 100 -> 96, the nearest multiple of 24.
  assert.equal(snapOffset(100, 200, gridLines(100, 200)), -4)
})

test('a grid line is never more than half a cell away', () => {
  for (let start = 0; start < 200; start++) {
    const off = snapOffset(start, 200, gridLines(start, 200))
    assert.ok(Math.abs(off) <= GRID / 2, `start ${start} moved ${off}`)
  }
})

/**
 * THE TWO TESTS BELOW ARE ABOUT THE PRIMITIVE, not about what the board does.
 *
 * `snapOffset` throws every candidate into one contest decided on distance, and
 * that is still exactly what it does. What changed when guides landed is the
 * layer ABOVE it: `guideSnap` now gives a card line priority over the grid
 * inside CARD_PRIORITY, and only falls back to this combined contest when no
 * card relationship is within reach.
 *
 * It had to. A grid line is never further than half a cell, so under the
 * combined contest alone a card edge won only by being closer than twelve, and
 * four of six representative drags produced no guide at all — see CARD_PRIORITY
 * in shared/guides.ts for the measurements. The composite rule is pinned in
 * canvas-guides.test.mjs; these two keep the primitive honest.
 */
test('the primitive lets a nearer page edge beat the grid', () => {
  // Butting one page against another must still win, or deliberate placement
  // would be overruled by the grid every time.
  const pageEdge = 103
  const start = 101
  const withGrid = snapOffset(start, 200, [pageEdge, ...gridLines(start, 200)])
  assert.equal(withGrid, 2, 'the grid overruled a closer page edge')
})

test('the primitive lets the grid win when the page edge is further', () => {
  const start = 100
  // Page edge 14 away, grid 4 away. Note that `guideSnap` would NOT return this
  // — 14 is inside CARD_PRIORITY, so the composite takes the page edge. This is
  // the contest in isolation.
  const off = snapOffset(start, 200, [114, ...gridLines(start, 200)])
  assert.equal(off, -4)
})

test('groups are never a snap target', () => {
  // A group is a region drawn AROUND pages; its edges are wherever it was sized
  // to and are not a line anything should be flush with.
  const move = VIEW.slice(VIEW.indexOf('if (e.shiftKey && doc) {'), VIEW.indexOf('const snapX ='))
  assert.ok(move.length > 0, 'the drag snap no longer has the shape this test reads')
  assert.match(move, /n\.type !== 'group'/, 'a group can be aligned against')
})
