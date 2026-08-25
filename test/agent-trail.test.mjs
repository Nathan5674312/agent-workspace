/**
 * THE MINI GRAPH, AND ESPECIALLY WHEN IT IS NOT THERE.
 *
 * Nathan asked for two behaviours and they turned out to be one rule:
 *
 *   an agent that was never in the vault never opens a graph
 *   an agent that was in the vault, leaves, and keeps working closes it
 *
 * Both fall out of building the trail from a time window only. Those are the
 * first tests here because they are the ones a later "improvement" would break
 * — someone adding a `wasEverOpen` flag to stop the graph flickering would
 * reintroduce exactly the second case, and nothing else would notice.
 *
 * The other load-bearing one is that a hop with no link between its two notes
 * is NOT drawn as an edge. The agent really moved; the connection really does
 * not exist; drawing a line would make the picture lie about the vault, which
 * is the one thing a map must not do.
 *
 * Pure. No clock, no DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { trail, TRAIL_MS, MAX_NODES, MAX_CONTEXT } = await import('../src/shared/agentTrail.ts')

const ROOT = 'C:/Users/Nathan/Desktop/Universal Vault'
const T = 1_700_000_000_000

/** A vault graph: a small chain plus one unlinked island. */
const GRAPH = {
  nodes: ['Fate/A.md', 'Fate/B.md', 'Fate/C.md', 'Island.md'],
  links: [
    { from: 'Fate/A.md', to: 'Fate/B.md' },
    { from: 'Fate/B.md', to: 'Fate/C.md' },
  ],
}

/** An activity that read a vault-relative path, `ago` ms before T. */
const read = (rel, ago = 0) => ({
  at: T - ago,
  session: 's',
  cwd: 'C:/x',
  tool: 'Read',
  action: 'read',
  path: `${ROOT}/${rel}`.replace(/\//g, '\\'),
})

/** The notes the agent actually walked. The map also carries context nodes. */
const ids = (t) => t.nodes.filter((n) => n.visited).map((n) => n.id)
const contextIds = (t) => t.nodes.filter((n) => !n.visited).map((n) => n.id)

// ------------------------------------------------ when there is no graph at all

test('an agent that never touched the vault gets no graph', () => {
  // Working in a repo somewhere else from the beginning. Nothing to draw, and
  // an empty box would be worse than no box.
  const elsewhere = [
    { at: T, session: 's', cwd: 'C:/x', tool: 'Read', action: 'read', path: 'C:/code/main.ts' },
    { at: T, session: 's', cwd: 'C:/x', tool: 'Bash', action: 'run', detail: 'npm test' },
  ]
  assert.equal(trail(elsewhere, GRAPH, ROOT, T), null)
})

test('an agent that left the vault and kept working loses its graph', () => {
  // THE SECOND RULE, and it is the same window as the first. The vault hops are
  // older than TRAIL_MS; the agent is still busy, just not here.
  const items = [
    read('Fate/A.md', TRAIL_MS + 5_000),
    read('Fate/B.md', TRAIL_MS + 1_000),
    { at: T, session: 's', cwd: 'C:/x', tool: 'Bash', action: 'run', detail: 'npm test' },
  ]
  assert.equal(trail(items, GRAPH, ROOT, T), null)
})

test('the same walk still shows while it is inside the window', () => {
  // The mirror of the test above: identical hops, recent instead of stale.
  const items = [read('Fate/A.md', 5_000), read('Fate/B.md', 1_000)]
  assert.deepEqual(ids(trail(items, GRAPH, ROOT, T)), ['Fate/A.md', 'Fate/B.md'])
})

test('a file inside the vault but not in the graph is not a place', () => {
  // A .canvas, an image, anything the graph does not index. Real activity, no
  // node to glow.
  assert.equal(trail([read('Fate/board.canvas')], GRAPH, ROOT, T), null)
})

test('no vault root means no map, rather than a map of absolute paths', () => {
  assert.equal(trail([read('Fate/A.md')], GRAPH, '', T), null)
})

// ------------------------------------------------------------------- the walk

test('the current note is the most recent one, and only it', () => {
  const t = trail([read('Fate/A.md', 3_000), read('Fate/B.md', 1_000)], GRAPH, ROOT, T)
  assert.deepEqual(t.nodes.filter((n) => n.current).map((n) => n.id), ['Fate/B.md'])
})

test('order reads the way the walk happened, oldest first', () => {
  // Activity arrives in whatever order the tail produced; the map must not.
  const t = trail([read('Fate/B.md', 1_000), read('Fate/A.md', 3_000)], GRAPH, ROOT, T)
  assert.deepEqual(ids(t), ['Fate/A.md', 'Fate/B.md'])
  assert.deepEqual(t.nodes.filter((n) => n.visited).map((n) => n.order), [0, 1])
})

test('re-reading the note you are already on is not a hop', () => {
  // Otherwise an agent editing one file draws a trail of one node travelling
  // to itself, over and over.
  const t = trail(
    [read('Fate/A.md', 4_000), read('Fate/A.md', 3_000), read('Fate/A.md', 1_000)],
    GRAPH,
    ROOT,
    T,
  )
  assert.deepEqual(ids(t), ['Fate/A.md'])
  // No JUMPS, because there was no move. Edges may well exist: A's neighbour
  // came along as context and the A-B link is real.
  assert.deepEqual(t.jumps, [])
  assert.ok(t.edges.every((e) => !e.travelled), 'a walk of one step travelled an edge')
})

test('a note visited twice appears once, keeping the shape of the walk', () => {
  const t = trail(
    [read('Fate/A.md', 5_000), read('Fate/B.md', 3_000), read('Fate/A.md', 1_000)],
    GRAPH,
    ROOT,
    T,
  )
  assert.deepEqual(ids(t), ['Fate/A.md', 'Fate/B.md'])
  assert.equal(t.nodes.find((n) => n.id === 'Fate/A.md').current, true)
})

test('only the most recent hops are kept, because the panel is narrow', () => {
  const many = ['Fate/A.md', 'Fate/B.md', 'Fate/C.md', 'Island.md', 'Fate/A.md', 'Fate/B.md']
  const t = trail(many.map((p, i) => read(p, (many.length - i) * 1000)), GRAPH, ROOT, T)
  assert.ok(ids(t).length <= MAX_NODES, `${ids(t).length} visited is more than the panel holds`)
})

// ------------------------------------------------------- edges are the vault's

test('a hop along a real link is marked travelled', () => {
  const t = trail([read('Fate/A.md', 2_000), read('Fate/B.md', 1_000)], GRAPH, ROOT, T)
  const walked = t.edges.filter((e) => e.travelled)
  assert.equal(walked.length, 1, 'the walked link was not marked, or too many were')
  assert.deepEqual([walked[0].from, walked[0].to].sort(), ['Fate/A.md', 'Fate/B.md'])
  assert.deepEqual(t.jumps, [])
})

test('a hop with no link between the two notes is a jump, not an edge', () => {
  // THE HONESTY RULE. The agent really moved from B to the island; the vault
  // really has no link. Drawing one would make the map lie.
  const t = trail([read('Fate/B.md', 2_000), read('Island.md', 1_000)], GRAPH, ROOT, T)
  // The map may carry B's neighbours as context, but NOTHING joins B to the
  // island, and nothing was travelled.
  assert.ok(
    !t.edges.some(
      (e) =>
        (e.from === 'Fate/B.md' && e.to === 'Island.md') ||
        (e.from === 'Island.md' && e.to === 'Fate/B.md'),
    ),
    'an edge was invented between two unlinked notes',
  )
  assert.deepEqual(t.edges.filter((e) => e.travelled), [])
  assert.deepEqual(t.jumps, [{ from: 'Fate/B.md', to: 'Island.md' }])
})

test('a link between two visited notes is drawn even if it was not walked', () => {
  // A and C are both on the map via B. A-C has no link, so nothing appears for
  // it; A-B and B-C do, and only the walked ones are marked.
  const t = trail(
    [read('Fate/A.md', 3_000), read('Fate/B.md', 2_000), read('Fate/C.md', 1_000)],
    GRAPH,
    ROOT,
    T,
  )
  assert.equal(t.edges.length, 2)
  assert.ok(t.edges.every((e) => e.travelled))
})

test('one link is one edge, however many times the graph lists it', () => {
  const doubled = {
    nodes: GRAPH.nodes,
    links: [...GRAPH.links, { from: 'Fate/B.md', to: 'Fate/A.md' }],
  }
  const t = trail([read('Fate/A.md', 2_000), read('Fate/B.md', 1_000)], doubled, ROOT, T)
  const ab = t.edges.filter(
    (e) => [e.from, e.to].includes('Fate/A.md') && [e.from, e.to].includes('Fate/B.md'),
  )
  assert.equal(ab.length, 1, 'one link was drawn twice')
})

// --------------------------------------------------------------------- layout

test('the layout is deterministic, so the thumbnail does not jitter', () => {
  const items = [read('Fate/A.md', 3_000), read('Fate/B.md', 2_000), read('Fate/C.md', 1_000)]
  assert.deepEqual(trail(items, GRAPH, ROOT, T), trail(items, GRAPH, ROOT, T))
})

test('the camera frames the VISITED notes, which is what zoomed in means', () => {
  // Visited notes land inside the frame. Context notes may fall outside it and
  // get clipped — that is the difference between a zoom and a diagram of the
  // walk on its own.
  const items = [read('Fate/A.md', 3_000), read('Fate/B.md', 2_000), read('Fate/C.md', 1_000)]
  for (const n of trail(items, GRAPH, ROOT, T).nodes.filter((x) => x.visited)) {
    assert.ok(n.x >= 0 && n.x <= 1, `visited x ${n.x} fell outside the frame`)
    assert.ok(n.y >= 0 && n.y <= 1, `visited y ${n.y} fell outside the frame`)
  }
})

test('a single visited note is centred rather than producing NaN', () => {
  // One note is a zero-width bounding box. Without the fallback span every
  // coordinate divides by zero and the whole map silently disappears.
  const t = trail([read('Fate/A.md')], GRAPH, ROOT, T)
  const a = t.nodes.find((n) => n.id === 'Fate/A.md')
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), 'a lone note produced NaN')
  assert.ok(Math.abs(a.x - 0.5) < 0.001 && Math.abs(a.y - 0.5) < 0.001)
})

test('every coordinate on the map is a real number', () => {
  const items = [read('Fate/A.md', 3_000), read('Fate/B.md', 2_000), read('Island.md', 1_000)]
  for (const n of trail(items, GRAPH, ROOT, T).nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} has NaN coordinates`)
  }
})

// -------------------------------------------------- the surrounding graph

test('the map carries the notes AROUND the walk, not just the walk', () => {
  // The whole point of the redesign: this is the vault's graph zoomed in on
  // where the agent is, not a picture assembled from the visited notes alone.
  // Visiting A brings B, because the graph links them.
  const t = trail([read('Fate/A.md')], GRAPH, ROOT, T)
  assert.deepEqual(ids(t), ['Fate/A.md'])
  assert.ok(contextIds(t).includes('Fate/B.md'), 'the neighbourhood did not come along')
})

test('a context note is not marked visited, current or ordered', () => {
  const t = trail([read('Fate/A.md')], GRAPH, ROOT, T)
  const ctx = t.nodes.find((n) => !n.visited)
  assert.equal(ctx.current, false)
  assert.equal(ctx.order, -1)
})

test('context is capped, so a hub does not fill the frame with dots', () => {
  const hub = {
    nodes: ['Hub.md', ...Array.from({ length: 40 }, (_, i) => `n${i}.md`)],
    links: Array.from({ length: 40 }, (_, i) => ({ from: 'Hub.md', to: `n${i}.md` })),
  }
  const t = trail([read('Hub.md')], hub, ROOT, T)
  assert.ok(contextIds(t).length <= MAX_CONTEXT, `${contextIds(t).length} context nodes is too many`)
})

test('an edge between two context notes is still drawn, because it is real', () => {
  // The map shows the vault's links among everything on it, not only the ones
  // touching the walk. That is what makes it look like the graph.
  const t = trail([read('Fate/A.md')], GRAPH, ROOT, T)
  assert.ok(t.edges.some((e) => e.from === 'Fate/A.md' || e.to === 'Fate/A.md'))
  assert.ok(t.edges.every((e) => e.from !== e.to))
})

test('labels are filenames, because a path does not fit in 17rem', () => {
  const t = trail([read('Fate/A.md')], GRAPH, ROOT, T)
  assert.equal(t.nodes[0].label, 'A')
})
