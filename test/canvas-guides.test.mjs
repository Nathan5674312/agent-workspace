/**
 * The guides that appear while you shift-drag a card.
 *
 * Two claims, and they fail differently:
 *
 *   1. The snap still does what it did. Guides are an explanation of an existing
 *      gesture, so if adopting them moved a single card by a single unit the
 *      feature has cost more than it bought. The tie-breaking and the range
 *      rules are pinned in canvas-snap.test.mjs against the same module.
 *
 *   2. The line drawn is the line that was matched. A guide that points at a
 *      card the snap did not use is worse than no guide — it is a confident
 *      wrong answer about why the card moved.
 *
 * Pure module. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { guideSnap, guideLine, CARD_PRIORITY, alignLines, gridLines, bestLine } = await import(
  '../src/shared/guides.ts'
)

const OPTS = { grid: 24, range: 120 }
const box = (x, y, width = 100, height = 60) => ({ x, y, width, height })
const aligns = (g) => g.guides.filter((v) => v.kind === 'align')
const gaps = (g) => g.guides.filter((v) => v.kind === 'gap')

// ------------------------------------------------------------------ alignment

test('a near miss on a neighbour edge snaps flush and says which edge', () => {
  // Moving card's left edge at 105, neighbour's left edge at 100.
  const moving = box(105, 400)
  const other = box(100, 200)
  const g = guideSnap(moving, [other], OPTS)
  assert.equal(g.dx, -5, 'did not close the 5')
  const [line] = aligns(g).filter((v) => v.axis === 'x')
  assert.ok(line, 'no vertical guide was produced')
  assert.equal(line.at, 100, 'the guide is not on the matched line')
})

test('the guide spans both cards, so it reads as joining them', () => {
  const moving = box(105, 400, 100, 60) // y 400..460
  const other = box(100, 200, 100, 60) // y 200..260
  const [line] = aligns(guideSnap(moving, [other], OPTS)).filter((v) => v.axis === 'x')
  assert.equal(line.from, 200, 'the guide does not reach the far card')
  assert.equal(line.to, 460, 'the guide does not reach the moving card')
})

test('landing on a dot draws nothing', () => {
  // The grid still snaps — it always does — but a line through a dot explains
  // nothing the dots were not already showing. With no other card on the board
  // there is no relationship to point at.
  const g = guideSnap(box(100, 100), [], OPTS)
  assert.equal(g.dx, -4, 'the grid stopped snapping')
  assert.deepEqual(g.guides, [], 'the grid drew a guide')
})

test('an edge can meet a centre, and the guide sits on the centre', () => {
  // A 100-wide card whose CENTRE lands on the neighbour's centre.
  const other = box(0, 0, 100, 60) // centre x = 50
  const g = guideSnap(box(56, 300, 100, 60), [other], OPTS)
  assert.equal(g.dx, -6, 'centre-to-centre did not snap')
  assert.equal(aligns(g).find((v) => v.axis === 'x').at, 50)
})

test('the two axes are decided independently', () => {
  // A card can lock to a neighbour's left edge while sitting anywhere
  // vertically. Locking both or neither would make building a column a fight.
  const other = box(100, 100)
  const g = guideSnap(box(103, 1000), [other], OPTS)
  assert.equal(g.dx, -3, 'x did not snap to the neighbour')
  assert.equal(aligns(g).filter((v) => v.axis === 'y').length, 0, 'y invented a relationship')
})

// -------------------------------------------------------------------- spacing

test('a card takes the gap its neighbours already use', () => {
  // A at 0..100, B at 140..240 — an existing gap of 40. A third card dropped
  // near the far side of B should land exactly 40 past it, at 280.
  const a = box(0, 0)
  const b = box(140, 0)
  const g = guideSnap(box(287, 0), [a, b], OPTS)
  assert.equal(g.dx, -7, `expected to be pulled back to 280, got ${287 + g.dx}`)
  const ticks = gaps(g).filter((v) => v.axis === 'x')
  // TWO ticks: the gap that was made, and the gap it was copied from. Showing
  // only the new one states the conclusion and hides the evidence — "the same
  // distance as those two" is a claim about a pair.
  assert.equal(ticks.length, 2, 'the matched gap was not shown alongside the new one')
  assert.deepEqual(
    ticks.map((t) => [t.from, t.to]).sort((p, q) => p[0] - q[0]),
    [
      [100, 140], // the gap a and b already had
      [240, 280], // the one the dragged card just made
    ],
  )
  for (const t of ticks) assert.equal(t.size, 40, 'the two ticks disagree about the distance')
})

test('a card centres itself between two others, with no gap to copy', () => {
  // Only two other cards, so there is no existing gap to repeat. The equal-space
  // relationship is still available and is the only one that is.
  const left = box(0, 0) // ends at 100
  const right = box(500, 0) // starts at 500
  // Room is 500 - 100 - 100 = 300, so half is 150 and the target start is 250.
  const g = guideSnap(box(256, 0), [left, right], OPTS)
  assert.equal(256 + g.dx, 250, 'did not centre between the two')
  const ticks = gaps(g).filter((v) => v.axis === 'x')
  assert.equal(ticks.length, 2, 'a centred card should show the gap on both sides')
  assert.equal(ticks[0].size, ticks[1].size, 'the two gaps are not reported equal')
  assert.equal(ticks[0].size, 150)
})

test('spacing only counts cards in the same band', () => {
  // The same two cards, but the mover is far below them. A gap to a card in a
  // different row is not a gap anyone can see, so distributing against it would
  // snap to a relationship that is not on screen.
  const a = box(0, 0)
  const b = box(140, 0)
  const g = guideSnap(box(287, 900), [a, b], OPTS)
  assert.equal(gaps(g).length, 0, 'spacing matched across rows')
})

test('overlapping neighbours describe no gap to repeat', () => {
  // Two cards that touch or overlap offer a gap of zero or less. Offering 0 as
  // a target would make every card want to stick to every other card.
  const a = box(0, 0)
  const b = box(80, 0) // overlaps a
  const g = guideSnap(box(300, 0), [a, b], OPTS)
  assert.equal(gaps(g).length, 0, 'a zero or negative gap became a snap target')
})

test('spacing beats the grid, which is the only reason it is reachable', () => {
  // The grid is never more than half a cell away, so a spacing match measured
  // against it on pure distance would lose almost every time.
  const a = box(0, 0)
  const b = box(140, 0)
  // 283 is 3 from the spacing target 280 and 5 from the grid line at 288.
  // Under a pure distance contest with the grid the spacing still wins here;
  // the case that matters is the one below.
  const near = guideSnap(box(283, 0), [a, b], OPTS)
  assert.equal(283 + near.dx, 280, 'spacing lost to the grid')
  // 289 is 9 from the spacing target and 1 from the grid line at 288. Spacing
  // still takes it, because the grid does not get to compete.
  const far = guideSnap(box(289, 0), [a, b], OPTS)
  assert.equal(289 + far.dx, 280, 'the grid overruled a deliberate spacing')
})

test('a closer card edge still beats spacing', () => {
  // The asymmetry has a limit. Two things the user is deliberately reaching for
  // compete on distance; it is only the grid that is demoted.
  const a = box(0, 0)
  const b = box(140, 0)
  // A third card whose left edge sits at 284, one unit from the mover at 285,
  // against a spacing target at 280 that is five away.
  const c = box(284, 300)
  const g = guideSnap(box(285, 0), [a, b, c], OPTS)
  assert.equal(285 + g.dx, 284, 'the nearer card edge lost to spacing')
  assert.equal(gaps(g).length, 0, 'a gap tick was drawn for a snap that did not happen')
  assert.equal(aligns(g).find((v) => v.axis === 'x').at, 284)
})

test('nothing within the spacing range leaves spacing alone', () => {
  const a = box(0, 0)
  const b = box(140, 0)
  // 280 + CARD_PRIORITY is out of reach.
  const g = guideSnap(box(280 + CARD_PRIORITY + 40, 0), [a, b], OPTS)
  assert.equal(gaps(g).length, 0, 'spacing fired from outside its range')
})

// ------------------------------------------------------- the guide never lies

test('every guide drawn corresponds to a snap that actually happened', () => {
  // The property that makes guides trustworthy. Sweep a card across a board and
  // assert that whenever a guide is drawn, the axis it names really did move,
  // and the line it names really is where the card ended up.
  const others = [box(0, 0), box(140, 0), box(400, 300), box(60, 600)]
  for (let x = -40; x < 700; x += 1) {
    for (const y of [0, 300, 600]) {
      const moving = box(x, y)
      const g = guideSnap(moving, others, OPTS)
      const landed = { x: x + g.dx, y: y + g.dy }
      for (const guide of g.guides.filter((v) => v.kind === 'align')) {
        const axis = guide.axis
        const start = axis === 'x' ? landed.x : landed.y
        const size = axis === 'x' ? moving.width : moving.height
        const lines = alignLines(start, size).map((v) => Math.round(v * 1e6) / 1e6)
        assert.ok(
          lines.some((v) => Math.abs(v - guide.at) < 1e-6),
          `guide at ${guide.at} on ${axis} but the card landed offering ${lines}`,
        )
      }

      /**
       * Gap ticks are checked as a SET, per axis, because they are one claim
       * made of several marks: "this distance equals that one". Two properties
       * carry that, and neither is a property of a single tick.
       */
      for (const axis of ['x', 'y']) {
        const ticks = g.guides.filter((v) => v.kind === 'gap' && v.axis === axis)
        if (ticks.length === 0) continue
        const start = axis === 'x' ? landed.x : landed.y
        const size = axis === 'x' ? moving.width : moving.height
        // 1. They must all report the same distance, or the picture is a lie.
        for (const t of ticks) {
          assert.equal(t.size, ticks[0].size, `ticks on ${axis} disagree: ${JSON.stringify(ticks)}`)
          assert.ok(t.size > 0, 'a gap tick reported a non-positive size')
          assert.equal(Math.round(t.to - t.from), t.size, 'a tick is not as long as it claims')
        }
        // 2. At least one must touch the card that was dragged, or the guides
        //    are describing a relationship this drag had nothing to do with.
        assert.ok(
          ticks.some(
            (t) =>
              Math.abs(t.to - start) < 1e-6 || Math.abs(t.from - (start + size)) < 1e-6,
          ),
          `no gap tick on ${axis} touches the card at ${start}..${start + size}`,
        )
      }
    }
  }
})

test('with no other cards the snap is the grid and nothing else', () => {
  for (let x = 0; x < 240; x++) {
    const g = guideSnap(box(x, x), [], OPTS)
    assert.deepEqual(g.guides, [], `x=${x} drew a guide with nothing to align to`)
    assert.ok(Math.abs(g.dx) <= OPTS.grid / 2, `x=${x} moved ${g.dx}, further than half a cell`)
  }
})

// ------------------------------------------------------------- drawn geometry

test('an x alignment draws a VERTICAL line, and a y one horizontal', () => {
  // The trap this helper exists for. "These share an x" is drawn as a line of
  // constant x spanning y — the axis named and the axis drawn are opposite, and
  // getting it backwards produces a plausible picture of the wrong thing.
  const vertical = guideLine({ kind: 'align', axis: 'x', at: 100, from: 20, to: 300 })
  assert.deepEqual(vertical, { x1: 100, y1: 20, x2: 100, y2: 300 })
  assert.equal(vertical.x1, vertical.x2, 'an x alignment is not vertical')

  const horizontal = guideLine({ kind: 'align', axis: 'y', at: 100, from: 20, to: 300 })
  assert.deepEqual(horizontal, { x1: 20, y1: 100, x2: 300, y2: 100 })
  assert.equal(horizontal.y1, horizontal.y2, 'a y alignment is not horizontal')
})

test('a gap runs along the axis it measures, the opposite way round', () => {
  // A gap on x is a distance ALONG x, so it draws horizontally — the mirror of
  // the alignment case above, which is exactly why both are pinned here.
  const alongX = guideLine({ kind: 'gap', axis: 'x', at: 50, from: 100, to: 140, size: 40 })
  assert.deepEqual(alongX, { x1: 100, y1: 50, x2: 140, y2: 50 })
  assert.equal(alongX.y1, alongX.y2, 'an x gap is not horizontal')

  const alongY = guideLine({ kind: 'gap', axis: 'y', at: 50, from: 100, to: 140, size: 40 })
  assert.deepEqual(alongY, { x1: 50, y1: 100, x2: 50, y2: 140 })
  assert.equal(alongY.x1, alongY.x2, 'a y gap is not vertical')
})

test('a drawn gap is as long as the size it reports', () => {
  // Otherwise the number and the bar disagree, and the number is the part the
  // user is being asked to trust.
  const a = box(0, 0)
  const b = box(140, 0)
  for (const g of guideSnap(box(283, 0), [a, b], OPTS).guides) {
    if (g.kind !== 'gap') continue
    const { x1, y1, x2, y2 } = guideLine(g)
    assert.equal(Math.round(Math.hypot(x2 - x1, y2 - y1)), g.size)
  }
})

test('the exported primitives are the ones the view used to hold', () => {
  assert.deepEqual(alignLines(100, 60), [100, 130, 160])
  // 100 -> 96, 200 -> 192, and 300 is exactly 12.5 cells so it rounds up to 312.
  assert.deepEqual(gridLines(100, 200, 24), [96, 192, 312])
  assert.equal(bestLine(0, 100, [9999], 120), null, 'out of range should be no match')
})
