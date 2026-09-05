/**
 * Headless measurement of what happens AFTER the pointer comes up.
 *
 * `orbitHarness.mjs` measures the hold and the drag, then calls `sim.stop()`
 * on the frame the drag ends. Everything the user sees next — the ring
 * unloading, the held node being reclaimed by forces it was shielded from a
 * moment ago — happens in ticks that harness never runs. That is the whole
 * reason the fling shipped: it is not that the number was wrong, it is that
 * there was no number.
 *
 * The gesture reproduced here is Nathan's, and it is deliberately a SMALL one:
 * press, move a few pixels, let go. A long slow drag hides this, because the
 * ring has time to reach the radius the hold asks for and the springs are no
 * longer loaded when you release. The fling belongs to the quick gesture.
 *
 * Imports the app's real physics. A release measured against a second copy of
 * the simulation would be worth nothing, for the same reason stated in
 * `orbitHarness.mjs`.
 */

import {
  buildSimulation,
  HOLD,
} from '../src/renderer/panes/vault/graphPhysics.ts'
import { makeGraph, mean, countOverlaps } from './orbitHarness.mjs'

/**
 * One or more press-drag-release gestures, then watch the graph come to rest.
 *
 * `gestures > 1` is the case Nathan described as much worse: "click drag let
 * go, click drag let go". Each press re-loads the ring while the previous
 * release is still unloading, so the question is whether energy accumulates
 * across gestures or each one is independent.
 *
 * @param tuning      a HoldTuning, as `buildSimulation` takes.
 * @param dragPx      how far the pointer travels. Small on purpose.
 * @param dragTicks   how long it is held. Short on purpose.
 * @param gapTicks    ticks between one release and the next press.
 * @param gestures    how many press-drag-release cycles to run.
 * @param afterTicks  how long to watch after the LAST release.
 * @param onRelease   optional hook, so a candidate fix can be measured without
 *                    being committed to the physics module first.
 * @param onPress     optional hook fired the instant the node is pinned, so a
 *                    candidate can snapshot state the release wants to undo.
 * @param onTick      optional per-tick hook, called with the number of ticks
 *                    since the last release. A ramped fix needs this: the
 *                    thing being measured is a value that changes over the
 *                    frames after the gesture, not one that changes at it.
 */
export function measureRelease(
  tuning = HOLD,
  {
    dragPx = 8,
    dragTicks = 6,
    gapTicks = 6,
    gestures = 1,
    afterTicks = 240,
    onRelease = null,
    onPress = null,
    onTick = null,
  } = {},
) {
  const { nodes, links, byId } = makeGraph()

  let held = null
  const adjacency = new Map()
  const connect = (a, b) => {
    const l = adjacency.get(a.id)
    if (l) l.push(b)
    else adjacency.set(a.id, [b])
  }

  const { sim, setHolding, stepRelease, refresh } = buildSimulation(
    nodes,
    links,
    () => held,
    () => adjacency,
    tuning,
  )
  for (const l of links) {
    connect(l.source, l.target)
    connect(l.target, l.source)
  }

  // Equilibrium first. The user presses on a graph that is sitting still, so
  // any motion measured below was produced by the gesture and nothing else.
  sim.stop()
  for (let i = 0; i < 600; i++) sim.tick()

  /** Ticks since the most recent release. Drives a ramped candidate. */
  let sinceRelease = 0

  const hub = byId.get('hub')
  const oneHop = adjacency.get('hub')
  const oneHopIds = new Set(oneHop.map((n) => n.id))
  const twoHop = nodes.filter(
    (n) => n.id !== 'hub' && !oneHopIds.has(n.id) && n.id.startsWith('n'),
  )

  /** Largest single-tick step anywhere in a set, over a window of ticks. */
  const stepper = () => {
    const prev = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
    return {
      sample(set) {
        let max = 0
        for (const n of set) {
          const p = prev.get(n.id)
          max = Math.max(max, Math.hypot(n.x - p.x, n.y - p.y))
        }
        return max
      },
      commit() {
        for (const n of nodes) prev.set(n.id, { x: n.x, y: n.y })
      },
    }
  }

  for (let g = 0; g < gestures; g++) {
    // Press, exactly as `onDown` does it.
    held = hub
    hub.fx = hub.x
    hub.fy = hub.y
    setHolding(true)
    if (onPress) onPress({ sim, setHolding, hub, tuning })
    sim.alphaTarget(tuning.alpha)

    // Drag, exactly as `onMove` does it: fx follows the pointer, nothing else.
    const startX = hub.x
    const startY = hub.y
    for (let t = 0; t < dragTicks; t++) {
      hub.fx = hub.x = startX + (dragPx * (t + 1)) / dragTicks
      sim.tick()
    }

    // Release, exactly as `finish` does it.
    hub.fx = null
    hub.fy = null
    held = null
    if (onRelease) onRelease({ sim, setHolding, refresh, hub, oneHop, tuning })
    else {
      // The distance the node actually travelled, exactly as `finish` measures
      // it. The release prices its leftover energy on this — a harness that
      // passed nothing would measure a graph that always goes cold, which is
      // the bug this argument exists to fix.
      setHolding(false, Math.hypot(hub.x - startX, hub.y - startY))
      sim.alphaTarget(0)
    }
    // Reset on every release, not just the last: a ramp that has not finished
    // when the next press lands is exactly the case that pumps energy, and
    // the fix has to be measured under it.
    sinceRelease = 0

    if (g < gestures - 1) {
      for (let t = 0; t < gapTicks; t++) {
        if (onTick) onTick({ sim, since: sinceRelease })
        else stepRelease()
        sim.tick()
        sinceRelease++
      }
    }
  }

  // Watch it come to rest.
  const restX = hub.x
  const restY = hub.y
  const step = stepper()
  let hubPeak = 0
  let ringPeak = 0
  let twoHopPeak = 0
  let hubFar = 0
  let settle = afterTicks

  for (let t = 0; t < afterTicks; t++) {
    // `onTick` REPLACES the app's own ramp rather than running alongside it,
    // so a candidate under test is measured instead of stacked on the shipped
    // behaviour. With no hook, this is the real `stepRelease` from the frame
    // loop and the numbers below are the app's.
    if (onTick) onTick({ sim, since: sinceRelease })
    else stepRelease()
    sim.tick()
    sinceRelease++
    const h = step.sample([hub])
    const r = step.sample(oneHop)
    const k = step.sample(twoHop)
    step.commit()
    hubPeak = Math.max(hubPeak, h)
    ringPeak = Math.max(ringPeak, r)
    twoHopPeak = Math.max(twoHopPeak, k)
    hubFar = Math.max(hubFar, Math.hypot(hub.x - restX, hub.y - restY))
    // "At rest" = nothing in the neighbourhood moves a visible amount. A
    // quarter pixel per tick is 15px/s, which reads as still.
    if (Math.max(h, r) < 0.25 && settle === afterTicks) settle = t
  }

  sim.stop()
  return {
    /** Peak speed of the node you let go of, px/tick. This IS the fling. */
    hubPeak,
    /** Peak speed of its direct neighbours, px/tick. */
    ringPeak,
    /** Peak speed two hops out — motion that should never have travelled. */
    twoHopPeak,
    /** How far the released node wandered from where you dropped it, px. */
    hubTravel: hubFar,
    /** Ticks until the neighbourhood is visually still. 60 = one second. */
    settleTicks: settle,
    /** Mean ring radius at rest, to confirm the layout is not just destroyed. */
    ringRadius: mean(oneHop.map((n) => Math.hypot(n.x - hub.x, n.y - hub.y))),
    /**
     * Nodes still physically inside each other once everything has stopped.
     *
     * The check that stops a fling fix from going too far: cooling the graph
     * at release is only allowed if the layout can still resolve a node
     * dropped on top of another. A cure that freezes overlaps in place is a
     * different bug, not a fix.
     */
    overlaps: countOverlaps(nodes),
  }
}
