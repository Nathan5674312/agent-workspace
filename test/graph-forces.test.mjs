/**
 * THE FORCES PANEL'S CONTRACT.
 *
 * The panel exposes four numbers that were TUNED AND MEASURED, not guessed. Two
 * of them have a right answer that a slider can silently destroy:
 *
 *   1. `LINK_MAX` is a measurement, not a preference. `graphPhysics.ts` records
 *      a sweep where 0.20 passes the orbit ring test and 0.24 upward all land
 *      near 21% CV against a 25% floor. Raising the slider ceiling past the
 *      cliff ships a control whose top half is known-bad.
 *   2. The HELD-link strength is part of the hold that `bench/orbit.mjs`
 *      measures. The slider must move the resting strength and leave that
 *      alone, or dragging it moves the ring the bench exists to keep honest.
 *
 * Both fail silently — the graph still renders, it just stops laying out the
 * way it was measured to.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  buildSimulation,
  groupForce,
  LABEL_AT_DEFAULT,
  DEFAULT_FORCES,
  LINK_MAX,
  LINK_STRENGTH,
  CENTRING_STRENGTH,
  CHARGE_MAX_DISTANCE,
  HOLD,
} = await import('../src/renderer/panes/vault/graphPhysics.ts')

/** Two linked nodes is enough: the forces are per-node and per-link. */
function scratch(getForces) {
  const nodes = [
    { id: 'a', degree: 1, x: 0, y: 0 },
    { id: 'b', degree: 1, x: 10, y: 0 },
  ]
  const links = [{ source: nodes[0], target: nodes[1] }]
  let held = null
  const adjacency = new Map([
    ['a', [nodes[1]]],
    ['b', [nodes[0]]],
  ])
  const built = buildSimulation(
    nodes,
    links,
    () => held,
    () => adjacency,
    HOLD,
    getForces,
  )
  built.sim.stop() // no ticking; this is about force configuration
  return { ...built, nodes, links, hold: (n) => (held = n) }
}

// ------------------------------------------------------------ the ceiling

test('the link slider stops exactly at the measured cliff', () => {
  // If someone widens the slider, they have to come here and re-run the sweep.
  assert.equal(
    LINK_MAX,
    LINK_STRENGTH,
    `LINK_MAX is ${LINK_MAX} but the measured ceiling is ${LINK_STRENGTH} — ` +
      `re-run bench/orbit.mjs before raising it`,
  )
})

test('the defaults ARE the tuned constants, so an untouched panel changes nothing', () => {
  assert.equal(DEFAULT_FORCES.centre, CENTRING_STRENGTH)
  assert.equal(DEFAULT_FORCES.repelRange, CHARGE_MAX_DISTANCE)
  assert.equal(DEFAULT_FORCES.link, LINK_STRENGTH)
  // Repulsion is a multiplier over a degree-scaled charge, so 1 is "as tuned".
  assert.equal(DEFAULT_FORCES.repel, 1)
})

// ------------------------------------------------------- the held-link guard

test('the slider moves resting links and leaves the held link alone', () => {
  const forces = { ...DEFAULT_FORCES }
  const s = scratch(() => forces)
  const link = s.sim.force('link')

  // Nothing held: the resting value is what the slider says.
  assert.equal(link.strength()(s.links[0]), LINK_STRENGTH)
  forces.link = 0.05
  s.applyForces()
  assert.equal(link.strength()(s.links[0]), 0.05, 'the slider did not reach resting links')

  // Holding an end: the hold's own strength, untouched by the slider.
  s.hold(s.nodes[0])
  assert.equal(
    link.strength()(s.links[0]),
    HOLD.linkStrength,
    'the slider leaked into the held link, which the orbit bench measures',
  )
})

// ------------------------------------------------------------ live updates

test('applyForces reaches the running simulation without rebuilding it', () => {
  const forces = { ...DEFAULT_FORCES }
  const s = scratch(() => forces)
  const before = s.sim.force('charge')

  forces.repelRange = 500
  forces.centre = 0.05
  s.applyForces()

  assert.equal(s.sim.force('charge').distanceMax(), 500)
  assert.equal(s.sim.force('x').strength()(s.nodes[0]), 0.05)
  assert.equal(s.sim.force('y').strength()(s.nodes[0]), 0.05)
  assert.notEqual(s.sim.force('charge'), before, 'charge was not re-registered')

  // The nodes are the SAME objects, which is what keeps a settled layout in
  // place while a slider is dragged.
  assert.equal(s.sim.nodes()[0], s.nodes[0])
})

test('repel is a multiplier, so hubs still push harder than leaves', () => {
  const forces = { ...DEFAULT_FORCES }
  const s = scratch(() => forces)
  const charge = () => s.sim.force('charge').strength()
  const leaf = { id: 'l', degree: 1 }
  const hub = { id: 'h', degree: 9 }

  const tunedGap = Math.abs(charge()(hub) - charge()(leaf))
  forces.repel = 2
  s.applyForces()
  const doubledGap = Math.abs(charge()(hub) - charge()(leaf))

  assert.ok(doubledGap > tunedGap, 'the degree signal was flattened, not scaled')
  assert.equal(doubledGap, tunedGap * 2)
})

test('a zeroed slider is inert, not broken', () => {
  const forces = { ...DEFAULT_FORCES, centre: 0, repel: 0, link: 0 }
  const s = scratch(() => forces)
  s.applyForces()
  assert.equal(s.sim.force('x').strength()(s.nodes[0]), 0)
  assert.equal(s.sim.force('charge').strength()(s.nodes[0]), -0)
  assert.equal(s.sim.force('link').strength()(s.links[0]), 0)
})

// ---------------------------------------------------------------- groups

/** Run the force once and report how far a node was pushed. */
function nudge(force, nodes, alpha = 1) {
  for (const n of nodes) {
    n.vx = 0
    n.vy = 0
  }
  force.initialize(nodes)
  force(alpha)
  return nodes.map((n) => ({ vx: n.vx, vy: n.vy }))
}

test('group pull at 0 is genuinely inert, not just small', () => {
  // The whole promise of the default: groups off means the layout is EXACTLY
  // what it was before groups existed. "Nearly zero" would still drift it.
  const nodes = [{ id: 'a', degree: 1, x: 100, y: 100 }]
  const f = groupForce(() => ({ x: 0, y: 0 }), () => 0)
  const [v] = nudge(f, nodes)
  assert.equal(v.vx, 0)
  assert.equal(v.vy, 0)
})

test('a member is pulled toward its anchor, not away from it', () => {
  const nodes = [{ id: 'a', degree: 1, x: 100, y: 0 }]
  const f = groupForce(() => ({ x: 0, y: 0 }), () => 0.05)
  const [v] = nudge(f, nodes)
  assert.ok(v.vx < 0, `expected a pull toward x=0, got vx=${v.vx}`)
  assert.equal(v.vy, 0, 'pulled off-axis toward an on-axis anchor')
})

test('an ungrouped node is left completely alone', () => {
  // Root-level notes have no top-level folder. They must not all pile onto a
  // single shared anchor, which is what returning a default position would do.
  const nodes = [{ id: 'root', degree: 1, x: 300, y: 300 }]
  const f = groupForce(() => null, () => 0.05)
  const [v] = nudge(f, nodes)
  assert.equal(v.vx, 0)
  assert.equal(v.vy, 0)
})

test('the pull is alpha-scaled, so it fades as the layout cools', () => {
  const at = (alpha) => {
    const nodes = [{ id: 'a', degree: 1, x: 100, y: 0 }]
    return Math.abs(nudge(groupForce(() => ({ x: 0, y: 0 }), () => 0.05), nodes, alpha)[0].vx)
  }
  assert.ok(at(0.5) < at(1), 'the force ignores alpha and would pin nodes to anchors')
  assert.equal(at(0.5) * 2, at(1))
})

test('groups are a force, never a colour — the physics never sees a group name', () => {
  /**
   * The design decision this pins. Obsidian colours group members because its
   * layout cannot express grouping; expressing it in the layout is what lets
   * tokens.css §4b (no accent hue) survive. If a group name or colour ever
   * reaches the physics, someone has started painting instead of arranging.
   */
  // Comments stripped: the doc comment on groupForce EXPLAINS why there is no
  // colour here, and matching that would be checking prose rather than code.
  const src = readFileSync(
    new URL('../src/renderer/panes/vault/graphPhysics.ts', import.meta.url),
    'utf-8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(src, /colou?r/i, 'graphPhysics learned about colour')
  assert.doesNotMatch(src, /\.group(?!:)/, 'the physics reads a group name off a node')
})

// --------------------------------------------------------------- display

test('display defaults are the identity, so the panel opens unchanged', () => {
  assert.equal(DEFAULT_FORCES.nodeSize, 1)
  assert.equal(DEFAULT_FORCES.linkWidth, 1)
  assert.equal(DEFAULT_FORCES.labelAt, LABEL_AT_DEFAULT)
})

test('node size scales COLLISION too, not just the drawing', () => {
  /**
   * The defect this stops: draw nodes at 2x while collide still reserves 1x of
   * room and the big nodes visibly overlap. Node size is the one display value
   * that is also a physics value.
   */
  const forces = { ...DEFAULT_FORCES }
  const s = scratch(() => forces)
  const at = () => s.sim.force('collide').radius()(s.nodes[0])

  const base = at()
  forces.nodeSize = 2
  s.applyForces()
  assert.ok(at() > base, 'collide ignored node size; big nodes will overlap')

  // Padding is a constant gap, so the growth is in the radius only.
  const COLLIDE_PADDING = 6
  assert.equal(at() - COLLIDE_PADDING, (base - COLLIDE_PADDING) * 2)
})

test('Reset covers every key, including ones added later', () => {
  // atDefaults in GraphView iterates DEFAULT_FORCES rather than listing fields,
  // so this asserts the shape it depends on: no key is optional.
  for (const [k, v] of Object.entries(DEFAULT_FORCES)) {
    assert.equal(typeof v, 'number', `${k} is not a number, Reset compares with ===`)
  }
  assert.ok(Object.keys(DEFAULT_FORCES).length >= 7, 'a tunable went missing')
})
