/**
 * The acceptance bar for LETTING GO of a node, as assertions.
 *
 * Sibling of `graph-orbit.test.mjs`, which covers the hold. The hold was
 * measured, tuned and asserted; the release was not measured at all, because
 * `orbitHarness.measure()` calls `sim.stop()` on the frame the drag ends. Every
 * number that existed described a gesture still in progress, so the frames
 * after the pointer came up were free to do anything, and they did.
 *
 * Nathan: *"if you click, drag, let go, click drag let go, it flings it really
 * badly"*. Two causes, both measured in `bench/release.mjs`:
 *
 *   1. Alpha ratcheted. A press drives energy to `HOLD.alpha` and a release
 *      only stopped DRIVING, so heat outlived the gesture and the next press
 *      added its own on top. Six quick gestures: 0 -> 0.056.
 *   2. Damping snapped back. `velocityDecay` 0.62 -> 0.4 in one frame, which
 *      is a 58% jump in retained velocity delivered exactly when the
 *      neighbourhood was carrying the most.
 *
 * Thresholds are loose around the measured values, for the reason stated in
 * `graph-orbit.test.mjs`: they exist to catch a regression that undoes the
 * fix, not to pin the tuning against someone retuning on evidence.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  HOLD,
  VELOCITY_DECAY_NORMAL,
  RELEASE_ALPHA_CAP,
} from '../src/renderer/panes/vault/graphPhysics.ts'
import { measureRelease } from '../bench/releaseHarness.mjs'

/**
 * The release as it behaved before the fix. Reconstructed rather than
 * remembered, so these tests compare against something real and keep working
 * if the shipped values move.
 */
const LEGACY_RELEASE = {
  onRelease: ({ sim, refresh }) => {
    refresh()
    sim.velocityDecay(VELOCITY_DECAY_NORMAL)
    sim.alphaTarget(0)
  },
  onTick: () => {},
}

const quick = (gestures, extra = {}) => measureRelease(HOLD, { gestures, ...extra })
const slow = (extra = {}) =>
  measureRelease(HOLD, { gestures: 1, dragTicks: 60, dragPx: 80, ...extra })

test('letting go of a node does not throw it', () => {
  const now = quick(1)
  /**
   * 0.05px/tick, not the 0.25 that "stops reading as moving" would suggest.
   *
   * The looser bound was measured and thrown away: the OLD behaviour peaks at
   * 0.101px/tick on a single gesture, so a 0.25 bar passes the bug and only
   * the repeat case would have caught it. A threshold the broken code
   * satisfies is not a threshold. The bar sits between the two measured
   * values, with 4x of margin on the fixed one.
   */
  assert.ok(
    now.hubPeak < 0.05,
    `released node peaked at ${now.hubPeak.toFixed(3)}px/tick, must stay under 0.05`,
  )
  assert.ok(
    now.hubTravel < 2,
    `released node wandered ${now.hubTravel.toFixed(1)}px from where it was dropped`,
  )
})

test('repeated quick gestures do not accumulate energy', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * One gesture was always survivable; the bug was that six of them were six
   * times worse. What is asserted is the SHAPE — that repeating the gesture
   * does not multiply the result — because a fix that merely made one release
   * calmer would leave the ratchet in place and pass a single-gesture test.
   */
  const one = quick(1)
  const six = quick(6)
  const twelve = quick(12)

  assert.ok(
    six.hubPeak < 0.25,
    `six quick gestures peaked at ${six.hubPeak.toFixed(3)}px/tick`,
  )
  assert.ok(
    twelve.hubTravel < 12,
    `twelve quick gestures moved the node ${twelve.hubTravel.toFixed(1)}px after release`,
  )
  assert.ok(
    six.hubPeak < one.hubPeak * 8,
    `energy is compounding across gestures: 1 -> ${one.hubPeak.toFixed(3)}, ` +
      `6 -> ${six.hubPeak.toFixed(3)}px/tick`,
  )
})

test('the fix is a large improvement on the behaviour it replaced', () => {
  for (const gestures of [1, 6]) {
    const before = quick(gestures, LEGACY_RELEASE)
    const now = quick(gestures)
    assert.ok(
      now.hubPeak < before.hubPeak / 4,
      `${gestures} gesture(s): must be at least 4x calmer than before ` +
        `(${before.hubPeak.toFixed(3)} -> ${now.hubPeak.toFixed(3)}px/tick)`,
    )
  }
})

test('a long drag is placed where it was dropped, not carried onward', () => {
  // The case that used to be worst: 3.055px/tick and 49px of travel after an
  // 80px drag, which is the node continuing more than half the gesture again
  // on its own.
  const now = slow()
  const before = slow(LEGACY_RELEASE)
  assert.ok(
    now.hubTravel < 10,
    `an 80px drag carried the node a further ${now.hubTravel.toFixed(1)}px`,
  )
  assert.ok(now.hubPeak < before.hubPeak / 4, 'long drags must be calmer too')
})

test('cooling the graph does not freeze overlapping nodes together', () => {
  /**
   * The guard on the cure.
   *
   * Capping alpha at release is only safe while the layout can still resolve a
   * node dropped on top of another. `RELEASE_ALPHA_CAP` is five times d3's
   * `alphaMin`, so the simulation keeps running for roughly 70 ticks after a
   * gesture — enough for `forceCollide` to separate them. A cap low enough to
   * stop the simulation dead would pass every assertion above and leave nodes
   * inside each other.
   */
  assert.ok(RELEASE_ALPHA_CAP > 0.001, 'the cap must stay above d3 alphaMin')
  for (const r of [quick(1), quick(6), slow(), measureRelease(HOLD, {
    gestures: 1,
    dragTicks: 60,
    dragPx: -100,
  })]) {
    assert.equal(r.overlaps, 0, 'nodes were left physically inside each other')
  }
})

test('the bars above would have caught the bug they were written for', () => {
  /**
   * The test that tests the tests.
   *
   * Every threshold in this file was chosen against two measurements, and a
   * threshold is only worth having if the broken behaviour fails it. Asserting
   * that here means a future loosening — someone nudging 0.05 to 0.25 to make
   * a flaky run go green — breaks this instead of silently disarming the file.
   *
   * It reconstructs the old release rather than reverting the module, so it
   * keeps working without a second copy of the physics to point at.
   */
  const beforeOne = quick(1, LEGACY_RELEASE)
  const beforeSix = quick(6, LEGACY_RELEASE)

  assert.ok(
    beforeOne.hubPeak >= 0.05 || beforeOne.hubTravel >= 2,
    'the single-gesture bar no longer rejects the behaviour it was written to reject ' +
      `(old: ${beforeOne.hubPeak.toFixed(3)}px/tick, ${beforeOne.hubTravel.toFixed(1)}px)`,
  )
  assert.ok(
    beforeSix.hubPeak >= 0.25,
    'the repeat-gesture bar no longer rejects the ratchet ' +
      `(old: ${beforeSix.hubPeak.toFixed(3)}px/tick)`,
  )
})

test('the ring is still where the hold put it', () => {
  // A release that flung nothing because it destroyed the layout would pass
  // every test above. The neighbourhood must still be a neighbourhood.
  const now = quick(6)
  assert.ok(
    now.ringRadius > 40 && now.ringRadius < 220,
    `ring radius ${now.ringRadius.toFixed(1)}px is not a plausible layout`,
  )
})
