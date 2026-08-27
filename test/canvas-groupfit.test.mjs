/**
 * Groups that hug what they hold.
 *
 * A group used to be a rectangle you sized by hand and then watched drift out
 * of agreement with its contents — pages dragged in sat wherever the pointer
 * let go, pages dragged out left a box carrying their shape. Both halves are
 * the same complaint: the outline and the pages were two independent things
 * that happened to overlap.
 *
 * `groupMembers` and `groupFit` are the arithmetic that ties them together, and
 * they live in `shared/canvas.ts` with the rest of the board geometry so a test
 * can assert what they COMPUTE rather than regex the view for a line that looks
 * about right. The wiring that calls them is pinned at the bottom, which is the
 * split canvas-snap.test.mjs already uses.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const VIEW = readSource('CanvasView.tsx')

const { groupMembers, groupFit } = await import('../src/shared/canvas.ts')

/** The padding CanvasView passes in, mirrored here so the numbers below read. */
const PAD = 48

const page = (id, x, y, width = 100, height = 100) => ({
  id,
  type: 'file',
  x,
  y,
  width,
  height,
})

const group = (id, x, y, width, height) => ({ id, type: 'group', x, y, width, height })

// ── membership ────────────────────────────────────────────────────

test('an empty group holds nothing', () => {
  const g = group('g', 0, 0, 500, 500)
  assert.deepEqual(groupMembers(g, [g]), [])
})

test('a page inside the group is held', () => {
  const g = group('g', 0, 0, 500, 500)
  const p = page('p', 100, 100)
  assert.deepEqual(
    groupMembers(g, [g, p]).map((n) => n.id),
    ['p'],
  )
})

test('membership is the centre, so a page half out is still in', () => {
  // Page spans x 450..550 against a group ending at 500, so half of it is
  // outside. Its centre is 500 — on the line, and the rule takes it.
  const g = group('g', 0, 0, 500, 500)
  const p = page('p', 450, 200)
  assert.equal(groupMembers(g, [g, p]).length, 1, 'enclosure is being used, not the centre')
})

test('a page whose centre has left is not held', () => {
  const g = group('g', 0, 0, 500, 500)
  const p = page('p', 460, 200)
  assert.deepEqual(groupMembers(g, [g, p]), [])
})

test('a group is never a member of another group', () => {
  // JSON Canvas permits the nesting; the fit deliberately does not model it,
  // because fitting nested groups means fitting them innermost-first and the
  // file can express two groups each inside the other.
  const outer = group('outer', 0, 0, 900, 900)
  const inner = group('inner', 100, 100, 200, 200)
  assert.deepEqual(groupMembers(outer, [outer, inner]), [])
})

// ── the fit ───────────────────────────────────────────────────────

test('an empty group is left alone rather than collapsed', () => {
  // The useful half of the contract: a box drawn for a phase whose pages do not
  // exist yet must survive being empty, or laying a pipeline out in advance is
  // impossible.
  assert.equal(groupFit([], PAD), null)
})

test('a group takes its members bounding box plus the padding', () => {
  const box = groupFit([page('a', 200, 200), page('b', 400, 500)], PAD)
  assert.deepEqual(box, {
    x: 200 - PAD,
    y: 200 - PAD,
    // 200..500 across (b ends at 500), 200..600 down (b ends at 600).
    width: 300 + PAD * 2,
    height: 400 + PAD * 2,
  })
})

test('one member gives a box exactly one page plus padding', () => {
  const box = groupFit([page('a', 0, 0, 612, 792)], PAD)
  assert.deepEqual(box, { x: -PAD, y: -PAD, width: 612 + PAD * 2, height: 792 + PAD * 2 })
})

test('it shrinks as well as grows', () => {
  // A fit that only grew would leave a group carrying the shape of a page that
  // has since been dragged out of it.
  const wide = groupFit([page('a', 0, 0), page('b', 800, 0)], PAD)
  const narrow = groupFit([page('a', 0, 0)], PAD)
  assert.ok(narrow.width < wide.width, 'the box did not close over the gap')
  assert.equal(narrow.width, 100 + PAD * 2)
})

test('the box is integers, because the spec says so', () => {
  // Groups are the one node nobody types a size into: every value one ever gets
  // comes out of this arithmetic.
  const box = groupFit([page('a', 0, 0, 101, 101), page('b', 50, 50, 101, 101)], 1.5)
  for (const v of Object.values(box)) assert.equal(v, Math.round(v), 'a fractional coordinate')
})

test('a page already on the interior line needs no fit at all', () => {
  // THE PROPERTY THAT TIES THE FIT TO THE SNAP. `groupInterior` insets a group
  // by the same GROUP_PAD this pads by, so a page that snapped to the group's
  // inside edge is already exactly where the fit would put the wall. Drop a
  // page into a group and the box must not jump out from under it.
  const g = group('g', 0, 0, 100 + PAD * 2, 100 + PAD * 2)
  const p = page('p', PAD, PAD)
  const box = groupFit(groupMembers(g, [g, p]), PAD)
  assert.deepEqual(box, { x: g.x, y: g.y, width: g.width, height: g.height })
})

// ── the wiring ────────────────────────────────────────────────────

test('the fit runs before the write, so it shares the save and the undo', () => {
  const up = VIEW.slice(VIEW.indexOf('const onUp = () => {'))
  const drag = up.indexOf('fitGroups(doc, new Set([held.node')
  const write = up.indexOf('void persist(doc)', drag)
  assert.ok(drag > 0, 'the drag release no longer fits groups')
  assert.ok(drag < write, 'the fit runs after the save, so it would need a second write')
})

test('everything the gesture had hold of is skipped', () => {
  // Dragging a group does not carry its pages, so a group that fitted itself on
  // release would slide straight back onto them.
  assert.match(
    VIEW,
    /fitGroups\(doc, new Set\(\[held\.node, \.\.\.held\.others\.map\(\(o\) => o\.node\)\]\)\)/,
    'a dragged group is no longer exempt from its own fit',
  )
})

test('a resized node is exempt, which is what keeps a group resizable by hand', () => {
  assert.match(VIEW, /fitGroups\(doc, new Set\(\[r\.node\]\)\)/, 'the resize no longer exempts itself')
})

test('deleting pages closes the group over the gap', () => {
  const del = VIEW.slice(VIEW.indexOf('const deleteSelected = () => {'))
  assert.match(del.slice(0, del.indexOf('void persist(doc)')), /fitGroups\(doc, new Set\(\)\)/)
})

test('the fit is passed the same padding a group is built from', () => {
  // Not a literal 48. The inset the snap uses, the room a new group leaves and
  // the wall this fit puts up are one measurement, and a copy is how they start
  // to disagree.
  assert.match(VIEW, /groupFit\(groupMembers\(g, d\.nodes\), GROUP_PAD\)/)
})
