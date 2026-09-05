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
  RELEASE_ALPHA_FULL,
  releaseAlpha,
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

test('a long drag settles smoothly instead of being flung', () => {
  /**
   * THIS ASSERTION USED TO BE WRONG, and it is worth saying how.
   *
   * It read `hubTravel < 10` — "a long drag is placed where it was dropped".
   * That was written while the release capped alpha flat, when a node stayed
   * exactly where it was dropped because the simulation had gone cold. The test
   * therefore encoded the STRANDING BUG as the desired behaviour, and would
   * have blocked the fix for it.
   *
   * Travel after a long drag is not the defect. A node dragged 80px away from
   * its links SHOULD be pulled back; that is what a force layout is. The defect
   * is the SPEED and the failure to stop:
   *
   *     peak px/tick   travel   settles in
   *     legacy   3.055     49px    37 ticks
   *     now      0.651     31px    48 ticks
   *
   * So the bar is peak speed and coming to rest, not distance.
   */
  const now = slow()
  const before = slow(LEGACY_RELEASE)

  assert.ok(
    now.hubPeak < before.hubPeak / 3,
    `an 80px drag peaked at ${now.hubPeak.toFixed(3)}px/tick against ` +
      `${before.hubPeak.toFixed(3)} before — it is being flung, not settling`,
  )
  // It must actually STOP. A node still moving when the window closes is either
  // orbiting or drifting, and both read as the graph never coming to rest.
  assert.ok(
    now.settleTicks < 240,
    `the neighbourhood was still moving after ${now.settleTicks} ticks`,
  )
  // And it must not overshoot past the gesture that caused it.
  assert.ok(
    now.hubTravel < 80,
    `the node travelled ${now.hubTravel.toFixed(1)}px after an 80px drag`,
  )
})

test('cooling the graph does not freeze overlapping nodes together', () => {
  /**
   * The guard on the cure.
   *
   * Cooling at release is only safe while the layout can still resolve a node
   * dropped on top of another. A real drag must leave the simulation above d3's
   * `alphaMin` or nothing moves afterwards at all — which is precisely the
   * regression the flat cap shipped, and which the next test now guards
   * directly.
   */
  assert.ok(
    releaseAlpha(260) > 0.001,
    'a real drag must leave the simulation above d3 alphaMin, or it cannot settle',
  )
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

test('A DRAGGED NODE IS NOT STRANDED — the layout relaxes after you let go', () => {
  /**
   * THE REGRESSION THE FIRST FIX SHIPPED, and the reason `releaseAlpha` scales
   * instead of being a constant.
   *
   * Nathan: *"when you drag and move a node it stays like this until another
   * node is grabbed and moved then it goes back to place"*. The flat 0.005 cap
   * left the simulation barely above `alphaMin`, so a node dragged somewhere
   * its links could not reach simply stayed there — and the NEXT press reheated
   * the graph and snapped the whole neighbourhood into position at once, which
   * reads as the app undoing your drag a minute later.
   *
   * Every other assertion in this file passed throughout. They all measure how
   * LITTLE moves after a release, and a frozen graph is the perfect score on
   * every one of them. That is the trap: an acceptance bar with only one
   * direction rewards going too far in it. This is the opposite bound.
   */
  const stretch = (dragPx) => {
    const r = measureRelease(HOLD, { gestures: 1, dragTicks: 40, dragPx, afterTicks: 400 })
    return r
  }
  // A long drag pulls the held node far from its links; they must pull back.
  const far = stretch(260)
  assert.ok(
    far.ringRadius < 160,
    `after a 260px drag the ring settled at ${far.ringRadius.toFixed(1)}px — ` +
      'the node was left stranded, its links never relaxed',
  )
  /**
   * And the graph must still be WARM enough to do it. A drag of the reference
   * distance earns the full budget; a three-pixel twitch earns nearly nothing,
   * which is what stops repeated taps from ratcheting.
   */
  assert.ok(releaseAlpha(260) >= RELEASE_ALPHA_FULL * 0.9, 'a long drag earns no energy')
  assert.ok(releaseAlpha(3) < 0.01, 'a twitch earns enough energy to ratchet')
  assert.equal(releaseAlpha(0), 0, 'a press that moved nothing must leave nothing')
  assert.equal(releaseAlpha(10_000), RELEASE_ALPHA_FULL, 'the budget has no ceiling')
})
