/**
 * Headless measurement of the hold-to-orbit behaviour.
 *
 * Shared by `bench/orbit.mjs`, which prints a comparison table for tuning, and
 * `test/graph-orbit.test.mjs`, which asserts the acceptance bar. One
 * implementation on purpose: a test and a bench that measure the same thing
 * two different ways will eventually disagree, and then neither is trusted.
 *
 * Why this exists: the orbit has been "fixed" twice by looking at it, and
 * shipped wrong twice. A change that looks better in one screenshot can be
 * worse in motion, and the three things Nathan actually complained about —
 * a perfect circle, 2-hop jitter, rotation too fast — are all numbers.
 *
 * It imports the app's real physics from `graphPhysics.ts`. It does not
 * reimplement the layout; a tuning number measured against a second copy of
 * the simulation is worth nothing.
 */

import * as d3 from 'd3-force'
import {
  buildSimulation,
  radius,
  LEGACY_HOLD,
  HOLD,
} from '../src/renderer/panes/vault/graphPhysics.ts'

// ── a synthetic vault-shaped graph ──────────────────────────────
// One hub, a ring of direct neighbours, each with its own leaves, plus a
// detached cluster so centring has something to do. Shaped like a real note
// vault: a few hubs, mostly leaves.

/**
 * The neighbour degrees are DELIBERATELY IRREGULAR.
 *
 * The first version of this gave every neighbour exactly three leaves. A
 * perfectly symmetric graph produces a perfectly symmetric answer whatever the
 * tuning does, so it could not have detected the thing it was built to
 * detect — it reported the ring getting less circular when the coefficient of
 * variation had not moved at all. A real vault has one note with forty links
 * and thirty with one; the harness has to look like that or it is measuring
 * its own symmetry.
 */
const LEAF_COUNTS = [0, 1, 7, 2, 0, 4, 1, 12, 3, 0, 5, 2]

export function makeGraph({ hubDegree = 12, farNodes = 8 } = {}) {
  const ids = ['hub']
  const edges = []
  for (let i = 0; i < hubDegree; i++) {
    const n = `n${i}`
    ids.push(n)
    edges.push(['hub', n])
    const leaves = LEAF_COUNTS[i % LEAF_COUNTS.length]
    for (let j = 0; j < leaves; j++) {
      const leaf = `n${i}_leaf${j}`
      ids.push(leaf)
      edges.push([n, leaf])
    }
    // A few neighbours are cross-linked to each other, which a tree cannot
    // represent and every real vault has.
    if (i >= 2 && i % 4 === 0) edges.push([`n${i}`, `n${i - 2}`])
  }
  // A second small cluster with no path to the hub.
  for (let i = 0; i < farNodes; i++) {
    const f = `far${i}`
    ids.push(f)
    if (i > 0) edges.push([`far${i - 1}`, f])
  }

  const degree = new Map()
  for (const [a, b] of edges) {
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }

  const nodes = ids.map((id, i) => ({
    id,
    degree: degree.get(id) ?? 0,
    // Explicit deterministic start positions. d3 seeds a phyllotaxis spiral
    // itself, but pinning them here means a rerun of this file cannot drift
    // for reasons unrelated to the change being measured.
    x: Math.cos(i * 2.399) * (10 + i * 3),
    y: Math.sin(i * 2.399) * (10 + i * 3),
    vx: 0,
    vy: 0,
  }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const links = edges.map(([a, b]) => ({ source: byId.get(a), target: byId.get(b) }))
  return { nodes, links, byId }
}

export const stddev = (xs) => {
  if (xs.length < 2) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
}
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/**
 * Run one hold and report what happened.
 *
 * `settleTicks` runs the layout to rest with nothing held, so the measurement
 * starts from a graph that is at equilibrium — the same state a user is
 * looking at when they press. Measuring from a hot layout would blame the
 * hold for motion the layout was going to produce anyway.
 */
export function measure(tuning, { holdTicks = 240, warmup = 40 } = {}) {
  const { nodes, links, byId } = makeGraph()

  let held = null
  const adjacency = new Map()
  const connect = (a, b) => {
    const l = adjacency.get(a.id)
    if (l) l.push(b)
    else adjacency.set(a.id, [b])
  }

  const { sim, setHolding } = buildSimulation(
    nodes,
    links,
    () => held,
    () => adjacency,
    tuning,
  )
  // forceLink rewrites source/target from ids to references when the force is
  // added, so adjacency must be built after buildSimulation.
  for (const l of links) {
    connect(l.source, l.target)
    connect(l.target, l.source)
  }

  // Settle to equilibrium, nothing held.
  sim.stop()
  for (let i = 0; i < 600; i++) sim.tick()

  const hub = byId.get('hub')
  const oneHop = adjacency.get('hub')
  const oneHopIds = new Set(oneHop.map((n) => n.id))
  const twoHop = nodes.filter(
    (n) => n.id !== 'hub' && !oneHopIds.has(n.id) && n.id.startsWith('n'),
  )
  const far = nodes.filter((n) => n.id.startsWith('far'))

  // Press: pin the hub exactly as onDown does.
  held = hub
  hub.fx = hub.x
  hub.fy = hub.y
  setHolding(true)
  /**
   * `alphaTarget` only — deliberately NOT `.restart()`.
   *
   * `restart()` starts d3's internal timer, which in node is a setTimeout loop
   * that keeps the event loop alive and never returns. The app calls it
   * because the app wants the simulation to drive itself; here the harness
   * drives it, one `tick()` at a time, which is also the only way to measure
   * per-tick displacement at all.
   *
   * `tick()` advances alpha toward alphaTarget on its own, so the energy
   * profile still matches the app's.
   */
  sim.alphaTarget(tuning.alpha)

  const prev = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
  const angleOf = (n) => Math.atan2(n.y - hub.y, n.x - hub.x)
  let prevAngles = oneHop.map(angleOf)

  let maxTwoHopStep = 0
  let maxFarStep = 0
  const twoHopSteps = []
  const angleRates = []

  for (let t = 0; t < holdTicks; t++) {
    sim.tick()

    for (const n of twoHop) {
      const p = prev.get(n.id)
      const step = Math.hypot(n.x - p.x, n.y - p.y)
      // The first ticks are the ring engaging; that transient is expected and
      // is not what "wig out" describes. Steady state is what the user sees
      // while they keep holding.
      if (t >= warmup) {
        maxTwoHopStep = Math.max(maxTwoHopStep, step)
        twoHopSteps.push(step)
      }
    }
    for (const n of far) {
      const p = prev.get(n.id)
      if (t >= warmup) maxFarStep = Math.max(maxFarStep, Math.hypot(n.x - p.x, n.y - p.y))
    }
    for (const n of nodes) prev.set(n.id, { x: n.x, y: n.y })

    if (t >= warmup) {
      const angles = oneHop.map(angleOf)
      const deltas = angles.map((a, i) => {
        let d = a - prevAngles[i]
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        return d
      })
      angleRates.push(mean(deltas))
      prevAngles = angles
    } else {
      prevAngles = oneHop.map(angleOf)
    }
  }

  const radii = oneHop.map((n) => Math.hypot(n.x - hub.x, n.y - hub.y))

  /**
   * Now DRAG the hub, which the static measurement above never does.
   *
   * Every calm metric improves monotonically as energy drops, so a harness
   * that only holds the node still will happily recommend alpha 0 — a hold
   * that damps the graph into concrete and scores perfectly on jitter. The
   * thing that breaks is the half of the interaction nobody was measuring:
   * neighbours are supposed to follow your hand.
   *
   * `follow` is what fraction of the hub's travel the ring came with. `leak`
   * is how much of it reached nodes two hops out, which is the same motion
   * seen from the other side — the press is meant to be local, so the gap
   * between them is the real quality of the effect.
   */
  const before = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
  const DRAG = 250
  const DRAG_TICKS = 120
  for (let t = 0; t < DRAG_TICKS; t++) {
    hub.fx = hub.x = (before.get('hub').x + (DRAG * (t + 1)) / DRAG_TICKS)
    sim.tick()
  }
  const moved = (n) => Math.hypot(n.x - before.get(n.id).x, n.y - before.get(n.id).y)
  const follow = mean(oneHop.map(moved)) / DRAG
  const leak = mean(twoHop.map(moved)) / DRAG

  sim.stop()
  return {
    follow,
    leak,
    selectivity: leak > 1e-6 ? follow / leak : Infinity,
    /**
     * Coefficient of variation, not raw stddev.
     *
     * Raw stddev is a trap here: a change that pushes the whole ring further
     * out raises stddev without making it any less circular, and that is
     * exactly what the first candidate did — stddev 9.9 -> 14.0 while CV sat
     * at 6.3% -> 6.4%. CV is scale-free, so it answers the question actually
     * being asked ("is it a compass circle?") rather than a proxy for it.
     */
    radiusCv: stddev(radii) / (mean(radii) || 1),
    radiusStddev: stddev(radii),
    radiusMean: mean(radii),
    radiusMin: Math.min(...radii),
    radiusMax: Math.max(...radii),
    maxTwoHopStep,
    meanTwoHopStep: mean(twoHopSteps),
    maxFarStep,
    // rad/tick -> rad/s at 60fps, and seconds per revolution.
    radPerTick: mean(angleRates),
    secondsPerRev: Math.abs(mean(angleRates)) > 1e-9
      ? (2 * Math.PI) / (Math.abs(mean(angleRates)) * 60)
      : Infinity,
    collisions: countOverlaps(nodes),
  }
}

/**
 * Nodes physically inside each other.
 *
 * Included because one of the two rejected approaches (kinematic placement)
 * silently opted neighbours out of forceCollide and they passed through each
 * other. Any future attempt that does the same will show up here rather than
 * being caught by eye three days later.
 */
export function countOverlaps(nodes) {
  let n = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const need = radius(a) + radius(b)
      if (Math.hypot(a.x - b.x, a.y - b.y) < need * 0.9) n++
    }
  }
  return n
}

