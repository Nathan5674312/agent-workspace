/**
 * Release velocity, and the stationary hand it used to fling.
 *
 * Nathan's report: the graph flings the camera on release even when the hand
 * had stopped moving. That is not a graph bug — GraphView hands `VelocityTracker`
 * every pointer position and asks it one question at release — so the whole
 * defect fits in this file, and so does the proof.
 *
 * THE MECHANISM, because it is the part that is easy to get wrong twice. A
 * pointer that is not moving emits no `pointermove`. So a hand that drags fast
 * and then holds still leaves a history that ENDS while it was still moving, and
 * nothing in that history records the stop. Measuring across the samples' own
 * span therefore reports the mid-drag speed forever: the longer you hold, the
 * more wrong it gets, which is the opposite of what the reading should do.
 *
 * These are unit tests on the real class rather than a source regex, for the
 * reason canvas-groupfit.test.mjs records at length: the lines that compute this
 * were all present and correct-looking while the behaviour was wrong, and only
 * running the arithmetic can tell you that. `add` and `velocity` both take an
 * explicit clock, so every case below states its own timeline instead of racing
 * `performance.now()`.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { VelocityTracker, project } = await import('../src/renderer/motion.ts')

/** The default window, mirrored so the timelines below read. */
const WINDOW = 100

/**
 * A hand moving at a steady `pxPerSec` along x, sampled every `stepMs`, ending
 * at t = `untilMs`. Returns the tracker and the position it stopped at.
 */
const drag = (pxPerSec, untilMs = 200, stepMs = 10) => {
  const v = new VelocityTracker()
  for (let t = 0; t <= untilMs; t += stepMs) v.add((pxPerSec * t) / 1000, 0, t)
  return v
}

// ── the reading while the hand is still moving ────────────────────

test('a hand still moving reports the speed it is moving at', () => {
  const v = drag(1000)
  // Released one frame after the last sample, which is the normal case: the
  // pointerup follows the final pointermove almost immediately.
  const { vx, vy } = v.velocity(208)
  assert.ok(Math.abs(vx - 1000) < 120, `expected about 1000 px/s, got ${vx}`)
  assert.equal(vy, 0)
})

test('both axes are measured, not just the one that moved', () => {
  const v = new VelocityTracker()
  for (let t = 0; t <= 200; t += 10) v.add(t * 0.5, -t * 0.25, t)
  const { vx, vy } = v.velocity(202)
  assert.ok(vx > 400 && vx < 520, `vx ${vx}`)
  assert.ok(vy < -200 && vy > -260, `vy ${vy}`)
})

// ── the bug ───────────────────────────────────────────────────────

test('a hand that stopped a whole window before release reports nothing', () => {
  // THE REPORTED BUG, in one assertion. The drag ends at t=200 having moved at
  // 1000 px/s; the hand then rests, emitting nothing, and lets go at t=320.
  // Across the samples' own span this still reads 1000 px/s and the graph
  // leaves at full speed from a hand that had been parked for over a tenth of
  // a second.
  const v = drag(1000)
  const { vx, vy } = v.velocity(200 + WINDOW + 20)
  assert.equal(vx, 0, 'a parked hand still reported a flick')
  assert.equal(vy, 0)
})

test('the longer the hand rests, the less is left of the flick', () => {
  // Monotone, and that is the property that makes it feel like physics rather
  // than a threshold: there is no instant at which the reading jumps.
  const at = (rest) => Math.abs(drag(1000).velocity(200 + rest).vx)
  const readings = [0, 20, 40, 60, 80, 100].map(at)
  for (let i = 1; i < readings.length; i++) {
    assert.ok(
      readings[i] < readings[i - 1],
      `resting longer reported MORE speed: ${readings[i - 1]} then ${readings[i]}`,
    )
  }
  assert.equal(readings.at(-1), 0, 'a full window of rest is not yet zero')
})

test('a pause mid-drag does not erase a flick that followed it', () => {
  // The complement of the case above, and the one a naive "did the last sample
  // arrive recently" guard gets wrong: the hand stalls, then flicks. What is
  // released is the flick.
  const v = new VelocityTracker()
  v.add(0, 0, 0)
  v.add(0, 0, 500) // held still for half a second
  for (let t = 510; t <= 560; t += 10) v.add((t - 500) * 2, 0, t)
  const { vx } = v.velocity(562)
  assert.ok(vx > 800, `the flick after the pause was swallowed: ${vx}`)
})

// ── the guards that were already there ────────────────────────────

test('one sample is not a velocity', () => {
  const v = new VelocityTracker()
  v.add(10, 10, 0)
  assert.deepEqual(v.velocity(2), { vx: 0, vy: 0 })
})

test('an empty tracker is not a velocity', () => {
  assert.deepEqual(new VelocityTracker().velocity(0), { vx: 0, vy: 0 })
})

test('clear() forgets the gesture', () => {
  const v = drag(1000)
  v.clear()
  assert.deepEqual(v.velocity(202), { vx: 0, vy: 0 })
})

test('a sub-millisecond span is noise, not a four-figure velocity', () => {
  // Two events a fraction of a millisecond apart divide a real displacement by
  // very nearly zero.
  const v = new VelocityTracker()
  v.add(0, 0, 0)
  v.add(3, 0, 0.4)
  assert.deepEqual(v.velocity(0.5), { vx: 0, vy: 0 })
})

// ── what the graph actually asks ──────────────────────────────────

test('the parked hand falls under the threshold GraphView glides on', () => {
  // GraphView honours a flick only when `project()` predicts more than 12px of
  // travel. This is the end-to-end statement of the bug: the same gesture,
  // released moving and released parked, on either side of that line.
  const moving = drag(1000).velocity(208)
  const parked = drag(1000).velocity(320)
  assert.ok(Math.hypot(project(moving.vx), project(moving.vy)) > 12, 'a real flick stopped gliding')
  assert.ok(
    Math.hypot(project(parked.vx), project(parked.vy)) <= 12,
    'a parked hand would still fling the camera',
  )
})
