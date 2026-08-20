/**
 * Robustness of the render and handler surface.
 *
 * These are the defects that need a slightly unusual input to reach — a
 * keyboard instead of a mouse, an IME, a board carrying a field of the wrong
 * type, a viewport at an awkward size. None of them show up in ordinary use,
 * and two of them take down more than the board when they do.
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

/** The file card's click guard, up to the call it protects. */
const fileCardGuard = () => {
  const start = VIEW.indexOf('onClick={(e) => {')
  assert.ok(start > 0, 'the file card click handler no longer has the shape this test reads')
  return VIEW.slice(start, VIEW.indexOf('onOpenNote(n.file!)'))
}

// ------------------------------------------------- keyboard reaches the card

test('a keyboard activation of a file card is not swallowed by the drag guard', () => {
  // `draggedLast` is set in onUp and cleared only by the NEXT pointerup. A
  // keyboard Enter or Space on the file card's <button> fires a click with no
  // pointer events at all, so after any drag the button silently does nothing
  // — forever, until the user happens to press and release the mouse somewhere
  // on the board. Keyboard-synthesised clicks carry detail 0; real ones do not.
  assert.match(fileCardGuard(), /e\.detail/, 'a keyboard activation is judged by pointer state')
})

test('the info strip announces saving and errors to a screen reader', () => {
  // "Saving…" and the save error live there and are otherwise silent: a failed
  // save is invisible to anyone not watching that corner of the window.
  const strip = VIEW.slice(VIEW.indexOf('className="canvas-info"'), VIEW.indexOf('canvas-info-sep'))
  assert.match(strip, /role="status"/, 'the info strip is not announced')
})

// ------------------------------------------------- preservation rule

test('the preservation rule is intact: a board still round-trips untouched', () => {
  const RICH = {
    nodes: [{ id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 9, height: 9, color: '5' }],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'a', label: 'L', fromEnd: 'arrow' }],
    extra: { keep: 1 },
  }
  const text = `${JSON.stringify(RICH, null, 2)}\n`
  assert.equal(serializeCanvas(parseCanvas(text)), text)
})
