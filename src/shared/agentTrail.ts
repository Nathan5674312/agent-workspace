/**
 * WHERE AN AGENT IS, ON THE GRAPH IT IS WALKING.
 *
 * The activity panel says what an agent is doing. This says WHERE, in the only
 * terms the vault has for the question: the notes it touched and the links
 * between them. An agent reading `07 - Agents` then `08 - Product` did not jump
 * — it followed an edge, and that edge is already in the graph.
 *
 * IT IS THE VAULT'S GRAPH, ZOOMED, NOT A DIAGRAM BUILT FROM SCRATCH. The first
 * version laid the visited notes out on an ellipse of their own, which drew a
 * tidy picture that looked nothing like the graph view and shared only its ids.
 * This one takes the visited notes AND the notes around them, runs the same kind
 * of force layout the graph view runs, and then frames the camera on the notes
 * being used. The same cluster looks like itself in both places, and the context
 * bleeding off the edges is what makes it read as a zoom rather than a sketch.
 *
 * THE OPEN/CLOSE RULE, AND WHY IT IS ONE RULE RATHER THAN TWO.
 *
 * Nathan asked for two behaviours: a graph that never opens for an agent working
 * somewhere else from the start, and a graph that closes when an agent leaves
 * the vault but keeps working. Those sound like two conditions and they are the
 * same one — the trail is built ONLY from activity inside a recent window, so:
 *
 *   never touched the vault      -> the window holds no graph nodes -> null
 *   touched it, then moved away  -> those hops age out of the window -> null
 *
 * One window, both behaviours, and no state to keep in sync. A separate "was it
 * ever open" flag would have been a second source of truth about the same fact.
 *
 * WHAT IT WILL NOT DO: draw an edge that is not in the graph. When an agent
 * moves between two notes with no link between them, that hop is real but the
 * connection is not, and inventing a line would make the picture lie about the
 * vault. Those hops are marked rather than drawn as edges, so the view can show
 * them as a jump.
 *
 * Deterministic, and that is load-bearing for a thumbnail that re-renders every
 * few seconds: d3's simulation seeds positions from a phyllotaxis spiral by node
 * INDEX, with no randomness in it, so the same walk settles the same way every
 * time. A jittering map would be unreadable and would look broken.
 *
 * No DOM and no clock — `now` is passed in — so `node --test` runs this file.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { Activity } from './transcript.js'
import { relativeTo } from './transcript.js'

/**
 * How far back a hop still counts.
 *
 * Shorter than the panel's own 90s idle window, deliberately. A card should
 * outlive a thinking pause; the graph should close as soon as the agent's work
 * has genuinely moved elsewhere, which is what Nathan asked for. Too long and a
 * stale map keeps glowing over work happening in another repo.
 */
export const TRAIL_MS = 60_000

/**
 * How many VISITED notes the map holds.
 *
 * The oldest hops fall off first. Five is what fits in a 17rem panel once the
 * camera has framed them with any padding at all.
 */
export const MAX_NODES = 5

/**
 * How much surrounding graph comes along.
 *
 * The map is the vault's own graph with the camera on the notes being used, so
 * the notes AROUND them come too. Without that it is a diagram built from
 * scratch that happens to share some ids. Capped because a hub with ninety
 * neighbours would fill the frame with dots that say nothing.
 */
export const MAX_CONTEXT = 12

/** Simulation ticks. Enough to settle a graph this small, run synchronously. */
const TICKS = 220

/**
 * How much room is left around the visited notes when the camera frames them.
 *
 * A frame drawn tight to the bounding box puts the outermost nodes half off the
 * edge. This is a fraction of the box's own size, so a walk of two adjacent
 * notes and a walk spread across a cluster both get proportionate breathing
 * room rather than a fixed gap that is wrong at one of the two scales.
 *
 * Widened from 0.35 after looking at it: at that value the camera sat so close
 * that nine context notes all fell outside the frame, and the map read as long
 * scratches with no visible endpoints rather than as a piece of a graph. The
 * context is there to give the visited notes somewhere to sit, which it cannot
 * do from off screen.
 */
const FRAME_PAD = 0.9

export type TrailNode = {
  /** Vault-relative path. The same id the graph uses. */
  id: string
  /** Filename without its extension, for a label that fits. */
  label: string
  /**
   * Position in FRAME space. The visited notes land inside 0..1; a context note
   * can fall outside it, which is what being zoomed in means — the view clips.
   */
  x: number
  y: number
  /**
   * Visit order, 0 = longest ago of those shown. `-1` for a context note the
   * agent has not been to — it is on the map because the graph put it there.
   */
  order: number
  /** The agent has read this one. Context notes are false. */
  visited: boolean
  /** The note the agent is on right now. */
  current: boolean
}

export type TrailEdge = {
  from: string
  to: string
  /**
   * True when the agent moved along this edge, in this direction, as part of
   * the walk being drawn. False for a link that merely exists between two of
   * the notes on the map.
   */
  travelled: boolean
}

export type Trail = {
  nodes: TrailNode[]
  edges: TrailEdge[]
  /**
   * Consecutive visits with NO link between them. Real moves across an edge the
   * vault does not have — the agent searched, or opened something directly.
   * Reported so the view can draw them honestly instead of implying a link.
   */
  jumps: { from: string; to: string }[]
}

type Graph = { nodes: string[]; links: { from: string; to: string }[] }

/** `Fate/Roadmap/07 - Agents.md` -> `07 - Agents`. */
function labelOf(id: string): string {
  return (id.split('/').pop() ?? id).replace(/\.[^.]+$/, '')
}

/**
 * The visited notes, oldest first, from activity inside the window.
 *
 * Everything about whether a map exists at all is decided here.
 */
function walk(activity: Activity[], known: Set<string>, root: string, now: number): string[] {
  const hops: string[] = []
  for (const a of [...activity].sort((x, y) => x.at - y.at)) {
    if (!a.path) continue
    if (now - a.at > TRAIL_MS) continue
    const rel = relativeTo(a.path, root)
    if (rel === null || rel === '') continue
    if (!known.has(rel)) continue
    // Re-reading the note you are already on is not a hop. Without this, an
    // agent editing one file repeatedly would draw a trail of one node
    // travelling to itself.
    if (hops.length > 0 && hops[hops.length - 1] === rel) continue
    hops.push(rel)
  }
  return hops
}

/**
 * Lay the subgraph out the way the graph view would, then frame the camera on
 * the visited notes.
 *
 * The forces are the same THREE the graph view uses and in the same spirit:
 * links pull, charge pushes, collision keeps dots off each other. The constants
 * are smaller because this is a dozen nodes in a thumbnail rather than hundreds
 * on a full canvas, and copying the tuned values would blow this subgraph apart.
 * `forceCenter` is deliberately absent — the framing below decides where the
 * picture sits, and centring first would only fight it.
 */
function layout(
  ids: string[],
  links: { from: string; to: string }[],
  visited: Set<string>,
): Map<string, { x: number; y: number }> {
  type N = { id: string; x?: number; y?: number }
  const nodes: N[] = ids.map((id) => ({ id }))
  const index = new Map(nodes.map((n) => [n.id, n]))
  const edges = links
    .filter((l) => index.has(l.from) && index.has(l.to))
    .map((l) => ({ source: index.get(l.from)!, target: index.get(l.to)! }))

  const sim = forceSimulation(nodes as never[])
    .force('link', forceLink(edges as never[]).distance(34).strength(0.6))
    .force('charge', forceManyBody().strength(-120).distanceMax(220))
    .force('collide', forceCollide(11))
    .stop()
  sim.tick(TICKS)

  // Frame on the VISITED notes. This is the zoom: the camera is on where the
  // agent is, and whatever else the graph put nearby falls where it falls.
  const seen = nodes.filter((n) => visited.has(n.id))
  const xs = seen.map((n) => n.x ?? 0)
  const ys = seen.map((n) => n.y ?? 0)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  // A single visited note, or several stacked exactly, gives a zero-width box.
  // Falling back to a fixed span keeps the divide finite; without it every
  // coordinate becomes NaN and the whole map silently vanishes.
  const spanX = maxX - minX || 80
  const spanY = maxY - minY || 80
  // Framed from the CENTRE outwards, not from the minimum corner. Anchoring on
  // the corner and adding a fallback span put a lone visited note at 0.21
  // instead of the middle — the fallback box grew to the right of it rather
  // than around it. Caught by the test that asks where a single note lands.
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const halfX = spanX / 2 + spanX * FRAME_PAD
  const halfY = spanY / 2 + spanY * FRAME_PAD
  const left = midX - halfX
  const top = midY - halfY
  const width = halfX * 2
  const height = halfY * 2

  const out = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    out.set(n.id, { x: ((n.x ?? 0) - left) / width, y: ((n.y ?? 0) - top) / height })
  }
  return out
}

/**
 * The agent's recent position in the vault graph, or null when there is nothing
 * to draw.
 *
 * `null` is the normal answer, not an error. Most agent activity is shell
 * commands, searches and files outside the vault, none of which is a place on
 * this map.
 */
export function trail(activity: Activity[], graph: Graph, root: string, now: number): Trail | null {
  if (!root) return null
  const known = new Set(graph.nodes)

  const hops = walk(activity, known, root, now)
  if (hops.length === 0) return null

  const shown = hops.slice(-MAX_NODES)
  const order: string[] = []
  for (const h of shown) if (!order.includes(h)) order.push(h)
  const visited = new Set(order)
  const currentId = shown[shown.length - 1]

  // One hop of surrounding graph, in the graph's own order so the same walk
  // always brings the same neighbours. Nodes already visited are not context.
  const context: string[] = []
  for (const l of graph.links) {
    for (const [a, b] of [
      [l.from, l.to],
      [l.to, l.from],
    ]) {
      if (!visited.has(a)) continue
      if (visited.has(b) || context.includes(b)) continue
      if (!known.has(b)) continue
      if (context.length >= MAX_CONTEXT) break
      context.push(b)
    }
    if (context.length >= MAX_CONTEXT) break
  }

  const all = [...order, ...context]
  const on = new Set(all)

  // Every real link between two notes on the map, deduplicated. These are the
  // vault's edges, not the walk's.
  const linked = new Set<string>()
  const edges: TrailEdge[] = []
  for (const l of graph.links) {
    if (!on.has(l.from) || !on.has(l.to)) continue
    const key = l.from < l.to ? `${l.from} ${l.to}` : `${l.to} ${l.from}`
    if (linked.has(key)) continue
    linked.add(key)
    edges.push({ from: l.from, to: l.to, travelled: false })
  }

  // Mark the ones actually walked, and record the moves that had no edge to
  // walk along. Direction is the agent's, not the link's.
  const jumps: { from: string; to: string }[] = []
  for (let i = 1; i < shown.length; i++) {
    const from = shown[i - 1]
    const to = shown[i]
    const edge = edges.find(
      (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
    )
    if (edge) edge.travelled = true
    else if (!jumps.some((j) => j.from === from && j.to === to)) jumps.push({ from, to })
  }

  const at = layout(all, graph.links, visited)
  const nodes: TrailNode[] = all.map((id) => ({
    id,
    label: labelOf(id),
    ...(at.get(id) ?? { x: 0.5, y: 0.5 }),
    order: order.indexOf(id),
    visited: visited.has(id),
    current: id === currentId,
  }))

  return { nodes, edges, jumps }
}
