import * as d3 from 'd3-force'

/**
 * The graph's force layout, as data and pure functions.
 *
 * This exists so the headless harness (`test/graph-orbit-measure.mjs`) can
 * measure THE SIMULATION THE APP ACTUALLY RUNS rather than a second copy of it
 * written to match. That distinction is not pedantic: the note-system
 * benchmark spent a week reporting accuracy for a classifier that did not
 * exist, because the evaluator declared its own folder list instead of
 * importing the app's. A tuning number measured against a re-implementation is
 * worth nothing, and worse than nothing if anyone believes it.
 *
 * The hold behaviour is parameterised by `HoldTuning` rather than hardcoded,
 * so the harness can measure the shipped values and a candidate under one
 * simulation and attribute any difference to a named lever. `LEGACY_HOLD`
 * below is the behaviour as it shipped, kept so a regression is measurable and
 * not just remembered.
 *
 * No DOM, no canvas, no React — `d3-force` is plain JS and runs in node.
 */

export type PhysicsNode = d3.SimulationNodeDatum & { id: string; degree: number }
export type PhysicsLink = { source: PhysicsNode; target: PhysicsNode }

/** Adjacency as node references, keyed by id. */
export type Adjacency = Map<string, PhysicsNode[]>

// ── layout constants (unchanged by the hold) ────────────────────

/** Rest length for an ordinary link. */
export const REST_NORMAL = 52
/** Rest length between two hubs, which need more room than leaves. */
export const REST_HUB = 90
/** A node counts as a hub above this degree. */
export const HUB_DEGREE = 3

export const LINK_STRENGTH = 0.16
export const CHARGE_BASE = -78
export const CHARGE_PER_DEGREE = -14
export const CHARGE_MAX_DISTANCE = 420
export const COLLIDE_PADDING = 6
export const CENTRING_STRENGTH = 0.012
export const VELOCITY_DECAY_NORMAL = 0.4

export const radius = (n: PhysicsNode) => 3.4 + Math.sqrt(n.degree) * 1.45

// ── the hold ────────────────────────────────────────────────────

export interface HoldTuning {
  /** Energy the simulation is driven toward while a node is held. */
  alpha: number
  /** Velocity damping during the hold. d3's default is 0.4. */
  velocityDecay: number
  /** Link strength for the held node's own links during the hold. */
  linkStrength: number
  /** Spread the ring radius per neighbour, deterministically by id. */
  jitter: boolean
  /** Ring may only lengthen a link, never shorten one. */
  onlyLengthen: boolean
  /** Tangential nudge applied to direct neighbours, scaled by alpha. */
  orbitRate: number
}

/**
 * The behaviour as it shipped, and as Nathan described it: *"the orbit is
 * still too strong, all of the related nodes are in a perfect circle which
 * causes friend of friend nodes to wig out"*.
 *
 * Kept as a named baseline so the harness can prove the difference rather than
 * assert it.
 */
export const LEGACY_HOLD: HoldTuning = {
  alpha: 0.45,
  velocityDecay: VELOCITY_DECAY_NORMAL,
  linkStrength: LINK_STRENGTH,
  jitter: false,
  onlyLengthen: false,
  orbitRate: 0.08,
}

/**
 * Current tuning. Every value here was chosen from `bench/orbit.mjs` output,
 * one lever at a time off LEGACY_HOLD. Numbers below are from that harness on
 * an irregular 12-neighbour hub; rerun it before changing anything.
 *
 *   metric              legacy -> now
 *   ring radius CV       19.3% -> 27.9%   (less circular)
 *   2-hop max step        3.46 -> 0.61 px/tick
 *   far-cluster max       1.47 -> 0.32 px/tick
 *   drag selectivity      1.41 -> 2.37
 *
 * TWO LEVERS WERE TRIED AND REJECTED, both measured, so they are not
 * re-attempted:
 *
 *   - Softening hub link strength to 0.05. It made the ring MORE circular
 *     (CV 19.3 -> 17.6 on its own), pushed the ring from 147px to 196px, and
 *     collapsed drag follow to 0.108 — the neighbourhood stopped responding
 *     at all. `linkStrength` stays at the normal value.
 *   - Lowering `orbitRate` further. Dropping it 0.08 -> 0.012 changed nothing
 *     measurable and moved rotation the wrong way, because the rotation seen
 *     in the graph is layout drift, not that force. It is off entirely now;
 *     see the field comment.
 */
export const HOLD: HoldTuning = {
  /**
   * 0.16, down from 0.45.
   *
   * Bounded by a real threshold rather than taste: 2-hop displacement must
   * stay under 1px/tick, which is below what the eye resolves on a small dot
   * at 60fps. 0.16 measures 0.61px/tick — 40% of margin. 0.30 breaks it at
   * 1.25 and 0.45 at 1.78, which is precisely the jitter being complained
   * about. Going lower still is calmer but costs follow: at 0.12 the ring
   * only comes 23% of the way with your hand, against 28% here.
   */
  alpha: 0.16,
  /**
   * 0.62, up from d3's 0.4.
   *
   * Alpha lowers how hard every force pushes; this bleeds off the velocity
   * that carries a disturbance outward. They are complementary, not
   * redundant — each alone leaves 2-hop step at ~1.6-1.8px/tick, together
   * 0.61.
   */
  velocityDecay: 0.62,
  /** Unchanged. Softening it was measured and rejected — see above. */
  linkStrength: LINK_STRENGTH,
  /** The direct fix for "a perfect circle": CV 19.3% -> 24.1% on its own. */
  jitter: true,
  /** Worth ~1pt of CV on its own, and it stops the hold reeling nodes inward. */
  onlyLengthen: true,
  /**
   * Off.
   *
   * The tangential force never produced the rotation anyone saw. At the alphas
   * this simulation actually runs it is worth ~0.0004 rad/tick — roughly four
   * MINUTES per revolution, which is not a thing a person perceives — and
   * varying it 6.7x moved the measured rate the wrong way, i.e. the signal was
   * drift, not the force. Nathan read the hold as "too strong"; that was the
   * radial yank and the whole-graph reheat, both of which are fixed above.
   * Keeping a force that costs a per-tick loop over every neighbour and does
   * nothing observable is not a tradeoff worth making. The `orbitRate` field
   * stays so the harness can still measure it if rotation is ever wanted
   * deliberately.
   */
  orbitRate: 0,
}

/**
 * A small deterministic factor in roughly 0.78–1.22, derived from the node id.
 *
 * Deterministic is the whole point. A random multiplier re-rolled per tick
 * makes the ring shimmer, because every tick asks for a different rest length
 * and the spring chases it forever. Hashing the id means a given note always
 * sits at the same place in its hub's ring, so the unevenness reads as
 * structure rather than as noise.
 *
 * FNV-1a: four lines, no dependency, and it spreads adjacent strings
 * ("00 - Product Spec" vs "01 - ...") into unrelated buckets, which a naive
 * character sum does not — and adjacent names are exactly what a vault's
 * numbered note sets are full of.
 */
export function idJitter(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const unit = (h >>> 0) / 0x100000000
  return 0.78 + unit * 0.44
}

/**
 * The radius a held node's neighbourhood is invited out to.
 *
 * Circumference grows with the neighbour count so each one keeps roughly 18px
 * of arc — at a fixed radius a hub with forty links seats forty nodes on one
 * small circle and they pile into each other.
 */
export function ringOf(hub: PhysicsNode, neighbourCount: number): number {
  return radius(hub) + Math.max(74, (neighbourCount * 18) / (2 * Math.PI))
}

/** Rest length for a link when nothing is held. */
export function baseRest<N extends PhysicsNode>(l: { source: N; target: N }): number {
  return l.source.degree > HUB_DEGREE && l.target.degree > HUB_DEGREE ? REST_HUB : REST_NORMAL
}

/**
 * Rest length for a link, given whichever node is currently held.
 *
 * The jitter is keyed on the NEIGHBOUR's id, not the link's, so the same note
 * sits at the same offset whichever hub it is orbiting.
 *
 * `onlyLengthen` clamps the ring against the base length so the hold may only
 * ever push a neighbour outward. A neighbour already further out than the ring
 * is left alone rather than reeled in to make the circle tidy.
 */
export function restLength<N extends PhysicsNode>(
  l: { source: N; target: N },
  held: N | null,
  neighbourCount: number,
  tuning: HoldTuning,
): number {
  const base = baseRest(l)
  if (!held) return base
  const other =
    l.source.id === held.id ? l.target : l.target.id === held.id ? l.source : null
  if (!other) return base
  const ring = ringOf(held, neighbourCount) * (tuning.jitter ? idJitter(other.id) : 1)
  return tuning.onlyLengthen ? Math.max(base, ring) : ring
}

/** Link strength for a link, softened while it touches the held node. */
export function linkStrength<N extends PhysicsNode>(
  l: { source: N; target: N },
  held: N | null,
  tuning: HoldTuning,
): number {
  if (held && (l.source.id === held.id || l.target.id === held.id)) return tuning.linkStrength
  return LINK_STRENGTH
}

/**
 * The tangential nudge that makes the ring turn.
 *
 * Alpha-scaled like every built-in force, so it fades as the layout cools.
 * Returned as a factory rather than registered here because the caller owns
 * the held-node state.
 */
export function orbitForce<N extends PhysicsNode>(
  getHeld: () => N | null,
  getAdjacency: () => Map<string, N[]>,
  tuning: HoldTuning,
) {
  return (alpha: number) => {
    const hub = getHeld()
    if (!hub || tuning.orbitRate === 0) return
    for (const n of getAdjacency().get(hub.id) ?? []) {
      const dx = n.x! - hub.x!
      const dy = n.y! - hub.y!
      const d = Math.hypot(dx, dy) || 1
      n.vx! += (-dy / d) * tuning.orbitRate * alpha
      n.vy! += (dx / d) * tuning.orbitRate * alpha
    }
  }
}

/**
 * Build the simulation.
 *
 * `getHeld` and `getAdjacency` are read at call time rather than passed as
 * values so the caller keeps ownership of the interaction state; the module
 * never learns what a pointer is.
 */
export function buildSimulation<
  N extends PhysicsNode,
  L extends { source: N; target: N },
>(
  nodes: N[],
  links: L[],
  getHeld: () => N | null,
  getAdjacency: () => Map<string, N[]>,
  tuning: HoldTuning = HOLD,
) {
  const neighbourCount = (n: N | null) => (n ? (getAdjacency().get(n.id)?.length ?? 0) : 0)

  const distance = (l: L) => restLength(l, getHeld(), neighbourCount(getHeld()), tuning)
  const strength = (l: L) => linkStrength(l, getHeld(), tuning)

  const linkForce = d3
    .forceLink<N, L>(links)
    .id((d) => d.id)
    .distance(distance)
    .strength(strength)

  const sim = d3
    .forceSimulation<N>(nodes)
    .velocityDecay(VELOCITY_DECAY_NORMAL)
    .force('link', linkForce)
    .force(
      'charge',
      d3
        .forceManyBody<N>()
        .strength((d) => CHARGE_BASE + d.degree * CHARGE_PER_DEGREE)
        .distanceMax(CHARGE_MAX_DISTANCE),
    )
    .force('collide', d3.forceCollide<N>().radius((d) => radius(d) + COLLIDE_PADDING))
    .force('x', d3.forceX<N>(0).strength(CENTRING_STRENGTH))
    .force('y', d3.forceY<N>(0).strength(CENTRING_STRENGTH))
    .force('orbit', orbitForce(getHeld, getAdjacency, tuning))

  /**
   * `forceLink` caches distance and strength when the accessor is set, so
   * re-setting them is how the cache is refreshed. O(links), called twice per
   * gesture rather than per tick.
   */
  const refresh = () => {
    linkForce.distance(distance).strength(strength)
  }

  /** Called on press and release; owns the two levers that are not per-link. */
  const setHolding = (holding: boolean) => {
    sim.velocityDecay(holding ? tuning.velocityDecay : VELOCITY_DECAY_NORMAL)
    refresh()
  }

  return { sim, linkForce, refresh, setHolding, tuning }
}
