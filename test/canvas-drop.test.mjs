/**
 * Dropping a note from the tree onto a board.
 *
 * The gesture spans two components that never import each other — FolderTree
 * starts the drag, CanvasView accepts it — so the thing worth pinning is that
 * they agree, and that they agree via a SHARED CONSTANT rather than two string
 * literals that drift.
 *
 * Pure source reads plus the shared module. No DOM: drag-and-drop is a browser
 * pipeline, and the parts of it worth testing here are the contract between the
 * two ends and the guards, not the browser.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { CANVAS_DROP_MIME, PAGE_SIZE, parseCanvas, serializeCanvas } = await import(
  '../src/shared/canvas.ts'
)

const VIEW = readSource('CanvasView.tsx')
const TREE = readSource('FolderTree.tsx')

// ------------------------------------------------------------ the contract

test('both ends of the drag use the one shared type', () => {
  // Two literals would look identical in review and diverge on the first
  // rename, leaving a drag that starts and can never be dropped.
  assert.match(TREE, /CANVAS_DROP_MIME/, 'the tree writes a literal drag type')
  assert.match(VIEW, /CANVAS_DROP_MIME/, 'the board reads a literal drag type')
  assert.doesNotMatch(TREE, /setData\('application/, 'the tree hardcodes the type')
})

test('the drag type is lowercase, because the DnD API lowercases it', () => {
  // setData/getData normalise the type. A constant with any uppercase in it
  // would be stored lowercased and never match on the way back out.
  assert.equal(CANVAS_DROP_MIME, CANVAS_DROP_MIME.toLowerCase())
  // And it is not text/plain, or the board would accept a paragraph dragged in
  // from a browser as though it were a vault path.
  assert.notEqual(CANVAS_DROP_MIME, 'text/plain')
})

// ------------------------------------------------------------ the guards

test('dragover preventDefaults, or no drop ever fires', () => {
  // The default action for a dragged thing is to refuse it, silently. This is
  // the commonest reason a drop target does nothing at all.
  const over = VIEW.slice(VIEW.indexOf('const onDragOver ='), VIEW.indexOf('const onDrop ='))
  assert.ok(over.length > 0, 'onDragOver no longer has the shape this test reads')
  assert.match(over, /e\.preventDefault\(\)/, 'dragover does not accept the drag')
  assert.match(over, /types\.includes\(CANVAS_DROP_MIME\)/, 'the board claims drags it cannot take')
})

test('a drop with no note path is left for someone else', () => {
  const drop = VIEW.slice(VIEW.indexOf('const onDrop ='), VIEW.indexOf('const addEdge ='))
  assert.ok(drop.length > 0, 'onDrop no longer has the shape this test reads')
  // Returns BEFORE preventDefault, so an unrelated drag that reaches the board
  // falls through rather than being swallowed.
  const beforeDefault = drop.slice(0, drop.indexOf('e.preventDefault()'))
  assert.match(beforeDefault, /if \(!file\) return/, 'an unrelated drop is swallowed')
  assert.match(beforeDefault, /if \(!doc\) return/, 'a drop with no board open is not refused')
})

test('only notes are draggable, never folders', () => {
  // A folder is not something a board can hold, and a drag that can never be
  // dropped anywhere is worse than no drag.
  const note = TREE.slice(TREE.indexOf('vault-tree-item vault-tree-note'), TREE.length)
  assert.match(note, /draggable/, 'notes cannot be dragged')
  const folder = TREE.slice(
    TREE.indexOf('vault-tree-item vault-tree-folder'),
    TREE.indexOf('vault-tree-item vault-tree-note'),
  )
  assert.ok(folder.length > 0, 'the folder row no longer has the shape this test reads')
  assert.doesNotMatch(folder, /draggable/, 'a folder can be dragged onto a board')
})

// ------------------------------------------------------- what lands

test('a dropped note becomes a page-sized file node', () => {
  const drop = VIEW.slice(VIEW.indexOf('const onDrop ='), VIEW.indexOf('const addEdge ='))
  assert.match(drop, /type: 'file'/, 'a dropped note is not a file card')
  assert.match(drop, /canvasId\(\)/, 'a dropped card invents its own id')
  assert.match(drop, /\.\.\.PAGE_SIZE/, 'a dropped card is not the house size')
  // Centred on the cursor, and rounded: the spec declares x/y integer and
  // toWorld divides by a fractional scale.
  assert.match(drop, /Math\.round\(p\.x - PAGE_SIZE\.width \/ 2\)/, 'a dropped card is not centred')
  assert.match(drop, /Math\.round\(p\.y - PAGE_SIZE\.height \/ 2\)/, 'a dropped card is not centred')
})

test('the node a drop builds is one a canvas file can actually hold', () => {
  // The shape assertions above are about the source. This one proves the shape
  // they describe survives the format: a file node built this way parses back
  // out unchanged, so a dropped card is not something only this app can read.
  const node = {
    id: 'abc123',
    type: 'file',
    file: 'Notes/Alpha.md',
    x: -306,
    y: -396,
    ...PAGE_SIZE,
  }
  const text = serializeCanvas({ nodes: [node], edges: [] })
  const back = parseCanvas(text)
  assert.deepEqual(back.nodes[0], node, 'a dropped card does not round-trip')
  assert.equal(back.nodes[0].width, 612)
  assert.equal(back.nodes[0].height, 792)
})

test('a dropped card is added to the document, never rebuilt into a new one', () => {
  const drop = VIEW.slice(VIEW.indexOf('const onDrop ='), VIEW.indexOf('const addEdge ='))
  // The preservation rule: pushing onto the array parseCanvas returned keeps
  // every group, colour and unknown field the file arrived with.
  assert.match(drop, /doc\.nodes\.push\(node\)/, 'a drop rebuilds the document')
  assert.match(drop, /void persist\(doc\)/, 'a dropped card is never saved')
})
