/**
 * Prints the hold-to-orbit comparison table used to tune `HOLD`.
 *
 * Run:  node --experimental-strip-types --no-warnings bench/orbit.mjs
 *
 * The acceptance bar itself is asserted in `test/graph-orbit.test.mjs`; this
 * file is for exploring, so it is free to add and drop rows.
 */

import { LEGACY_HOLD, HOLD } from '../src/renderer/panes/vault/graphPhysics.ts'
import { measure } from './orbitHarness.mjs'

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '∞')

/**
 * One lever at a time, off the legacy baseline.
 *
 * Shipping five changes together and reporting that the result is better says
 * nothing about which of them mattered — and leaves four unexamined values in
 * the codebase forever. Each row below differs from LEGACY in exactly one
 * field, so any movement is attributable.
 */
const only = (patch) => ({ ...LEGACY_HOLD, ...patch })
/** Shape/calm levers that earned their place in round one, minus linkStrength. */
const KEEP = { jitter: true, onlyLengthen: true, orbitRate: 0 }
const rows = [
  ['LEGACY (was)', measure(LEGACY_HOLD)],
  ['HOLD (shipped)', measure(HOLD)],
  ['HOLD (rerun)', measure(HOLD)],
  ['+jitter only', measure(only({ jitter: true }))],
  ['+alpha .16 only', measure(only({ alpha: 0.16 }))],
  ['+vDecay .62 only', measure(only({ velocityDecay: 0.62 }))],
]

const W = 19
console.log('\nHold-to-orbit — irregular hub, 12 neighbours (0-12 leaves each)\n')
console.log(['metric'.padEnd(26), ...rows.map(([n]) => n.padStart(W))].join(''))
console.log('-'.repeat(26 + W * rows.length))
const metrics = [
  ['ring radius CV      (%)', (r) => fmt(r.radiusCv * 100, 1)],
  ['ring radius mean   (px)', (r) => fmt(r.radiusMean, 1)],
  ['ring min/max       (px)', (r) => `${fmt(r.radiusMin, 0)}/${fmt(r.radiusMax, 0)}`],
  ['2-hop max step (px/tick)', (r) => fmt(r.maxTwoHopStep, 3)],
  ['2-hop mean     (px/tick)', (r) => fmt(r.meanTwoHopStep, 4)],
  ['far cluster max(px/tick)', (r) => fmt(r.maxFarStep, 4)],
  ['rotation      (rad/tick)', (r) => fmt(r.radPerTick, 5)],
  ['sec/revolution', (r) => fmt(r.secondsPerRev, 0)],
  ['overlapping pairs', (r) => String(r.collisions)],
  ['DRAG follow  (1-hop)', (r) => fmt(r.follow, 3)],
  ['DRAG leak    (2-hop)', (r) => fmt(r.leak, 3)],
  ['DRAG selectivity', (r) => fmt(r.selectivity, 2)],
]
for (const [label, get] of metrics) {
  console.log([label.padEnd(26), ...rows.map(([, r]) => get(r).padStart(W))].join(''))
}
console.log(
  '\nCV higher = less circular · 2-hop and far lower = calmer · overlaps must stay 0\n',
)
