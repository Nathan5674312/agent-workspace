/**
 * Board-switch lifecycle — what must be torn down when `path` changes.
 *
 * The defect these pin is the worst one this view has had. `CanvasView` is not
 * remounted when you pick a different board; only the `path` prop changes. So
 * anything held in state belongs to the OLD file until something clears it,
 * and the read of the new file is async — there is a real window, tens of
 * milliseconds or longer on a slow disk, where the previous board's `doc` is on
 * screen underneath the new board's name.
 *
 * A drag in that window calls `persist(doc)`, which sends the OLD board's
 * content to the NEW board's path. The only thing between that and destroying
 * the new board is the mtime guard, and two `.canvas` files can easily share an
 * mtime — a `git checkout`, an unzip, or a sync client all produce that.
 *
 * Worse, the error page's guard is `error && !doc`. With a stale `doc` still
 * present that condition is false, so a board that fails to parse is not
 * reported at all: the previous board is displayed as if it were the broken
 * one, and the module's stated invariant — "`doc` stays null, so there is
 * nothing for a drag to mutate and nothing for a save to write" — is false
 * exactly when a board was already open.
 *
 * These are source assertions because `CanvasView.tsx` cannot be imported by
 * `node --test` (JSX plus a stylesheet import). They are scoped to the load
 * effect's body and pin ORDERING, which is the actual invariant: the teardown
 * has to happen before the branch, not inside one arm of it.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')

/** The body of the `path` load effect, up to the point it branches on `!path`. */
const teardown = () => {
  const effect = VIEW.slice(VIEW.indexOf('let cancelled = false'), VIEW.indexOf('void load()'))
  const branch = effect.indexOf('if (!path)')
  assert.ok(branch > 0, 'the load effect no longer has the shape this test reads')
  return effect.slice(0, branch)
}

test('a board change drops the previous board before reading the new one', () => {
  // THE LOAD-BEARING ASSERTION. Unconditionally, and before the branch: an
  // arm of the branch is too late, because the common case — switching from
  // one real board to another — does not take that arm at all.
  const before = teardown()
  assert.match(before, /setDoc\(null\)/, 'the previous board survives a change of path')
  // The lost-update token itself, which is the value a stray save would send.
  assert.match(before, /mtimeRef\.current = 0/, "the previous board's mtime survives a change")
})

test('an in-progress text edit does not survive a board change', () => {
  // `editing` holds a node id from the old board. Carried across, it either
  // matches nothing or, far worse, collides with an id on the new board and
  // opens an editor on a card the user never touched.
  assert.match(teardown(), /setEditing\(null\)/, 'an open editor survives a change of board')
})

test('a half-finished connection does not survive a board change', () => {
  // Pick an endpoint on board A, switch to board B, pick a second endpoint:
  // addEdge is called with one id from each file. The result is an edge naming
  // a node that does not exist in the board it was written to.
  assert.match(teardown(), /setLinkFrom\(null\)/, 'a pending endpoint survives a change of board')
})

test('an edge is refused unless BOTH endpoints exist on this board', () => {
  // The belt to the braces above. Anything that can reach addEdge with a
  // foreign id must not be able to write a dangling reference into a file
  // Obsidian also reads.
  const add = VIEW.slice(VIEW.indexOf('const addEdge ='), VIEW.indexOf('const commitText ='))
  assert.match(add, /nodes\.some\(\(n\) => n\.id === fromNode\)/, 'the source id is not checked')
  assert.match(add, /nodes\.some\(\(n\) => n\.id === toNode\)/, 'the target id is not checked')
})

test('a dangling edge is invisible but real, which is why it must not be written', () => {
  // Behavioural, not a replica: this shows what the guard prevents. The file
  // happily carries an edge to a missing node, the view draws nothing for it,
  // and the count still includes it — so the board reports a connection that
  // does not exist and nothing anywhere reports why.
  const doc = parseCanvas(
    JSON.stringify({
      nodes: [{ id: 'here', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10 }],
      edges: [{ id: 'dangling', fromNode: 'here', toNode: 'gone' }],
    }),
  )
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const drawable = doc.edges.filter((e) => byId.has(e.fromNode) && byId.has(e.toNode))
  assert.equal(drawable.length, 0, 'the fixture does not actually produce a dangling edge')
  assert.equal(doc.edges.length, 1, 'the file did not keep the dangling edge')
  assert.match(serializeCanvas(doc), /dangling/, 'a dangling edge does reach disk')
})

test('the selection is still dropped too', () => {
  // Already true before this fix; asserted here so the teardown stays one
  // place rather than drifting back apart.
  assert.match(teardown(), /setSelected\(new Set\(\)\)/, 'the selection survives a change of board')
})

// ------------------------------------------------------- preservation rule

test('the preservation rule is intact: a board still round-trips untouched', () => {
  // Carried in every back-test. Nothing about tearing down view state may
  // change what a file looks like coming back out.
  const RICH = {
    nodes: [
      { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100, color: '4' },
      { id: 'g', type: 'group', label: 'G', x: -10, y: -10, width: 300, height: 300 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'g', label: 'keep', fromSide: 'top', toEnd: 'none' }],
    somethingFromNoSpec: { v: 2 },
  }
  const text = `${JSON.stringify(RICH, null, 2)}\n`
  assert.equal(serializeCanvas(parseCanvas(text)), text)
})
