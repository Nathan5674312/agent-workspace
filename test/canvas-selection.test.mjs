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
  // Named rather than inlined now that group drag reads it twice. The property
  // is the same one: additive comes from the modifiers actually held, not from
  // anything remembered.
  assert.match(
    VIEW,
    /const additive = e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey/,
    'the press does not read the real modifier keys',
  )
  assert.match(VIEW, /selectNode\(target\.id, additive\)/, 'the press does not drive selection')
})

test('a plain press inside a multi-selection does not collapse it', () => {
  // `selectNode(id, false)` replaces the selection with that one page. Applied
  // to a page already in a group, it would collapse the group the instant you
  // reached for it and a group drag could never begin — you would always end up
  // dragging the single page you happened to grab.
  assert.match(VIEW, /const inGroup = selected\.has\(target\.id\) && selected\.size > 1/, 'a group press is not detected')
  assert.match(VIEW, /if \(additive \|\| !inGroup\) selectNode\(target\.id, additive\)/, 'a plain press still collapses a group')
})

test('dragging one of a selection drags all of it', () => {
  const move = VIEW.slice(VIEW.indexOf('if (drag.current) {'), VIEW.indexOf('if (pan.current) {'))
  assert.ok(move.length > 0, 'the drag branch no longer has the shape this test reads')
  assert.match(move, /for \(const other of drag\.current\.others\)/, 'only the grabbed page moves')
  // Each page keeps its OWN offset from the pointer, so the group holds its
  // shape and every page rounds to an integer independently. One shared delta
  // rounded once would drift the whole group off the grid together.
  assert.match(move, /other\.node\.x = Math\.round\(p\.x - other\.dx\)/, 'the group does not keep its shape')
  assert.match(move, /other\.node\.y = Math\.round\(p\.y - other\.dy\)/, 'the group does not keep its shape')
})

test('an Alt+drag duplicate never carries the rest of the selection', () => {
  // That gesture drags a fresh copy. Duplicating a whole selection is a
  // different feature, and doing it by accident would silently double a board.
  const start = VIEW.indexOf('others:')
  const others = VIEW.slice(start, VIEW.indexOf('}', VIEW.indexOf(': [],', start)))
  assert.ok(start >= 0 && others.length > 0, 'the others list no longer has the shape this test reads')
  assert.match(others, /target === node/, 'a duplicate can drag the whole selection with it')
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

// --------------------------------------------------------------- removal

/**
 * This test used to assert removal did not exist, because it was "blocked on
 * Nathan" pending an undo. The undo landed with it, so the hold is over and the
 * assertions now pin how removal behaves rather than that it is absent.
 */

test('deleting a selection takes its edges with it', () => {
  // THE EDGE PASS IS THE LOAD-BEARING PART. An edge naming a node that no
  // longer exists is the dangling reference `addEdge` refuses to create: the
  // render skips it so nothing appears, while the file still carries it and the
  // info strip still counts it. Deleting a card must not produce the corruption
  // adding one is guarded against.
  const del = VIEW.slice(VIEW.indexOf('const deleteSelected ='), VIEW.indexOf('const undo ='))
  assert.ok(del.length > 0, 'deleteSelected no longer has the shape this test reads')
  assert.match(del, /doc\.nodes\.splice\(/, 'a selected card is not removed from the document')
  assert.match(del, /doc\.edges\.splice\(/, 'an edge to a removed card outlives it')
  // Both ends, or an edge INTO the deleted card survives while one out of it
  // does not, which is the half-fix that looks like it works.
  assert.match(del, /selected\.has\(e\.fromNode\)/, 'the from end is not checked')
  assert.match(del, /selected\.has\(e\.toNode\)/, 'the to end is not checked')
})

test('a keyboard removal cannot fire while text is being typed', () => {
  // Backspace inside the card editor is how a typo gets corrected. Without this
  // guard it deletes the card being typed into. `editing` alone is not enough:
  // the rename and search fields elsewhere in the pane are not this view's
  // state, so the focused element is checked directly.
  const start = VIEW.indexOf('const typing =')
  const handler = VIEW.slice(start, VIEW.indexOf('window.addEventListener', start))
  assert.ok(start >= 0 && handler.length > 0, 'the key handler no longer has the shape this test reads')
  assert.match(handler, /TEXTAREA/, 'typing in a textarea can still delete a card')
  assert.match(handler, /isContentEditable/, 'a contenteditable is not treated as text entry')
  assert.match(handler, /if \(typing\) return/, 'the guard is computed but not applied')
})

test('an undo does not record itself', () => {
  // `persist(restored, false)` is what stops Ctrl+Z becoming a toggle between
  // two boards: recording the undo would push the state it just left straight
  // back onto the stack.
  const undo = VIEW.slice(VIEW.indexOf('const undo ='), VIEW.indexOf('Delete removes the selection'))
  assert.ok(undo.length > 0, 'undo no longer has the shape this test reads')
  assert.match(undo, /persist\(restored, false\)/, 'an undo records itself and Ctrl+Z toggles')
  // Restored by parsing the stored text, the same path `load` takes, so groups,
  // colours and unknown fields come back exactly as the file had them.
  assert.match(undo, /parseCanvas\(prev\)/, 'an undo rebuilds the doc instead of parsing it')
})

test('history is dropped when the board changes', () => {
  // A snapshot belongs to a FILE. Carried across, a Ctrl+Z on the new board
  // would restore the old board and save it over the new path.
  assert.match(VIEW, /undoStack\.current = \[\]/, 'undo history survives a board change')
  assert.match(VIEW, /baseline\.current = ''/, 'the undo baseline survives a board change')
})
