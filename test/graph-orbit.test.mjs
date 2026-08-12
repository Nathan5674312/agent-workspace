/**
 * The acceptance bar for hold-to-orbit, as assertions.
 *
 * This exists because the hold was tuned by eye twice and shipped wrong twice.
 * Nathan's complaint was three separate things — *"the orbit is still too
 * strong, all of the related nodes are in a perfect circle which causes friend
 * of friend nodes not directly related to the one the user clicks to wig out
 * and be really glitchy"* — and every one of them is a number, so every one of
 * them is checked here rather than looked at.
 *
 * It measures the app's real simulation via `graphPhysics.ts`, through the
 * same harness `bench/orbit.mjs` prints from. Nothing is re-implemented; a
 * threshold measured against a second copy of the layout would be worth
 * nothing.
 *
 * Thresholds are deliberately loose around the measured values. They are here
 * to catch a regression that undoes the fix, not to pin the tuning — someone
 * retuning on evidence should be able to move the numbers without a test
 * telling them not to.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { LEGACY_HOLD, HOLD } from '../src/renderer/panes/vault/graphPhysics.ts'
import { measure } from '../bench/orbitHarness.mjs'

const now = measure(HOLD)
const before = measure(LEGACY_HOLD)

test('two-hop nodes stay essentially still during a hold', () => {
  /**
   * The bound is a perception threshold, not a preference: below ~1px per
   * frame a small dot does not read as moving at 60fps. Above it, it shimmers,
   * which is exactly the "wig out" being fixed.
   */
  assert.ok(
    now.maxTwoHopStep < 1.0,
    `2-hop max step ${now.maxTwoHopStep.toFixed(3)}px/tick must stay under 1.0`,
  )
  assert.ok(
    now.maxTwoHopStep < before.maxTwoHopStep / 3,
    `2-hop jitter must be at least 3x better than legacy ` +
      `(${before.maxTwoHopStep.toFixed(3)} -> ${now.maxTwoHopStep.toFixed(3)})`,
  )
})

test('a hold does not disturb nodes with no path to the held node', () => {
  // The detached cluster cannot be affected by the hold through any link, so
  // anything it does is the whole-graph reheat leaking out.
  assert.ok(
    now.maxFarStep < 0.6,
    `unrelated cluster moved ${now.maxFarStep.toFixed(4)}px/tick`,
  )
  assert.ok(now.maxFarStep < before.maxFarStep / 2, 'far cluster must be calmer than legacy')
})

test('the ring is uneven, not a compass circle', () => {
  /**
   * Coefficient of variation, not raw stddev.
   *
   * Raw stddev rises whenever the ring is pushed further out, whether or not
   * it became any less circular — an earlier candidate scored 9.9 -> 14.0 on
   * stddev while CV sat still at 6.3% -> 6.4%, and would have shipped as a fix
   * that fixed nothing. CV is scale-free and answers the question asked.
   */
  assert.ok(now.radiusCv > 0.25, `ring CV ${(now.radiusCv * 100).toFixed(1)}% must exceed 25%`)
  assert.ok(now.radiusCv > before.radiusCv, 'ring must be less circular than legacy')
})

test('the hold stays local — the ring follows, the rest does not', () => {
  // Selectivity is follow/leak: how much more the direct neighbourhood moves
  // with your hand than the nodes behind it. Legacy sat at 1.41, i.e. 2-hop
  // nodes came along almost as much as 1-hop ones, which is the complaint.
  assert.ok(
    now.selectivity > 2.0,
    `drag selectivity ${now.selectivity.toFixed(2)} must exceed 2.0`,
  )
  assert.ok(now.selectivity > before.selectivity, 'must be more local than legacy')
  // And the neighbourhood must still respond at all — every calm metric
  // improves monotonically as energy drops, so without this the bar is
  // trivially satisfied by damping the graph into concrete.
  assert.ok(now.follow > 0.15, `ring follow ${now.follow.toFixed(3)} is too dead`)
})

test('the hold never pushes nodes through each other', () => {
  /**
   * Guards the second of the two rejected approaches. Kinematic placement —
   * overwriting neighbour x/y each tick — gave exact control over the ring and
   * silently opted those nodes out of forceCollide, so they passed through one
   * another. It was caught by eye; it should not have to be again.
   */
  assert.equal(now.collisions, 0, 'nodes overlap during the hold')
})

test('the measurement is deterministic', () => {
  // A flaky harness would make every threshold above meaningless.
  const again = measure(HOLD)
  assert.equal(again.maxTwoHopStep, now.maxTwoHopStep)
  assert.equal(again.radiusCv, now.radiusCv)
  assert.equal(again.selectivity, now.selectivity)
})
