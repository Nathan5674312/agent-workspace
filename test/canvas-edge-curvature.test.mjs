/**
 * Edge curvature — the property the quintic exists to buy.
 *
 * An edge used to be a cubic whose control points were `anchor + normal * pull`.
 * That is G1: the tangent leaves perpendicular to the card, so there is no
 * visible kink. But CURVATURE at the anchor was free and generally non-zero, so
 * every line left its card already bending and met the arrowhead — a straight
 * object — with a curvature step. It is the circular-arc-corner problem, and it
 * is why a rounded rectangle drawn with arcs reads as pinched next to a
 * superellipse that ramps curvature up from zero.
 *
 * A cubic cannot fix it. For a degree-n Bézier,
 *
 *     k(0) = (n-1)/n * |(P1-P0) x (P2-P1)| / |P1-P0|^3
 *
 * so k(0) = 0 needs P0, P1, P2 collinear — three of a cubic's four points spent
 * on one end, leaving nothing for the other end or the middle. Degree five is
 * the first degree with room for a flat run at BOTH ends and a turn between.
 *
 * These assertions are on the control points, where collinearity is an exact
 * cross product, rather than on a numerically differentiated curve compared to
 * a tolerance. Pure module. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { edgeControlPoints, edgeCurve, FLAT_SPLIT } = await import('../src/shared/canvas.ts')

const cross = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x)

/**
 * The first cubic of an iOS continuous corner, in units of the corner radius,
 * measured inward from the corner vertex. Reverse engineered from UIBezierPath
 * and published by PaintCode. All three points sit on the straight edge (y = 0)
 * — the same collinearity device this file's quintic uses, for the same reason.
 */
const APPLE_CORNER = { p0: 1.52866471, p1: 1.08849323, p2: 0.86840689 }

test('the flat-run split is Apple\'s ratio, derived rather than asserted', () => {
  // Pins the PROVENANCE. FLAT_SPLIT is otherwise a free parameter — any value in
  // (0,1) gives zero curvature — so nothing else in this suite would notice it
  // being "tidied" back to a round number someone liked the look of.
  const ratio =
    (APPLE_CORNER.p0 - APPLE_CORNER.p1) / (APPLE_CORNER.p0 - APPLE_CORNER.p2)
  assert.ok(
    Math.abs(ratio - 2 / 3) < 1e-6,
    `Apple's own corner is not 2/3: got ${ratio}`,
  )
  assert.ok(
    Math.abs(FLAT_SPLIT - ratio) < 1e-6,
    `FLAT_SPLIT is ${FLAT_SPLIT}, Apple's corner gives ${ratio}`,
  )
})


/**
 * Every arrangement that has ever looked wrong, including the ones the old
 * distance-only handle could not tell apart: facing, offset, stacked, far,
 * nearly touching, and the two hard cases where the chosen sides face AWAY from
 * each other and the curve has to double back.
 */
const CASES = {
  'facing across a gap': [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 50 },
    { x: 400, y: 0, width: 100, height: 100 },
    { x: 400, y: 50 },
  ],
  'stacked vertically': [
    { x: 0, y: 0, width: 300, height: 80 },
    { x: 150, y: 80 },
    { x: 0, y: 260, width: 300, height: 80 },
    { x: 150, y: 260 },
  ],
  'diagonal, perpendicular sides': [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 50 },
    { x: 400, y: 300, width: 100, height: 100 },
    { x: 450, y: 300 },
  ],
  'nearly touching': [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 50 },
    { x: 108, y: 0, width: 100, height: 100 },
    { x: 108, y: 50 },
  ],
  'far apart': [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 50 },
    { x: 6000, y: 4000, width: 100, height: 100 },
    { x: 6000, y: 4050 },
  ],
  // The U-turn: both anchors on sides pointing away from the other card.
  'sides facing away': [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 0, y: 50 },
    { x: 400, y: 0, width: 100, height: 100 },
    { x: 500, y: 50 },
  ],
}

test('curvature is exactly zero where an edge meets a card, at both ends', () => {
  for (const [name, [a, from, b, to]] of Object.entries(CASES)) {
    const P = edgeControlPoints(a, from, b, to)
    assert.equal(P.length, 6, `${name}: not a quintic`)
    // k(0) = 0  <=>  P0, P1, P2 collinear.
    assert.equal(cross(P[0], P[1], P[2]), 0, `${name}: curvature is non-zero leaving the card`)
    // k(1) = 0  <=>  P3, P4, P5 collinear.
    assert.equal(cross(P[3], P[4], P[5]), 0, `${name}: curvature is non-zero entering the card`)
  }
})

test('the split actually moves the control point where it claims to', () => {
  // The constant is only worth pinning if it reaches the geometry. P1 must sit
  // FLAT_SPLIT of the way from the anchor to P2, along the flat run, at both
  // ends of every edge.
  for (const [name, [a, from, b, to]] of Object.entries(CASES)) {
    const P = edgeControlPoints(a, from, b, to)
    const outRun = Math.hypot(P[2].x - P[0].x, P[2].y - P[0].y)
    const inRun = Math.hypot(P[3].x - P[5].x, P[3].y - P[5].y)
    assert.ok(outRun > 0 && inRun > 0, `${name}: a flat run collapsed`)
    const out = Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) / outRun
    const into = Math.hypot(P[4].x - P[5].x, P[4].y - P[5].y) / inRun
    assert.ok(Math.abs(out - FLAT_SPLIT) < 1e-9, `${name}: lead-out split is ${out}`)
    assert.ok(Math.abs(into - FLAT_SPLIT) < 1e-9, `${name}: lead-in split is ${into}`)
  }
})

test('the flat run at each end is real, not a degenerate zero-length one', () => {
  // Collinearity is trivially satisfied by putting P1 and P2 on top of P0. That
  // would pass the test above and draw the old curve, so the run has to have
  // length and the two interior points have to be distinct.
  for (const [name, [a, from, b, to]] of Object.entries(CASES)) {
    const P = edgeControlPoints(a, from, b, to)
    assert.ok(Math.hypot(P[1].x - P[0].x, P[1].y - P[0].y) > 0, `${name}: lead-out has no length`)
    assert.ok(Math.hypot(P[2].x - P[1].x, P[2].y - P[1].y) > 0, `${name}: lead-out is degenerate`)
    assert.ok(Math.hypot(P[4].x - P[5].x, P[4].y - P[5].y) > 0, `${name}: lead-in has no length`)
    assert.ok(Math.hypot(P[3].x - P[4].x, P[3].y - P[4].y) > 0, `${name}: lead-in is degenerate`)
  }
})

test('the reach is direction-aware, not distance-only', () => {
  // The defect in the old `dist * 0.4`: these two pairs are the SAME distance
  // apart and need completely different handles. One faces across the gap; the
  // other has to turn around and come back. A distance-only rule gives them an
  // identical lead-out, and the second one kinks.
  const [fa, ffrom, fb, fto] = CASES['facing across a gap']
  const [aa, afrom, ab, ato] = CASES['sides facing away']
  const facing = edgeControlPoints(fa, ffrom, fb, fto)
  const away = edgeControlPoints(aa, afrom, ab, ato)

  const lead = (P) => Math.hypot(P[2].x - P[0].x, P[2].y - P[0].y)
  assert.ok(
    lead(away) > lead(facing) * 1.5,
    `a side facing away got reach ${lead(away)}, barely more than the facing ${lead(facing)}`,
  )
})

test('a near-touching pair does not get a handle longer than its own gap', () => {
  // The floor used to be a flat 24 units, so two cards 8 apart got a 24-unit
  // bulge out of an 8-unit gap — a visible loop between two cards that are
  // nearly flush.
  const [a, from, b, to] = CASES['nearly touching']
  const P = edgeControlPoints(a, from, b, to)
  const gap = Math.hypot(to.x - from.x, to.y - from.y)
  const lead = Math.hypot(P[2].x - P[0].x, P[2].y - P[0].y)
  assert.ok(lead <= gap, `lead-out ${lead} exceeds the ${gap} gap it has to cross`)
})

test('the emitted path starts and ends exactly on the anchors', () => {
  // The path is written as cubic spans because SVG has no quintic command. The
  // approximation must not move the ENDPOINTS — an edge that starts a fraction
  // off its card is an edge with a gap at the card, which is exactly the kind of
  // sub-pixel wrongness this whole change is about.
  for (const [name, [a, from, b, to]] of Object.entries(CASES)) {
    const { d } = edgeCurve(a, from, b, to, 5000)
    const start = d.match(/^M (-?[\d.]+) (-?[\d.]+)/)
    assert.ok(start, `${name}: path does not start with a moveto`)
    assert.ok(Math.abs(Number(start[1]) - (from.x + 5000)) < 1e-9, `${name}: start x moved`)
    assert.ok(Math.abs(Number(start[2]) - (from.y + 5000)) < 1e-9, `${name}: start y moved`)

    const nums = d.trim().split(/[\s,]+/).filter((s) => /^-?[\d.]+$/.test(s)).map(Number)
    assert.ok(Math.abs(nums[nums.length - 2] - (to.x + 5000)) < 1e-9, `${name}: end x moved`)
    assert.ok(Math.abs(nums[nums.length - 1] - (to.y + 5000)) < 1e-9, `${name}: end y moved`)
  }
})

test('the cubic spans track the real quintic to well under a pixel', () => {
  // The honest version of "the approximation is fine". Walks the emitted path
  // and the true quintic together and compares them, rather than asserting the
  // span count and calling it proof.
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

  for (const [name, [a, from, b, to]] of Object.entries(CASES)) {
    const P = edgeControlPoints(a, from, b, to)
    const { d } = edgeCurve(a, from, b, to, 0)

    // Rebuild the emitted path as a list of cubic segments.
    const nums = d.trim().split(/[\s,CM]+/).filter(Boolean).map(Number)
    const segs = []
    let cursor = { x: nums[0], y: nums[1] }
    for (let i = 2; i + 5 < nums.length + 1; i += 6) {
      const seg = [
        cursor,
        { x: nums[i], y: nums[i + 1] },
        { x: nums[i + 2], y: nums[i + 3] },
        { x: nums[i + 4], y: nums[i + 5] },
      ]
      segs.push(seg)
      cursor = seg[3]
    }
    assert.ok(segs.length > 1, `${name}: path is a single span`)

    const scale = Math.hypot(to.x - from.x, to.y - from.y)
    let worst = 0
    for (let i = 0; i < segs.length; i++) {
      for (let s = 0; s <= 10; s++) {
        const local = s / 10
        const global = (i + local) / segs.length
        const onPath = deCasteljau(segs[i], local)
        const onQuintic = deCasteljau(P, global)
        worst = Math.max(worst, Math.hypot(onPath.x - onQuintic.x, onPath.y - onQuintic.y))
      }
    }
    // Relative to the edge's own length, so the far-apart case is held to the
    // same standard as the near one — the absolute error scales with length, so
    // an absolute bound would be vacuous for short edges and unmeetable for long
    // ones.
    //
    // 5e-5 is not a number tuned until it passed. The board clamps zoom at
    // K_MAX = 3 and the longest edge it can plausibly hold is a few thousand
    // units, so this bound keeps the worst drift under about a quarter of a
    // pixel on screen.
    //
    // Measured against it, worst case over ALL the cases above rather than
    // whichever one flattered the span count: six spans give 1.1e-3, eight give
    // 3.8e-4, twelve give 7.8e-5 — all three FAIL this — and sixteen give
    // 2.5e-5, which passes with room. The worst case is the U-turn at every
    // count, not the long edge.
    //
    // An earlier version of this comment quoted 2.4e-4 for six spans. That is
    // the facing-across-a-gap figure, not the worst case, and EDGE_SPANS was
    // lowered to six on the strength of it. See the note on EDGE_SPANS.
    assert.ok(
      worst / scale < 5e-5,
      `${name}: spans drift ${worst} (${worst / scale} relative) over a ${scale} span`,
    )
  }
})
