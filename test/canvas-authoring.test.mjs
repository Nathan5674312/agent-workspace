/**
 * In-app card creation and edge drawing.
 *
 * Two halves, because the risk is in two places.
 *
 * The FORMAT half builds a card and an edge exactly the way CanvasView builds
 * them — same `canvasId()`, same `NEW_TEXT_SIZE`, pushed onto a parsed doc —
 * and checks the result is still a canvas Obsidian can read, with everything it
 * did not author left alone. That is the preservation rule applied to writing
 * rather than to dragging: the first card added to a board authored elsewhere
 * is the moment groups, colours and edge labels would be lost, and the loss
 * would save immediately and look like success.
 *
 * The WIRING half reads CanvasView.tsx as text, because the view cannot be
 * imported here — it is JSX and it imports a stylesheet, neither of which
 * `node --test` resolves. Source assertions are weak on their own, so they are
 * kept narrow and aimed at the specific decisions that would silently break
 * Obsidian compatibility if someone rewrote them.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const { parseCanvas, serializeCanvas, canvasId, NEW_TEXT_SIZE } = await import(
  '../src/shared/canvas.ts'
)

const VIEW = readFileSync(
  new URL('../src/renderer/panes/vault/CanvasView.tsx', import.meta.url),
  'utf8',
)

/** A board authored in Obsidian, using parts of the spec this view never renders. */
const AUTHORED = {
  nodes: [
    { id: 'a', type: 'file', file: 'Home.md', x: 0, y: 0, width: 400, height: 400, color: '4' },
    { id: 'g', type: 'group', label: 'Cluster', x: -20, y: -20, width: 900, height: 500 },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'g', label: 'because', color: '2' }],
  metadataThatDoesNotExistYet: { version: 99 },
}

/** The card CanvasView.addCard pushes, at a given world point. */
const newCard = (x, y) => ({
  id: canvasId(),
  type: 'text',
  text: '',
  x: Math.round(x - NEW_TEXT_SIZE.width / 2),
  y: Math.round(y - NEW_TEXT_SIZE.height / 2),
  ...NEW_TEXT_SIZE,
})

// ------------------------------------------------------------------- format

test('a new card leaves every authored field on the board untouched', () => {
  const doc = parseCanvas(JSON.stringify(AUTHORED))
  doc.nodes.push(newCard(0, 0))

  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.nodes.length, 3)
  // The two authored nodes, byte for byte. A view that rebuilt the doc to add a
  // card would drop the colour and the group first.
  assert.deepEqual(back.nodes[0], AUTHORED.nodes[0])
  assert.deepEqual(back.nodes[1], AUTHORED.nodes[1])
  assert.deepEqual(back.edges, AUTHORED.edges)
  assert.deepEqual(back.metadataThatDoesNotExistYet, AUTHORED.metadataThatDoesNotExistYet)
})

test('a new card is a valid text node that parses back', () => {
  const doc = parseCanvas(JSON.stringify(AUTHORED))
  const card = newCard(500, 300)
  doc.nodes.push(card)

  // Round-tripping through parse is the real check: parseCanvas refuses a node
  // with unusable geometry, so a card built with a NaN centre fails here rather
  // than rendering as an invisible board later.
  const reparsed = parseCanvas(serializeCanvas(doc))
  const found = reparsed.nodes.find((n) => n.id === card.id)
  assert.equal(found.type, 'text')
  assert.equal(found.text, '')
  assert.equal(found.width, NEW_TEXT_SIZE.width)
  assert.equal(found.height, NEW_TEXT_SIZE.height)
  // Centred on the point, not placed at it: a card that appeared with its
  // corner under the cursor would sit off-centre in the viewport it was made in.
  assert.equal(found.x, 500 - NEW_TEXT_SIZE.width / 2)
  assert.equal(found.y, 300 - NEW_TEXT_SIZE.height / 2)
})

test('ids are unique and shaped like the ones Obsidian writes', () => {
  // Obsidian writes a dashless uuid. A counter would collide the moment two
  // machines edited the same board, which is the normal case for a synced vault.
  const ids = new Set(Array.from({ length: 200 }, () => canvasId()))
  assert.equal(ids.size, 200)
  assert.match(canvasId(), /^[0-9a-f]{32}$/)
})

test('a new edge names its endpoints and declares no sides', () => {
  const doc = parseCanvas(JSON.stringify(AUTHORED))
  const card = newCard(0, 0)
  doc.nodes.push(card)
  doc.edges.push({ id: canvasId(), fromNode: 'a', toNode: card.id })

  const back = JSON.parse(serializeCanvas(doc))
  const edge = back.edges[1]
  assert.equal(edge.fromNode, 'a')
  assert.equal(edge.toNode, card.id)
  // fromSide/toSide are optional in the spec and edgeAnchor derives them from
  // the geometry. Writing them would freeze a routing choice that should follow
  // the cards when they move.
  assert.equal(edge.fromSide, undefined)
  assert.equal(edge.toSide, undefined)
  // The authored edge kept its label and colour.
  assert.deepEqual(back.edges[0], AUTHORED.edges[0])
})

// ------------------------------------------------------------------- wiring

test('the view pushes onto the parsed doc rather than rebuilding it', () => {
  // Mutation through the doc is the whole preservation rule. `setDoc({...doc})`
  // or a `.map` over nodes here would pass every format test above and still
  // lose a user's groups on the first card.
  assert.match(VIEW, /doc\.nodes\.push\(/, 'addCard does not push onto doc.nodes')
  assert.match(VIEW, /doc\.edges\.push\(/, 'addEdge does not push onto doc.edges')
  assert.doesNotMatch(VIEW, /setDoc\(\s*\{\s*\.\.\./, 'the view spreads the doc into a new object')
})

test('new cards and edges use the shared id and size helpers', () => {
  assert.match(VIEW, /canvasId\(\)/, 'the view invents its own ids')
  assert.match(VIEW, /NEW_TEXT_SIZE/, 'the view hardcodes a card size')
})

test('an edge cannot be drawn from a card to itself, or twice between a pair', () => {
  assert.match(VIEW, /linkFrom !== node\.id/, 'a card can be connected to itself')
  assert.match(
    VIEW,
    /edges\.some\(\(e\) => e\.fromNode === fromNode && e\.toNode === toNode\)/,
    'the same pair can be connected twice',
  )
})

test('only text nodes are editable', () => {
  // The text branch is also the fallback for a node type from a later spec
  // version. Letting a double-click turn one of those into an edited text card
  // destroys exactly what the preservation rule protects.
  assert.match(VIEW, /n\.type === 'text'\) setEditing\(n\.id\)/, 'any node type can be edited')
})

test('connect mode does not also open a file card', () => {
  // A file card is a <button>; picking it as an endpoint fires its click too,
  // and without the guard choosing an endpoint navigates away from the board.
  assert.match(VIEW, /!connect && !draggedLast\.current/, 'connect mode still opens the note')
})

test('an unchanged card does not write the file when committed', () => {
  // save() backs up before every overwrite, so committing a card that was
  // opened and closed untouched would fill .backups/ with identical copies.
  assert.match(VIEW, /\(node\.text \?\? ''\) === value/, 'a no-op edit still saves')
})

test('a card commits on Enter and never on blur', () => {
  // The blur ban is enforced pane-wide by review-s2-vault-pane's HARD FAIL
  // GUARD, which strips comments before matching and so is the right place for
  // it. This pins the positive half instead: that there IS an explicit commit
  // gesture, and that Shift+Enter is still a newline rather than a save.
  assert.match(VIEW, /e\.key === 'Enter' && !e\.shiftKey/, 'no explicit commit gesture')
  assert.match(VIEW, /e\.key === 'Escape'/, 'an edit cannot be abandoned')
})
