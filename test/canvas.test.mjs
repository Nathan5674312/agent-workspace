/**
 * JSON Canvas parse and serialize.
 *
 * The assertions here are almost all about PRESERVATION, because that is the
 * failure mode with teeth. A canvas is a shared file: Obsidian writes groups,
 * colours and edge labels this view does not render, and if a round-trip
 * through the app dropped them, the loss would happen on the first drag, be
 * saved immediately, and look exactly like a successful save. Nothing in the UI
 * could tell you it happened.
 *
 * The second half is refusal. An empty doc and a corrupt file must not be the
 * same value, because the view saves what it holds — parsing garbage into
 * `{nodes: [], edges: []}` would overwrite the user's board with nothing.
 *
 * Pure module, no DOM: `node --test` runs the real file.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const {
  parseCanvas,
  serializeCanvas,
  emptyCanvas,
  fileNodeTitle,
  edgeAnchor,
} = await import('../src/shared/canvas.ts')

/**
 * A board using the parts of the spec this view does NOT render: a group, a
 * link node, colours, an edge with a label and explicit sides, and a key from
 * no spec version at all.
 */
const RICH = {
  nodes: [
    { id: 'a', type: 'file', file: 'Home.md', x: 0, y: 0, width: 400, height: 400 },
    { id: 'b', type: 'text', text: 'a thought', x: 500, y: 0, width: 250, height: 60, color: '4' },
    { id: 'g', type: 'group', label: 'Cluster', x: -20, y: -20, width: 900, height: 500 },
    { id: 'l', type: 'link', url: 'https://example.com', x: 0, y: 600, width: 400, height: 100 },
    { id: 'x', type: 'text', text: 'future', x: 0, y: 800, width: 100, height: 40, styleAttributes: { weight: 'bold' } },
  ],
  edges: [
    { id: 'e1', fromNode: 'a', toNode: 'b', fromSide: 'right', toSide: 'left', label: 'because', color: '2' },
  ],
  metadataThatDoesNotExistYet: { version: 99 },
}

test('a round trip preserves everything this view cannot render', () => {
  const doc = parseCanvas(JSON.stringify(RICH))
  const back = JSON.parse(serializeCanvas(doc))
  assert.deepEqual(back, RICH)
})

test('a drag preserves everything except the coordinates it moved', () => {
  // The real mutation path: the view writes x/y straight onto the node object
  // parse handed it, then serializes the same object.
  const doc = parseCanvas(JSON.stringify(RICH))
  const moved = doc.nodes.find((n) => n.id === 'b')
  moved.x = 999
  moved.y = -12

  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.nodes[1].x, 999)
  assert.equal(back.nodes[1].y, -12)
  // The colour on the node that moved is the one most at risk: a reconstructing
  // serializer would rebuild that node from the fields it knows and drop it.
  assert.equal(back.nodes[1].color, '4', 'the moved node lost a field it did not own')
  assert.deepEqual(back.nodes[2], RICH.nodes[2], 'the group was disturbed by an unrelated drag')
  assert.deepEqual(back.edges, RICH.edges)
  assert.deepEqual(back.metadataThatDoesNotExistYet, RICH.metadataThatDoesNotExistYet)
})

test('an unknown node type survives untouched', () => {
  const doc = parseCanvas(
    JSON.stringify({ nodes: [{ id: 'z', type: 'portal', x: 1, y: 2, width: 3, height: 4 }] }),
  )
  assert.equal(JSON.parse(serializeCanvas(doc)).nodes[0].type, 'portal')
})

test('an empty file is an empty board, not a corrupt one', () => {
  // This is what `save(path, '', 0)` leaves behind, and what "+ New" reads back
  // on the very first open. Throwing here would make every new board unopenable.
  assert.deepEqual(parseCanvas(''), emptyCanvas())
  assert.deepEqual(parseCanvas('   \n  '), emptyCanvas())
})

test('a canvas with no edges key is valid, and gains an empty one', () => {
  const doc = parseCanvas(JSON.stringify({ nodes: [] }))
  assert.deepEqual(doc.edges, [])
})

test('malformed input throws rather than yielding an empty board', () => {
  // Each of these would render as a blank canvas if it parsed, and the first
  // drag would then save that blank over the user's file.
  assert.throws(() => parseCanvas('{ not json'), /valid canvas/)
  assert.throws(() => parseCanvas('[]'), /top level is not an object/)
  assert.throws(() => parseCanvas('"a string"'), /top level is not an object/)
  assert.throws(() => parseCanvas(JSON.stringify({ nodes: 'lots' })), /`nodes` is not a list/)
  assert.throws(() => parseCanvas(JSON.stringify({ edges: 7 })), /`edges` is not a list/)
})

test('a node with unusable geometry is refused at the boundary', () => {
  // NaN does not throw anywhere downstream: it flows through the transform and
  // the board silently renders nothing, with no error to find.
  const bad = { nodes: [{ id: 'a', type: 'text', x: 0, y: null, width: 10, height: 10 }] }
  assert.throws(() => parseCanvas(JSON.stringify(bad)), /bad y/)

  const missing = { nodes: [{ id: 'a', type: 'text', x: 0, y: 0, width: 10 }] }
  assert.throws(() => parseCanvas(JSON.stringify(missing)), /bad height/)
})

test('serialize writes the shape Obsidian writes', () => {
  // Two-space indent and a trailing newline, so the other app touching the file
  // does not produce a whole-file formatting diff in git.
  const text = serializeCanvas(emptyCanvas())
  assert.ok(text.endsWith('\n'))
  assert.equal(text, '{\n  "nodes": [],\n  "edges": []\n}\n')
})

test('a file card is titled by its filename, not its path', () => {
  assert.equal(fileNodeTitle('Business/Plans/Q3.md'), 'Q3')
  assert.equal(fileNodeTitle('Home.md'), 'Home')
  // Non-markdown attachments keep their extension: dropping it would make
  // "diagram.png" and "diagram.md" the same label.
  assert.equal(fileNodeTitle('assets/diagram.png'), 'diagram.png')
})

test('an edge with no declared sides attaches on the axis that separates', () => {
  const left = { x: 0, y: 0, width: 100, height: 100 }
  const right = { x: 400, y: 0, width: 100, height: 100 }
  const below = { x: 0, y: 400, width: 100, height: 100 }

  // Side by side: leaves the right edge of one, arrives at the left of the other.
  const h = edgeAnchor(left, right)
  assert.deepEqual(h.from, { x: 100, y: 50 })
  assert.deepEqual(h.to, { x: 400, y: 50 })

  // Stacked: bottom to top. Centre-to-centre would run the line through both
  // cards, which is what this function exists to avoid.
  const v = edgeAnchor(left, below)
  assert.deepEqual(v.from, { x: 50, y: 100 })
  assert.deepEqual(v.to, { x: 50, y: 400 })

  // Reversed, so the sides must swap rather than the line being drawn backwards.
  const r = edgeAnchor(right, left)
  assert.deepEqual(r.from, { x: 400, y: 50 })
  assert.deepEqual(r.to, { x: 100, y: 50 })
})
