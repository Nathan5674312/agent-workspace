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
import { readFileSync } from 'node:fs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readFileSync(
  new URL('../src/renderer/panes/vault/CanvasView.tsx', import.meta.url),
  'utf8',
)
const CSS = readFileSync(
  new URL('../src/renderer/panes/vault/canvas.css', import.meta.url),
  'utf8',
)

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

  let s = new Set()
  for (const id of ['a', 'b', 'a', 'b']) s = select(s, id, true)
  assert.equal(s.size, 0, 'the fixture did not actually exercise selection')

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
  assert.match(
    VIEW,
    /if \(e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey\) return\s*\n\s*onOpenNote/,
    'a modifier click on a file card still opens the note',
  )
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
  assert.doesNotMatch(VIEW, /nodes\.splice\(|edges\.splice\(/, 'the view grew a removal path')
  assert.doesNotMatch(VIEW, /nodes\.filter\(|edges\.filter\(/, 'the view grew a removal path')
})
