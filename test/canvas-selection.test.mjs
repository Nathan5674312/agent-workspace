/**
 * Selection — single and multi.
 *
 * Pure UI. The whole point of these assertions is that selection NEVER reaches
 * the file. JSON Canvas has no concept of a selected node, so inventing a key
 * for it would put this app's transient state into a document Obsidian also
 * writes, and Obsidian is under no obligation to preserve it. A board would
 * then differ on disk depending on what happened to be highlighted when it was
 * last saved.
 *
 * The second thing worth pinning is that selection did not smuggle in a
 * removal path. `Set.delete` on a selection removes an id from a highlight;
 * `nodes.splice` removes a card from someone's board. They read similarly and
 * only one of them is inside the green light.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource, readRaw } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')
const CSS = readRaw('canvas.css')

const BOARD = {
  nodes: [
    { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100, color: '1' },
    { id: 'b', type: 'text', text: 'b', x: 200, y: 0, width: 100, height: 100 },
  ],
  edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'keep me' }],
  unknownTopLevel: { v: 1 },
}

/** Exactly what CanvasView's selectNode does. */
const select = (prev, id, additive) => {
  if (!additive) return new Set([id])
  const next = new Set(prev)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// -------------------------------------------------------------- pure UI state

test('a plain press replaces the selection, a modifier press toggles it', () => {
  let s = new Set()
  s = select(s, 'a', false)
  assert.deepEqual([...s], ['a'])

  s = select(s, 'b', true)
  assert.deepEqual([...s].sort(), ['a', 'b'], 'a modifier press did not extend the selection')

  // Toggling off is what lets a mis-click be undone without starting over.
  s = select(s, 'a', true)
  assert.deepEqual([...s], ['b'], 'a second modifier press did not deselect')

  s = select(s, 'a', false)
  assert.deepEqual([...s], ['a'], 'a plain press did not replace the selection')
})

test('every transition returns a NEW set', () => {
  // React compares by identity. A mutated Set changes the selection without
  // re-rendering it, so the highlight lags one click behind the truth.
  const before = new Set(['a'])
  const after = select(before, 'b', true)
  assert.notEqual(after, before, 'the selection Set was mutated in place')
  assert.deepEqual([...before], ['a'], 'the previous selection was mutated')
})

// ------------------------------------------------------------- never persisted

test('selecting cards changes nothing about the file', () => {
  // THE LOAD-BEARING ASSERTION. Selection is UI state; a round trip after any
  // amount of selecting must be byte-identical.
  const text = `${JSON.stringify(BOARD, null, 2)}\n`
  const doc = parseCanvas(text)

  // Selection is driven off the REAL nodes in the doc, not off a standalone
  // list of ids. The previous version of this test ran the replica over a Set
  // built from string literals and never touched `doc` at all, so it was a
  // plain round-trip test wearing a selection test's name: it would have passed
  // unchanged against a view that wrote `selected: true` onto every node.
  const keysBefore = doc.nodes.map((n) => Object.keys(n).join(','))
  let s = new Set()
  for (const n of doc.nodes) s = select(s, n.id, true)
  assert.equal(s.size, doc.nodes.length, 'the fixture did not select the real nodes')
  for (const n of doc.nodes) s = select(s, n.id, true)
  assert.equal(s.size, 0, 'the fixture did not exercise deselection')

  // No node may have gained, lost or reordered a key.
  assert.deepEqual(
    doc.nodes.map((n) => Object.keys(n).join(',')),
    keysBefore,
    'selecting a card altered the node object',
  )
  assert.equal(serializeCanvas(doc), text, 'selection reached the file')
})

test('no selection key is ever written to a node', () => {
  const doc = parseCanvas(JSON.stringify(BOARD))
  const back = JSON.parse(serializeCanvas(doc))
  for (const n of back.nodes) {
    for (const key of ['selected', 'isSelected', 'active', 'focused']) {
      assert.equal(key in n, false, `node ${n.id} carries a UI key: ${key}`)
    }
  }
  assert.deepEqual(back.unknownTopLevel, { v: 1 }, 'an unknown top-level key was disturbed')
})

// ------------------------------------------------------------------- wiring

test('selection lives in state, not on the document', () => {
  assert.match(VIEW, /useState<ReadonlySet<string>>\(new Set\(\)\)/, 'selection is not React state')
  assert.doesNotMatch(VIEW, /n\.selected|node\.selected|target\.selected/, 'selection hit a node')
  // The view's OWN transition, not the replica above. React compares by
  // identity, so reusing `prev` updates the selection without re-rendering it
  // and the highlight lags one click behind the truth.
  assert.match(VIEW, /const next = new Set\(prev\)/, 'the view mutates the held selection Set')
})

test('the press decides additive from the real modifier keys', () => {
  assert.match(
    VIEW,
    /selectNode\(target\.id, e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey\)/,
    'the press does not drive selection',
  )
})

test('a modifier click on a file card selects instead of opening it', () => {
  // Otherwise a file card could never join a multi-selection without
  // navigating away from the board.
  //
  // Asserted as MEMBERSHIP per modifier, scoped to the guard region, rather
  // than as one exact expression. The previous form pinned the literal list
  // `shiftKey || ctrlKey || metaKey` AND required `onOpenNote` on the very next
  // line, so adding a fourth modifier — which is exactly the fix for the
  // Alt+press double-action — broke a test that had nothing to say about it.
  const guard = VIEW.slice(VIEW.indexOf('onClick={(e) => {'), VIEW.indexOf('onOpenNote(n.file!)'))
  assert.ok(guard.length > 0, 'the file card click handler no longer has the shape this test reads')
  for (const key of ['shiftKey', 'ctrlKey', 'metaKey']) {
    assert.match(guard, new RegExp(`e\\.${key}`), `a ${key} click on a file card still opens it`)
  }
  assert.match(guard, /\breturn\b/, 'the guard never returns early')
})

test('a press on empty board clears the selection, and so does changing board', () => {
  assert.match(VIEW, /setSelected\(new Set\(\)\)/, 'the selection is never cleared')
  // Two call sites: the background press and the load effect.
  assert.ok(
    VIEW.match(/setSelected\(new Set\(\)\)/g).length >= 2,
    'the selection survives a change of board',
  )
})

test('selection is an outline so it cannot be mistaken for a card colour', () => {
  // A card's border may already carry its `color` from the file. Overwriting it
  // would make selecting a red card look like recolouring it.
  assert.match(CSS, /\.canvas-node\[data-selected\]\s*\{\s*outline:/, 'selection is not an outline')
})

test('selection did not smuggle in a removal path', () => {
  // Set.delete removes an id from a highlight. nodes.splice removes a card from
  // someone's board. Removal is still blocked on Nathan.
  // Narrowed to what actually removes from the DOCUMENT. The previous form
  // banned any `.filter(` on nodes or edges, which is ordinary read-only code —
  // culling off-screen cards, counting the edges touching one — and would have
  // false-positived on z-order, the next item in the backlog, since reordering
  // is a splice. A ban that fires on correct code teaches people to delete it.
  assert.doesNotMatch(VIEW, /doc\.nodes\.splice\(/, 'a card can be removed from the document')
  assert.doesNotMatch(VIEW, /doc\.edges\.splice\(/, 'an edge can be removed from the document')
  assert.doesNotMatch(VIEW, /doc\.nodes\s*=\s/, 'the node list can be replaced wholesale')
  assert.doesNotMatch(VIEW, /doc\.edges\s*=\s/, 'the edge list can be replaced wholesale')
})
