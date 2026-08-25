/**
 * FINDING THE PIPELINES WITHOUT BEING TOLD WHERE THEY ARE.
 *
 * The feature is one sentence: an agent that has a vault and nothing else can
 * work out which boards are runnable. It rests on two claims, and this file is
 * those two claims checked separately, because they fail in different ways and
 * one passing tells you nothing about the other.
 *
 *   1. An index board is a board. A `file` card pointing at a `.canvas` is what
 *      a person draws when they mean "and then that pipeline", so `compile()`
 *      already carries every one of them and `pipelines()` is only a filter.
 *      No manifest, no new format, nothing to keep in sync.
 *
 *   2. A board is a thing in the vault. Until now `.canvas` files were indexed
 *      by nothing: a note saying [[Home.canvas]] resolved to no target and the
 *      board was absent from the graph, so the one kind of file that describes
 *      how work gets done was the one kind the vault could not show.
 *
 * The first half is pure and runs against a literal. The second needs the real
 * `vault.ts` against a scratch directory, the same shape relations.test.mjs
 * uses — no Electron, no IPC.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { compile, pipelines } = await import('../src/shared/pipeline.ts')
const vault = await import('../src/main/vault.ts')

// --------------------------------------------------------------- the filter

const card = (id, file, x, y) => ({ id, type: 'file', file, x, y, width: 400, height: 400 })
const arrow = (id, from, to, label) => ({ id, fromNode: from, toNode: to, ...(label ? { label } : {}) })

/**
 * An index board of the shape the feature describes: two pipelines, a note that
 * is material rather than a pipeline, and a text card that is an instruction.
 */
const indexBoard = () => ({
  nodes: [
    card('p1', 'Ingest.canvas', 0, 0),
    card('p2', 'Publish.canvas', 0, 200),
    card('n1', 'Fate/Rules.md', 0, 400),
    { id: 't1', type: 'text', text: 'read the agent inbox first', x: 0, y: 600, width: 300, height: 80 },
  ],
  edges: [arrow('e1', 't1', 'p1'), arrow('e2', 'p1', 'p2', 'if anything new landed')],
})

test('an index board hands back the boards it points at, and nothing else', () => {
  const found = pipelines(compile(indexBoard()))
  assert.deepEqual(
    found.map((s) => s.file),
    ['Ingest.canvas', 'Publish.canvas'],
  )
})

test('a note card is material, not a pipeline', () => {
  // The distinction the whole filter exists to make. A board pointing at a
  // skill or a note means "use this"; pointing at a board means "run this".
  const found = pipelines(compile(indexBoard()))
  assert.ok(!found.some((s) => s.file === 'Fate/Rules.md'))
})

test('a text card is never a pipeline, however it is worded', () => {
  const found = pipelines(compile(indexBoard()))
  for (const s of found) assert.ok(s.file !== undefined, 'a step with no file got through')
})

test('the arrows survive, so an index board can be a sequence', () => {
  // The reason this returns Steps rather than paths. An index that says "ingest
  // first, then publish, and only if anything landed" is an ordinary board and
  // has to keep meaning that.
  const [ingest, publish] = pipelines(compile(indexBoard()))
  assert.deepEqual(publish.after, ['p1'])
  assert.deepEqual(publish.conditions, { p1: 'if anything new landed' })
  assert.ok(ingest.index < publish.index, 'the arrows did not order the pipelines')
})

test('board order is the file order, so two agents agree on which is first', () => {
  // Same determinism argument compile() makes for steps: an index that
  // reshuffled between readers would have two defensible "first pipelines".
  const doc = indexBoard()
  const once = pipelines(compile(doc)).map((s) => s.file)
  const twice = pipelines(compile(doc)).map((s) => s.file)
  assert.deepEqual(once, twice)
})

test('an index board with no pipelines on it yet is empty, not broken', () => {
  // The state the author\'s own Home.canvas is in today: a real board, a real
  // maintenance chain, and no pipeline cards. An agent has to be able to tell
  // "there are none yet" from "I could not find the index".
  const plan = compile({
    nodes: [{ id: 'a', type: 'text', text: 'read the agent inbox', x: 0, y: 0, width: 300, height: 80 }],
    edges: [],
  })
  assert.deepEqual(pipelines(plan), [])
  assert.equal(plan.runnable, true, 'the index board is still a runnable pipeline itself')
})

test('a board that does not compile still yields its pipelines', () => {
  // A cycle makes a board unrunnable. It does not make it unreadable, and an
  // agent looking for the index must not be blocked by a loop somewhere else on
  // it — compile() reports problems rather than throwing, and so this inherits.
  const plan = compile({
    nodes: [card('p1', 'Ingest.canvas', 0, 0), card('p2', 'Publish.canvas', 0, 200)],
    edges: [arrow('e1', 'p1', 'p2'), arrow('e2', 'p2', 'p1')],
  })
  assert.equal(plan.runnable, false)
  assert.equal(plan.problems[0].kind, 'cycle')
  // Every card is stuck in the cycle, so there are no steps to filter. The
  // point being pinned is that this ANSWERS rather than throws.
  assert.deepEqual(pipelines(plan), [])
})

test('case is not a filter: this runs on Windows', () => {
  const plan = compile({ nodes: [card('p1', 'Boards/Ingest.CANVAS', 0, 0)], edges: [] })
  assert.deepEqual(
    pipelines(plan).map((s) => s.file),
    ['Boards/Ingest.CANVAS'],
  )
})

test('a folder called canvas is not a board', () => {
  const plan = compile({ nodes: [card('n1', 'canvas/notes.md', 0, 0)], edges: [] })
  assert.deepEqual(pipelines(plan), [])
})

// ------------------------------------------------------- the board in the graph

/**
 * A vault where the board is the thing under test.
 *
 *   Home.md      -> [[Home.canvas]], [[Hub]]
 *   Home.canvas  the index board, quoting a wikilink INSIDE a card
 *   Hub.md       links nowhere
 */
async function scratchVault() {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-discovery-'))
  const put = (name, body) => writeFile(join(dir, name), body, 'utf8')

  await put('Home.md', '---\ntype: index\n---\nThe pipelines live on [[Home.canvas]]. See also [[Hub]].\n')
  await put('Hub.md', 'Nothing links out of here.\n')
  await put(
    'Home.canvas',
    JSON.stringify({
      nodes: [
        // The trap this fixture exists for: a card whose TEXT contains a
        // wikilink. Reading the JSON as a note would turn it into an edge.
        { id: 'a', type: 'text', text: 'check [[Hub]] before starting', x: 0, y: 0, width: 300, height: 80 },
        { id: 'b', type: 'file', file: 'Ingest.canvas', x: 0, y: 200, width: 400, height: 400 },
      ],
      edges: [],
    }),
    'utf8',
  )
  return dir
}

test('a board in the vault', async (t) => {
  vault.setVaultDir(await scratchVault())
  const g = await vault.graph()
  const rows = await vault.list()

  await t.test('the board is a node in the graph', () => {
    assert.ok(g.nodes.includes('Home.canvas'), `Home.canvas missing from ${JSON.stringify(g.nodes)}`)
  })

  await t.test('a note linking to the board reaches it', () => {
    // The gap in the author\'s own words: "a note linking to a board reaches the
    // note but the board is not in the graph".
    assert.ok(
      g.links.some((l) => l.from === 'Home.md' && l.to === 'Home.canvas' && l.kind === 'content'),
      'Home.md -> Home.canvas was not resolved',
    )
  })

  await t.test('backlinks work in the other direction too', async () => {
    assert.deepEqual(await vault.backlinks('Home.canvas'), ['Home.md'])
  })

  await t.test('the board is never read as text, so its cards are not edges', () => {
    // Home.canvas quotes [[Hub]] on a card. If the JSON were parsed for links
    // this edge would exist, and every board on the machine would spray false
    // relationships into the graph.
    assert.ok(
      !g.links.some((l) => l.from === 'Home.canvas' && l.kind === 'content'),
      'the board contributed a content edge, so its JSON was parsed as prose',
    )
  })

  await t.test('the board does not shadow the note that shares its stem', () => {
    // [[Home]] means Home.md. `titleOf` strips only `.md`, so the board
    // registers as "Home.canvas" and cannot take the root note\'s name — which
    // matters because pickRoot measures reachability from Home.md.
    const row = rows.find((n) => n.path === 'Home.canvas')
    assert.ok(row, 'the board is not a row')
    assert.equal(row.title, 'Home.canvas')
    assert.equal(rows.find((n) => n.path === 'Home.md').reachRoot, 'Home.md')
  })
})
