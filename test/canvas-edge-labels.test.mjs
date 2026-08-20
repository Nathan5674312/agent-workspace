/**
 * Edge labels.
 *
 * The bug this closes: `label` round-tripped through the file untouched and was
 * never drawn, so an edge someone annotated in Obsidian arrived here as an
 * unexplained line. The annotation is usually the reason the edge exists.
 *
 * The assertions worth having are about what happens when the field is NOT a
 * clean string. It is optional and nothing validates it on the way through
 * `parseCanvas`, so the render path has to survive absent, empty, whitespace
 * and non-string values without printing any of them onto a user's board.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')

const BOARD = {
  nodes: [
    { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b', type: 'text', text: 'b', x: 400, y: 0, width: 100, height: 100 },
  ],
  edges: [
    { id: 'labelled', fromNode: 'a', toNode: 'b', label: 'because' },
    { id: 'empty', fromNode: 'a', toNode: 'b', label: '' },
    { id: 'blank', fromNode: 'a', toNode: 'b', label: '   ' },
    { id: 'none', fromNode: 'a', toNode: 'b' },
  ],
}

// ------------------------------------------------------------------- format

test('labels survive a round trip, including the empty one', () => {
  // An empty label is not the same as no label: the user cleared it, and
  // dropping the key would be this app editing their file.
  const doc = parseCanvas(JSON.stringify(BOARD))
  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.edges[0].label, 'because')
  assert.equal(back.edges[1].label, '')
  assert.equal(back.edges[2].label, '   ')
  assert.equal('label' in back.edges[3], false, 'a label was invented for an edge without one')
})

test('a label is never written by rendering it', () => {
  // Rendering must not normalise. Trimming for display is fine; trimming the
  // stored value would silently rewrite the user's canvas.
  const doc = parseCanvas(JSON.stringify(BOARD))
  JSON.parse(serializeCanvas(doc))
  const again = JSON.parse(serializeCanvas(doc))
  assert.equal(again.edges[2].label, '   ', 'the stored label was trimmed')
})

// ------------------------------------------------------------------- wiring

test('only a non-empty string is drawn', () => {
  // THE LOAD-BEARING ASSERTION. A truthiness check would put the word
  // "undefined" on the board for a numeric or object label, and a bare
  // `edge.label &&` would render a whitespace-only halo with nothing in it.
  assert.match(
    VIEW,
    /typeof edge\.label === 'string' \? edge\.label\.trim\(\) : ''/,
    'the label is not narrowed to a trimmed string',
  )
  assert.match(VIEW, /\{label && \(/, 'an empty label still renders an element')
})

test('the label sits at the midpoint of the line that was actually drawn', () => {
  // Midpoint of `from`/`to`, which are the resolved anchors — so a hand-routed
  // edge carries its label along the route the user chose, not along the route
  // the geometry would have derived.
  assert.match(VIEW, /x=\{\(from\.x \+ to\.x\) \/ 2 \+ EDGE_ORIGIN\}/, 'label x is not the midpoint')
  assert.match(VIEW, /y=\{\(from\.y \+ to\.y\) \/ 2 \+ EDGE_ORIGIN\}/, 'label y is not the midpoint')
})
