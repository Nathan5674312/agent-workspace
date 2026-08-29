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

const { groupMembers, groupFit, dragSet } = await import('../src/shared/canvas.ts')

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

// ── the box somebody sized on purpose ─────────────────────────────

/*
 * Nathan's report: a group resized by hand does not stay resized.
 *
 * It stayed for exactly one release. `fitGroups` skips the node the gesture had
 * hold of, so letting go of the handle left the box alone — and then the NEXT
 * drag of any page anywhere on the board refitted every group on it and pulled
 * the box straight back onto its contents. So the size survived the gesture that
 * set it and nothing after that, which reads as the resize having been undone by
 * something unrelated a moment later.
 *
 * `floor` is the durable half. CanvasView marks a group it watched the user
 * resize and hands the mark back here as a box the fit may not shrink inside.
 */

test('a group sized by hand is not pulled back onto its contents', () => {
  const roomy = { x: -200, y: -200, width: 900, height: 900 }
  // One small page in the corner. Unfloored this collapses to 196x196.
  assert.deepEqual(groupFit([page('a', 0, 0)], PAD, roomy), roomy)
})

test('a group sized by hand still grows to reach a page that has left it', () => {
  // The half that must NOT be withheld. Growing answers for something the user
  // just did to the pages; shrinking overrules something they did to the box.
  const roomy = { x: 0, y: 0, width: 400, height: 400 }
  const box = groupFit([page('a', 600, 100)], PAD, roomy)
  assert.equal(box.x, 0, 'the hand-set left wall moved')
  assert.equal(box.y, 0, 'the hand-set top wall moved')
  // The page spans 600..700, so the right wall has to reach 748.
  assert.equal(box.width, 748, 'the box did not reach the page outside it')
  assert.equal(box.height, 400, 'a side the contents had not outgrown moved anyway')
})

test('the floored box always contains both', () => {
  // The property, stated directly rather than left implied by the two cases
  // above: whatever the members do, the hand-set walls are still inside.
  const roomy = { x: -50, y: -50, width: 300, height: 300 }
  for (const p of [page('a', 0, 0), page('a', 900, 900), page('a', -900, 40)]) {
    const box = groupFit([p], PAD, roomy)
    assert.ok(box.x <= roomy.x && box.y <= roomy.y, 'a wall moved inward')
    assert.ok(box.x + box.width >= roomy.x + roomy.width, 'the right wall moved inward')
    assert.ok(box.y + box.height >= roomy.y + roomy.height, 'the bottom wall moved inward')
  }
})

test('an empty group is left alone even when it was sized by hand', () => {
  // Emptiness wins over the floor, and it has to: the answer for an empty group
  // is already "do not touch it", so a floor would be a longer way to say the
  // same thing and a second rule to keep in agreement with the first.
  assert.equal(groupFit([], PAD, { x: 0, y: 0, width: 500, height: 500 }), null)
})

test('with no floor the fit owns the box completely, exactly as before', () => {
  // The ordinary case is unchanged, and this is what pins that the argument is
  // an exemption rather than a change of behaviour for every group.
  const members = [page('a', 0, 0)]
  assert.deepEqual(groupFit(members, PAD, null), groupFit(members, PAD))
})

// ── a group carries what it holds ─────────────────────────────────

/*
 * THESE ARE UNIT TESTS ON PURPOSE, and the reason is worth recording. The
 * first cut of this feature was covered by source regexes asserting the right
 * lines existed. They did exist, the tests passed, and dragging a group still
 * left its pages behind. A source-shaped test cannot tell you that. `dragSet`
 * was pulled out of the view so this file can run the actual decision.
 */

test('dragging a group carries every page inside it', () => {
  const g = group('g', 0, 0, 1000, 1000)
  const nodes = [g, page('a', 100, 100), page('b', 400, 400), page('c', 5000, 5000)]
  assert.deepEqual(
    dragSet(g, new Set(), nodes).map((n) => n.id).sort(),
    ['a', 'b'],
    'a group did not pick up its members, or picked up one outside it',
  )
})

test('the target is never in its own carry set', () => {
  // It moves as `held.node`; carrying it as well would apply the delta twice.
  const g = group('g', 0, 0, 1000, 1000)
  const nodes = [g, page('a', 100, 100)]
  assert.ok(!dragSet(g, new Set(), nodes).includes(g))
})

test('dragging a lone page carries nothing', () => {
  const g = group('g', 0, 0, 1000, 1000)
  const a = page('a', 100, 100)
  assert.deepEqual(dragSet(a, new Set(), [g, a]), [])
})

test('a multi-selection carries the members of any group in it', () => {
  const g = group('g', 0, 0, 1000, 1000)
  const inside = page('in', 100, 100)
  const far = page('far', 5000, 5000)
  const nodes = [g, inside, far]
  // Selection is {g, far}, dragged by `far`: g comes along as a selected node,
  // and g's own member comes along with g.
  const out = dragSet(far, new Set(['g', 'far']), nodes)
  assert.deepEqual(out.map((n) => n.id).sort(), ['g', 'in'])
})

test('a group nested in the drag set does not carry other groups', () => {
  const outer = group('outer', 0, 0, 2000, 2000)
  const inner = group('inner', 100, 100, 200, 200)
  assert.deepEqual(dragSet(outer, new Set(), [outer, inner]), [])
})

test('membership is snapshot at press, not recomputed mid-drag', () => {
  // Recomputing per frame would let a group adopt pages it swept over and drop
  // the ones it left, so what you released would depend on the path you took.
  const view = readSource('CanvasView.tsx')
  const from = view.indexOf('if (drag.current) {')
  const move = view.slice(from, view.indexOf('const snapX =', from))
  assert.ok(move.length > 0, 'the move handler no longer has the shape this test reads')
  assert.doesNotMatch(move, /dragSet\(|groupMembers\(/, 'membership is recomputed during the drag')
})

test('a moving group snaps by its interior, not its outline', () => {
  // Matching on the outline made a group lock to arbitrary positions, which
  // reads worse than not locking: the board looks like it found something real.
  const view = readSource('CanvasView.tsx')
  assert.match(
    view,
    /held\.node\.type === 'group' \? groupInterior\(box\) : box/,
    'a dragged group matches on its own outline again',
  )
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
  // `[,)]` because the fit gained a third argument — the floor a hand-sized
  // group may not shrink inside. The padding is what this test is about and it
  // is still the second one.
  assert.match(VIEW, /groupFit\(groupMembers\(g, d\.nodes\), GROUP_PAD[,)]/)
})

test('a group resized by hand is marked, so a later gesture cannot undo it', () => {
  // The mark goes on the NODE, which means it goes in the file. It has to: the
  // group must still be the size you left it after the board is closed and
  // reopened, and a ref does not survive that. `locked` is the precedent for
  // riding the spec's index signature, and Obsidian carries both through.
  const up = VIEW.slice(VIEW.indexOf('const onUp = () => {'))
  assert.match(
    up,
    /if \(r\.node\.type === 'group'\) r\.node\.sized = true/,
    'a hand resize is forgotten again the moment the gesture ends',
  )
})

test('the mark is what the fit is handed as its floor', () => {
  assert.match(
    VIEW,
    /groupFit\(groupMembers\(g, d\.nodes\), GROUP_PAD, g\.sized \? g : null\)/,
    'the mark is recorded but never consulted',
  )
})

test("Shift does not force a page's shape onto a group", () => {
  // The loop inside already skipped groups as candidates to MATCH; nothing
  // stopped a group being the node being resized. So Shift on a group's grip
  // gave a region US Letter proportions and then snapped it to the exact size
  // of some page — the one size a group cannot be, since the padding it owes
  // its contents does not fit inside it.
  assert.match(
    VIEW,
    /if \(e\.shiftKey && doc && r\.node\.type !== 'group'\) \{/,
    'Shift treats a group like a page again',
  )
})

test('the uniform-size sweep fits the groups too', () => {
  // The largest size change the board has — every page at once — and the only
  // one that never fitted a group, so the button whose job is tidying left every
  // group carrying the shape of the pages it used to hold.
  const fn = VIEW.slice(VIEW.indexOf('const uniformSize ='), VIEW.indexOf('const toWorld ='))
  assert.ok(fn.length > 0, 'uniformSize no longer has the shape this test reads')
  assert.match(fn, /fitGroups\(doc, new Set\(\)\)/, 'the sweep resizes every page and fits nothing')
})

/*
 * A page DRAGGED into a group grew the group to hold it and a page CREATED in
 * the same spot did not, so what a group did depended on which door the page
 * came through. A note dropped from the tree onto a group is the most obvious
 * way there is to fill one, and it was the case that did nothing.
 */
for (const [name, start, end] of [
  ['addCardAt', 'const addCardAt =', 'const addCard ='],
  ['duplicateNode', 'const duplicateNode =', 'const pasteNode ='],
  ['pasteNode', 'const pasteNode =', 'const setNodeColor ='],
  ['addLink', 'const addLink =', 'const addGroup ='],
  ['onDrop', 'const onDrop =', 'const addEdge ='],
]) {
  test(`${name} lets the group its page landed in take it`, () => {
    const src = VIEW.slice(VIEW.indexOf(start), VIEW.indexOf(end))
    assert.ok(src.length > 0, `${name} no longer has the shape this test reads`)
    assert.match(src, /place\(doc, /, `${name} skips the fit`)
    assert.doesNotMatch(src, /doc\.nodes\.push\(/, `${name} still pushes straight onto the doc`)
  })
}

test('a new GROUP is not fitted on creation', () => {
  // The exception, and it is deliberate twice over. A group is never a member of
  // a group, so a new one changes nothing about what any other group holds — and
  // fitting it would tighten the brand new box onto whatever it was drawn over,
  // which is the opposite of drawing a region to fill later.
  const src = VIEW.slice(VIEW.indexOf('const addGroupAt ='), VIEW.indexOf('const addLink ='))
  assert.ok(src.length > 0, 'addGroupAt no longer has the shape this test reads')
  assert.match(src, /doc\.nodes\.push\(node\)/, 'a new group is now fitted to its contents')
  assert.doesNotMatch(src, /place\(doc, /)
})

test('the Alt+drag copy is fitted by the release, not at the press', () => {
  // It is created and then DRAGGED, so fitting at the press would grow a group
  // around a copy that is about to be pulled out of it. The release already
  // covers it — `created` is in the condition that runs the fit.
  const up = VIEW.slice(VIEW.indexOf('const onUp = () => {'))
  assert.match(up, /drag\.current\?\.moved \|\| drag\.current\?\.created/)
})
