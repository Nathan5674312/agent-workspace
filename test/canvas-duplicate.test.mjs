/**
 * Duplicate a card — Alt+drag.
 *
 * The risk here is not the gesture, it is WHAT GETS COPIED. A duplicate built
 * from the fields this view knows how to render — id, type, x, y, width,
 * height, text — looks completely correct on screen and is a silently
 * downgraded card: the colour is gone, a file card's `subpath` is gone, a
 * group's `background` is gone, and any field from a later spec version is
 * gone. The copy saves immediately, so the loss is on disk before anyone could
 * notice it.
 *
 * That is the preservation rule applied to duplication, and it is the same
 * failure the doc-level rule exists to prevent, one level down.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const { parseCanvas, serializeCanvas, canvasId } = await import('../src/shared/canvas.ts')

const VIEW = readFileSync(
  new URL('../src/renderer/panes/vault/CanvasView.tsx', import.meta.url),
  'utf8',
)

/** A card carrying things this view cannot render, plus one from no spec at all. */
const RICH = {
  nodes: [
    {
      id: 'src',
      type: 'file',
      file: 'Notes/Alpha.md',
      subpath: '#Heading',
      x: 10,
      y: 20,
      width: 400,
      height: 400,
      color: '#FF0000',
      styleAttributes: { weight: 'bold' },
    },
    { id: 'other', type: 'text', text: 'untouched', x: 900, y: 0, width: 100, height: 100 },
  ],
  edges: [{ id: 'e', fromNode: 'src', toNode: 'other', label: 'keep me' }],
}

/** Exactly what CanvasView's Alt+drag builds. */
const OFFSET = 24
const duplicate = (node) => ({
  ...node,
  id: canvasId(),
  x: node.x + OFFSET,
  y: node.y + OFFSET,
})

// ------------------------------------------------------------------- format

test('a duplicate carries every field the view cannot render', () => {
  const doc = parseCanvas(JSON.stringify(RICH))
  const source = doc.nodes.find((n) => n.id === 'src')
  doc.nodes.push(duplicate(source))

  const back = JSON.parse(serializeCanvas(doc))
  const copy = back.nodes[2]
  assert.equal(copy.type, 'file')
  assert.equal(copy.file, 'Notes/Alpha.md')
  assert.equal(copy.subpath, '#Heading', 'subpath was dropped from the copy')
  assert.equal(copy.color, '#FF0000', 'colour was dropped from the copy')
  assert.deepEqual(
    copy.styleAttributes,
    { weight: 'bold' },
    'a field from no spec version was dropped',
  )
})

test('the copy is offset and carries a fresh id', () => {
  const doc = parseCanvas(JSON.stringify(RICH))
  const source = doc.nodes.find((n) => n.id === 'src')
  const copy = duplicate(source)
  doc.nodes.push(copy)

  assert.notEqual(copy.id, source.id, 'two nodes share an id, so every edge is ambiguous')
  assert.match(copy.id, /^[0-9a-f]{32}$/, 'the id is not the shape Obsidian writes')
  assert.equal(copy.x, source.x + OFFSET)
  assert.equal(copy.y, source.y + OFFSET)
})

test('duplicating does not disturb the original, the other cards, or the edges', () => {
  const doc = parseCanvas(JSON.stringify(RICH))
  const source = doc.nodes.find((n) => n.id === 'src')
  doc.nodes.push(duplicate(source))

  const back = JSON.parse(serializeCanvas(doc))
  assert.deepEqual(back.nodes[0], RICH.nodes[0], 'the original was mutated by copying it')
  assert.deepEqual(back.nodes[1], RICH.nodes[1], 'an unrelated card was disturbed')
  assert.deepEqual(back.edges, RICH.edges, 'the edges were disturbed')
})

test('an edge still names exactly one node after a duplicate', () => {
  // The copy inherits no edges, which is correct: JSON Canvas edges name node
  // ids, and cloning them would silently double every connection on the board.
  const doc = parseCanvas(JSON.stringify(RICH))
  const source = doc.nodes.find((n) => n.id === 'src')
  const copy = duplicate(source)
  doc.nodes.push(copy)

  const touching = doc.edges.filter((e) => e.fromNode === copy.id || e.toNode === copy.id)
  assert.equal(touching.length, 0, 'the duplicate inherited its original edges')
  assert.equal(doc.edges.length, 1, 'the edge count changed')
})

// ------------------------------------------------------------------- wiring

test('the view spreads the source node rather than rebuilding it', () => {
  // THE LOAD-BEARING ASSERTION. Picking known fields renders identically and
  // loses everything above.
  assert.match(VIEW, /\.\.\.node,\s*id: canvasId\(\),/, 'the copy is not spread from the source')
  assert.match(VIEW, /x: node\.x \+ DUPLICATE_OFFSET/, 'the copy is not offset')
})

test('the duplicate is pushed onto the parsed doc, and it is the COPY that drags', () => {
  // Same rule as addCard: push, never rebuild the document.
  assert.match(VIEW, /doc\.nodes\.push\(copy\)/, 'the duplicate is not pushed onto doc.nodes')
  assert.doesNotMatch(VIEW, /setDoc\(\s*\{\s*\.\.\./, 'the view spreads the doc into a new object')
  assert.match(VIEW, /created: target !== node/, 'the gesture cannot tell a copy from a move')
})

test('an Alt+press that never moves still saves', () => {
  // Otherwise the duplicate is on screen and not on disk, and vanishes on
  // reload with no error anywhere.
  assert.match(
    VIEW,
    /drag\.current\?\.moved \|\| drag\.current\?\.created/,
    'a duplicate that was never dragged is not persisted',
  )
})

test('an Alt press on a file card duplicates WITHOUT also opening the note', () => {
  // THE LOAD-BEARING ASSERTION for this fix. One gesture, two actions: the
  // Alt press duplicates the card, `onUp` persists it because `created` is
  // true, and then the click reaches the file card's <button> and navigates to
  // the note — unmounting the board the user was working on. `moved` is false
  // for a press that never travels, so `draggedLast` does not catch it, and
  // altKey was missing from the modifier list that catches the others.
  const guard = VIEW.slice(VIEW.indexOf('onClick={(e) => {'), VIEW.indexOf('onOpenNote(n.file!)'))
  assert.ok(guard.length > 0, 'the file card click handler no longer has the shape this test reads')
  assert.match(guard, /e\.altKey/, 'an Alt press on a file card duplicates it and opens it too')
})

test('no delete or removal affordance came along with it', () => {
  // Duplication is additive and inside the green light. Removal is not, and is
  // still blocked on Nathan pending an undo or a confirm.
  assert.doesNotMatch(VIEW, /\.splice\(/, 'the view grew a removal path')
  assert.doesNotMatch(VIEW, /nodes\.filter\(/, 'the view grew a node removal path')
  assert.doesNotMatch(VIEW, /edges\.filter\(/, 'the view grew an edge removal path')
})
