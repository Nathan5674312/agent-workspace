/**
 * Selecting an arrow, and the middle-button pan.
 *
 * BOTH OF THESE EXIST BECAUSE OF A DISCOVERABILITY FAILURE RATHER THAN A
 * MISSING CAPABILITY, and that is worth stating because it decides what these
 * tests are for. `removeEdge` and a "Delete arrow" menu item have been in this
 * view for a long time — reachable only by right-clicking a two-pixel line.
 * Nathan asked how to delete a link on the canvas, which is the answer to
 * whether anybody finds it there. Clicking a thing and pressing Delete is what
 * people try first, and until now clicking an arrow did nothing at all.
 *
 * WHAT THESE ASSERTIONS CAN AND CANNOT DO. The wiring is JSX and node's type
 * stripping cannot execute it, so these read the source. That proves a line was
 * WRITTEN, not that a pointer event behaves — the same limit canvas-snap and
 * canvas-selection state in their own headers. They are here to stop the wiring
 * being silently removed, and the pieces with real arithmetic in them live in
 * shared modules with executable tests instead.
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

// ------------------------------------------------------- selecting an arrow

test('an arrow can be selected by pressing it', () => {
  const hit = VIEW.slice(VIEW.indexOf('className="canvas-edge-hit"'))
  const down = hit.slice(hit.indexOf('onPointerDown'), hit.indexOf('onContextMenu'))
  assert.ok(down.length > 0, 'the hit path no longer has a pointer-down handler')
  assert.match(down, /setSelectedEdge\(edge\.id\)/, 'pressing an arrow does not select it')
  // Or the board underneath treats it as a press on empty space, clears the
  // selection that was just made, and starts panning under the arrow.
  assert.match(down, /stopPropagation/, 'the press falls through to the board')
})

test('an arrow and a card are alternative selections, never both', () => {
  // Delete has to mean exactly one thing. Each setter clears the other.
  const hit = VIEW.slice(VIEW.indexOf('className="canvas-edge-hit"'))
  const down = hit.slice(hit.indexOf('onPointerDown'), hit.indexOf('onContextMenu'))
  assert.match(down, /setSelected\(new Set\(\)\)/, 'selecting an arrow keeps the card selection')

  const node = VIEW.slice(VIEW.indexOf('const onNodeDown'), VIEW.indexOf('const bringToFront'))
  assert.ok(node.length > 0, 'the node press handler no longer has the shape this test reads')
  assert.match(node, /setSelectedEdge\(null\)/, 'selecting a card keeps the arrow selection')
})

test('Delete removes a selected arrow', () => {
  // Searched FROM the branch, not from the top of the file — the first
  // `window.addEventListener` belongs to the connect-mode effect far above and
  // slicing to it produces an empty string that matches nothing.
  const from = VIEW.indexOf("if (e.key === 'Delete'")
  const key = VIEW.slice(from, VIEW.indexOf('window.addEventListener', from))
  assert.ok(key.length > 0, 'the delete branch no longer has the shape this test reads')
  assert.match(key, /selectedEdge/, 'Delete does not consider a selected arrow')
  assert.match(key, /removeEdge\(edge\)/, 'Delete does not remove the arrow')
})

test('the key handler re-binds when the arrow selection changes', () => {
  // A stale closure here is the classic React bug for this exact shape: the
  // listener would keep the selection it captured and Delete would remove an
  // arrow the user had already moved on from, or nothing at all.
  const eff = VIEW.slice(VIEW.indexOf("if (e.key === 'Delete'"))
  assert.match(
    eff.slice(0, 900),
    /\[doc, editing, selected, selectedEdge, menu\]/,
    'selectedEdge is not in the effect dependencies',
  )
})

test('Escape drops a selected arrow, on the same "never mind" reading', () => {
  const esc = VIEW.slice(VIEW.indexOf("if (e.key === 'Escape' && selectedEdge)"))
  assert.ok(esc.length > 0, 'Escape does not clear an arrow selection')
  assert.match(esc.slice(0, 160), /setSelectedEdge\(null\)/)
})

test('switching board drops the arrow selection', () => {
  // An edge id only means something inside the board holding it. Carried across
  // a switch it either matches nothing or collides with an unrelated edge — and
  // then Delete takes that one.
  const load = VIEW.slice(VIEW.indexOf('pathRef.current = path'))
  assert.match(load.slice(0, 900), /setSelectedEdge\(null\)/, 'the arrow selection survives a board switch')
})

test('selecting an arrow changes nothing about the file', () => {
  // The same guarantee canvas-selection.test.mjs makes for cards. JSON Canvas
  // has no concept of a selected edge and inventing a key for it would put this
  // app's transient state into a document Obsidian also writes.
  const BOARD = {
    nodes: [
      { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', type: 'text', text: 'b', x: 200, y: 0, width: 100, height: 100 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b', label: 'keep me' }],
  }
  const round = serializeCanvas(parseCanvas(JSON.stringify(BOARD)))
  assert.ok(!/selected/i.test(round), 'a selection key reached the serialised board')
  assert.deepEqual(parseCanvas(round).edges, BOARD.edges)
})

test('a selected arrow looks selected, and its head follows', () => {
  assert.match(CSS, /\.canvas-edge-group\[data-selected\] \.canvas-edge \{/, 'no selected-arrow rule')
  const rule = CSS.slice(CSS.indexOf('.canvas-edge-group[data-selected] .canvas-edge {'))
  const body = rule.slice(0, rule.indexOf('}'))
  // Not colour alone: it must still read as selected without separating hues.
  assert.match(body, /stroke-width:\s*3/, 'selection is signalled by colour alone')
  // The head fills with `context-stroke`, so marking the GROUP is what carries
  // it. If the rule ever moves to the path itself the head stops matching.
  assert.match(VIEW, /className="canvas-edge-group"/, 'the group lost its class')
  assert.match(VIEW, /data-selected=\{selectedEdge === edge\.id \|\| undefined\}/, 'the group is not marked')
})

test('an arrow advertises that it can be pressed', () => {
  const hit = CSS.slice(CSS.indexOf('.canvas-edge-hit {'))
  assert.match(hit.slice(0, hit.indexOf('}')), /cursor:\s*pointer/, 'an arrow looks inert')
})

// -------------------------------------------------------- middle-button pan

test('the middle button pans', () => {
  const bg = VIEW.slice(VIEW.indexOf('const onBackgroundDown'), VIEW.indexOf('const marqueeRect'))
  assert.ok(bg.length > 0, 'the background press handler no longer has the shape this test reads')
  const mid = bg.slice(bg.indexOf('if (e.button === 1)'), bg.indexOf('if (e.button !== 0)'))
  assert.ok(mid.length > 0, 'there is no middle-button branch')
  assert.match(mid, /pan\.current = \{/, 'the middle button does not start a pan')
  assert.match(mid, /setPointerCapture/, 'the pan stops at the window edge')
  // Chromium's middle-click autoscroll would otherwise start a competing
  // scroll gesture on Windows.
  assert.match(mid, /preventDefault/, 'autoscroll is not suppressed')
})

test('a middle-drag does not clear the selection', () => {
  // Panning is looking, not editing. Losing a multi-card selection because you
  // moved the view to see where you were dropping it is its own small disaster.
  const bg = VIEW.slice(VIEW.indexOf('const onBackgroundDown'), VIEW.indexOf('const marqueeRect'))
  const mid = bg.slice(bg.indexOf('if (e.button === 1)'), bg.indexOf('if (e.button !== 0)'))
  assert.ok(!/setSelected\(/.test(mid), 'a middle-drag clears the selection')
})

test('a middle press on a CARD still reaches the board', () => {
  // The load-bearing detail: onNodeDown returns on any non-left button BEFORE
  // it stops propagation, so the press bubbles to the surface and pans. Swap
  // those two lines and middle-drag silently stops working over cards, which is
  // most of a dense board.
  const node = VIEW.slice(VIEW.indexOf('const onNodeDown'), VIEW.indexOf('const bringToFront'))
  const guard = node.indexOf('if (e.button !== 0) return')
  const stop = node.indexOf('stopPropagation')
  assert.ok(guard >= 0 && stop >= 0, 'the node press handler lost one of the two lines')
  assert.ok(guard < stop, 'the button guard now runs after stopPropagation, so middle-drag is swallowed')
})

test('the cursor says the board is being panned', () => {
  // `:active` follows the PRIMARY button, so a middle-drag panned the board
  // with an idle open hand showing.
  assert.match(CSS, /\.canvas-surface\[data-panning\]/, 'no cursor rule for a middle-button pan')
  const rule = CSS.slice(CSS.indexOf('.canvas-surface[data-panning]'))
  assert.match(rule.slice(0, rule.indexOf('}')), /cursor:\s*grabbing/, 'the pan cursor is not grabbing')
  assert.match(VIEW, /data-panning=\{panning \|\| undefined\}/, 'the surface never carries the attribute')
})

test('the pan cursor is cleared on release', () => {
  // A grabbing hand left on screen after the gesture is a lie, and this is a
  // separate state from `pan.current`, so it needs its own clear.
  const up = VIEW.slice(VIEW.indexOf('const onUp = () => {'))
  assert.match(up.slice(0, 700), /setPanning\(false\)/, 'the cursor sticks after a middle-drag')
})

// ------------------------------------------------------------------ regression

test('Escape still leaves connect mode', () => {
  // Not new — it has worked since connect mode landed — but it is one of the
  // things Nathan could not find, so it gets an assertion rather than a
  // reassurance. The effect is bound only while the mode is on.
  const eff = VIEW.slice(VIEW.indexOf('if (!connect) return'))
  const body = eff.slice(0, eff.indexOf('}, [connect])'))
  assert.match(body, /e\.key !== 'Escape'/, 'the connect-mode key guard changed')
  assert.match(body, /setConnect\(false\)/, 'Escape no longer leaves connect mode')
  assert.match(body, /setLinkFrom\(null\)/, 'a half-drawn link survives leaving the mode')
  // And nothing in the board's own key handler stops the event before this
  // window listener sees it — both are on `window`, and the board handler only
  // ever calls preventDefault.
  const board = VIEW.slice(VIEW.indexOf("if (e.key === 'Escape' && menu)"))
  assert.ok(
    !/stopPropagation|stopImmediatePropagation/.test(board.slice(0, 400)),
    'the board handler now swallows Escape before connect mode sees it',
  )
})
