/**
 * Prints what the graph does after you let go of a node.
 *
 * Run:  node --experimental-strip-types --no-warnings bench/release.mjs
 *
 * Companion to `bench/orbit.mjs`, which measures the hold. This one measures
 * the frames after it. Nothing measured them before, which is the whole reason
 * the fling survived: `orbitHarness.measure()` calls `sim.stop()` on the frame
 * the drag ends, so every number in that table describes a gesture still in
 * progress.
 *
 * The bar this has to clear is Nathan's report: "click drag let go, click drag
 * let go, it flings it really badly". So the interesting row is not one
 * gesture, it is six of them in a row.
 */

import {
  HOLD,
  VELOCITY_DECAY_NORMAL,
  RELEASE_ALPHA_REF,
  RELEASE_ALPHA_FULL,
  RELEASE_RAMP_TICKS,
} from '../src/renderer/panes/vault/graphPhysics.ts'
import { measureRelease } from './releaseHarness.mjs'

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '∞')

/**
 * The release as it behaved before the fix, reconstructed rather than
 * remembered: rest lengths back, damping back, driving stopped, and nothing
 * else. Kept so the table can prove the change instead of asserting it, the
 * same reason `LEGACY_HOLD` exists next door.
 */
const LEGACY_RELEASE = {
  onRelease: ({ sim, refresh }) => {
    refresh()
    sim.velocityDecay(VELOCITY_DECAY_NORMAL)
    sim.alphaTarget(0)
  },
  // Present and empty on purpose: it REPLACES the shipped ramp, which is what
  // makes this row the old behaviour rather than the old behaviour plus half
  // the fix.
  onTick: () => {},
}

/** The gestures. Quick ones are the bug; the long ones guard the cure. */
const CASES = [
  ['1 quick', { gestures: 1 }],
  ['3 quick', { gestures: 3 }],
  ['6 quick', { gestures: 6 }],
  ['12 quick', { gestures: 12 }],
  ['1 slow 80px', { gestures: 1, dragTicks: 60, dragPx: 80 }],
  ['drop onto a node', { gestures: 1, dragTicks: 60, dragPx: -100 }],
]

const W = 20
console.log('\nRelease — press, drag, let go. Motion AFTER the pointer is up.\n')
console.log(
  'gesture'.padEnd(20) +
    'before'.padStart(W) +
    'now'.padStart(W) +
    'change'.padStart(W) +
    '   overlaps',
)
console.log('-'.repeat(20 + W * 3 + 12))

for (const [label, opts] of CASES) {
  const before = measureRelease(HOLD, { ...opts, ...LEGACY_RELEASE })
  const now = measureRelease(HOLD, opts)
  const ratio = now.hubPeak > 1e-9 ? before.hubPeak / now.hubPeak : Infinity
  console.log(
    label.padEnd(20) +
      `${fmt(before.hubPeak)} / ${fmt(before.hubTravel, 1)}px`.padStart(W) +
      `${fmt(now.hubPeak)} / ${fmt(now.hubTravel, 1)}px`.padStart(W) +
      `${fmt(ratio, 1)}x calmer`.padStart(W) +
      `   ${before.overlaps} -> ${now.overlaps}`,
  )
}

console.log(
  '\npeak px/tick of the node you let go of  /  how far it wandered after you did',
)
console.log(
  `release alpha scales to ${RELEASE_ALPHA_FULL} over ${RELEASE_ALPHA_REF}px of travel;` +
    ` damping ramped ${HOLD.velocityDecay} -> ${VELOCITY_DECAY_NORMAL} over ${RELEASE_RAMP_TICKS} ticks.`,
)
console.log(
  'Overlaps must stay 0: a release that cools the graph must still let',
  'forceCollide separate a node dropped on top of another.\n',
)
