/**
 * Motion primitives.
 *
 * Pure maths, no DOM, no colours, no dependencies. Everything here exists
 * because a CSS transition cannot do it: a transition runs a fixed curve for a
 * fixed duration from a fixed start, and every one of those three is wrong for
 * something the user is holding.
 *
 * The functions are Apple's, from the `Designing Fluid Interfaces` sample code,
 * not approximations of them. Two are load-bearing:
 *
 *   - `project()` answers "where is this flick GOING", so a release can animate
 *     to where the gesture was headed rather than to wherever the finger
 *     happened to lift. Note this is the exponential-decay form, NOT the
 *     physics-textbook v²/(2a) — they disagree, and scroll views ship this one.
 *
 *   - `rubberband()` answers "how far should it follow past the edge", so a
 *     boundary resists instead of stopping dead. A hard stop reads as frozen;
 *     progressive resistance reads as responsive-but-empty.
 *
 * `Decay` integrates the same curve `project()` predicts, so the glide lands
 * exactly where the projection said it would. That agreement is the point: if
 * the two drifted apart, a flick would visibly slide past its own target.
 */

/** Per-millisecond velocity retention. 0.998 is scroll feel; lower is snappier. */
export const DECELERATION = 0.998

/**
 * Where a flick comes to rest, given its release velocity in px/s.
 *
 * Returns a DISTANCE from the current position, signed with the velocity.
 */
export function project(velocity: number, decelerationRate = DECELERATION): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

/**
 * How far a surface follows the pointer once it is past its own boundary.
 *
 * `overshoot` is how far past the edge the pointer has gone, `dimension` the
 * size of the axis being dragged. The result is always smaller than the
 * overshoot and grows ever more slowly — real things slow before they stop.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

/**
 * Release velocity, in px/s, from a short history of pointer samples.
 *
 * A single delta between the last two events is unusable: pointer events are
 * noisy and often arrive a millisecond apart, so the last pair regularly
 * reports either zero or something absurd. Averaging over a short WINDOW is
 * what makes a flick read as the speed the hand actually had.
 *
 * The window is deliberately short. Over a long window a gesture that stopped
 * dead before release still reports the speed it had mid-drag, and the surface
 * flies away from a finger the user had already parked — the single most
 * common way velocity handoff feels broken.
 *
 * THE WINDOW ENDS AT `now`, NOT AT THE LAST SAMPLE, and that distinction is the
 * whole reason a stationary release used to fling.
 *
 * A pointer that is not moving emits no `pointermove`, so the sample history
 * simply STOPS. Measuring across the samples' own span then divides the travel
 * of a moving hand by the time that hand spent moving, and reports the mid-drag
 * speed no matter how long ago the drag ended — hold a graph still for a second
 * and let go, and it leaves at the speed it had a second earlier. Nothing in the
 * history says the hand stopped; the ABSENCE of history is what says it, and
 * only a clock reading at release can see that absence.
 *
 * So the divisor is `now - first.t` rather than `last.t - first.t`. The
 * stationary tail is charged to the measurement, which makes the reported speed
 * fall off smoothly as the hand rests and reach exactly zero once the whole
 * window is older than `now`.
 */
export class VelocityTracker {
  private samples: { x: number; y: number; t: number }[] = []

  private windowMs: number

  // Declared and assigned rather than a `private windowMs` parameter property.
  // Node runs this suite with --experimental-strip-types, which only ERASES
  // types; a parameter property needs an assignment emitted, so it throws
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at import and takes the whole run with it.
  constructor(windowMs = 100) {
    this.windowMs = windowMs
  }

  clear(): void {
    this.samples = []
  }

  add(x: number, y: number, t = performance.now()): void {
    this.samples.push({ x, y, t })
    const cutoff = t - this.windowMs
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift()
  }

  /**
   * px/s on each axis. Zero when there is not enough recent history to be sure.
   *
   * `now` defaults to the moment of the call, which for the only caller that
   * matters is the moment of release. It is a parameter so a test can state the
   * release time instead of racing the clock.
   */
  velocity(now = performance.now()): { vx: number; vy: number } {
    const cutoff = now - this.windowMs
    // `add` keeps a floor of two samples regardless of age, so the array is not
    // the window — the window is whichever of them are still recent.
    const at = this.samples.findIndex((s) => s.t >= cutoff)
    // Nothing inside the window, or a single point, is a hand that has been
    // still for at least a window. There is no flick to honour.
    if (at < 0 || at === this.samples.length - 1) return { vx: 0, vy: 0 }
    const first = this.samples[at]
    const last = this.samples[this.samples.length - 1]
    const dt = now - first.t
    // Sub-millisecond spans divide into noise and produce four-figure
    // velocities from a stationary hand.
    if (dt < 8) return { vx: 0, vy: 0 }
    return { vx: ((last.x - first.x) / dt) * 1000, vy: ((last.y - first.y) / dt) * 1000 }
  }
}

/**
 * An interruptible momentum glide.
 *
 * Interruptible is the whole reason this is a class and not a call to
 * `element.animate()`. Section 3 of the guidance calls it the single most
 * important principle: the user must be able to grab a moving thing at any
 * instant, and it must continue from where it VISUALLY is, not snap to wherever
 * a timeline thought it should be. `stop()` is therefore always safe to call
 * mid-flight, and the caller keeps whatever position the last frame produced.
 *
 * Velocity decays per frame by the same rate `project()` assumes, so a glide
 * started with velocity v travels `project(v)` and stops.
 */
export class Decay {
  private raf = 0
  private running = false

  private decelerationRate: number

  // Same reason as VelocityTracker's: no parameter properties in a file the
  // test suite imports.
  constructor(decelerationRate = DECELERATION) {
    this.decelerationRate = decelerationRate
  }

  get active(): boolean {
    return this.running
  }

  /**
   * @param onFrame receives the per-frame DELTA, so the caller stays the owner
   *   of the absolute position and can clamp or rubber-band it however it likes
   *   without this class knowing anything about bounds.
   * @param minSpeed px/s below which the glide has visually stopped.
   */
  start(
    vx: number,
    vy: number,
    onFrame: (dx: number, dy: number) => void,
    onEnd?: () => void,
    minSpeed = 8,
  ): void {
    this.stop()
    if (Math.hypot(vx, vy) < minSpeed) {
      onEnd?.()
      return
    }
    this.running = true
    let last = performance.now()
    const step = (now: number) => {
      // Clamped: a backgrounded tab or a stalled frame otherwise hands the
      // integrator a 400ms dt and teleports the view in one jump.
      const dt = Math.min(now - last, 32)
      last = now
      const retain = Math.pow(this.decelerationRate, dt)
      vx *= retain
      vy *= retain
      onFrame((vx * dt) / 1000, (vy * dt) / 1000)
      if (Math.hypot(vx, vy) < minSpeed) {
        this.running = false
        onEnd?.()
        return
      }
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.running = false
  }
}

/**
 * A critically damped spring, used for settling back inside a boundary.
 *
 * Damping 1.0 — no overshoot. Bounce is reserved for motion the user physically
 * threw; a view springing back from an edge it was never meant to pass is a
 * correction, and a correction that overshoots reads as a bug rather than as
 * personality.
 *
 * Like `Decay` this reports the CURRENT value every frame and can be stopped at
 * any moment, so a user who grabs the surface mid-settle takes it over from
 * exactly where it is on screen.
 */
export class Spring {
  private raf = 0
  private running = false

  get active(): boolean {
    return this.running
  }

  /**
   * @param response seconds to approach the target. Not a duration — a spring
   *   has none — but the parameter that sets how quickly it gets there.
   */
  start(
    from: number,
    to: number,
    onFrame: (value: number) => void,
    response = 0.35,
    initialVelocity = 0,
    onEnd?: () => void,
  ): void {
    this.stop()
    // Critically damped: omega is the single knob once damping is fixed at 1.
    const omega = (2 * Math.PI) / response
    let x = from - to
    let v = initialVelocity
    if (Math.abs(x) < 0.01 && Math.abs(v) < 0.01) {
      onFrame(to)
      onEnd?.()
      return
    }
    this.running = true
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.032)
      last = now
      // Semi-implicit Euler. Explicit Euler goes unstable at this stiffness on
      // a dropped frame and throws the value to infinity.
      v += (-2 * omega * v - omega * omega * x) * dt
      x += v * dt
      onFrame(to + x)
      if (Math.abs(x) < 0.05 && Math.abs(v) < 0.05) {
        onFrame(to)
        this.running = false
        onEnd?.()
        return
      }
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.running = false
  }
}

/** ~10px of slop before a press commits to being a drag. */
export const DRAG_THRESHOLD = 10

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
