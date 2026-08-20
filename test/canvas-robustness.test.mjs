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

// --------------------------------------- a wrong-typed field must not crash

test('a board can legally reach the view with a non-string text, label or file', () => {
  // parseCanvas validates GEOMETRY only, by design — a board that is slightly
  // wrong should still draw. So these values genuinely arrive at the render.
  const doc = parseCanvas(
    JSON.stringify({
      nodes: [
        { id: 'n', type: 'text', text: 42, x: 0, y: 0, width: 9, height: 9 },
        { id: 'o', type: 'text', text: { rich: true }, x: 0, y: 0, width: 9, height: 9 },
        { id: 'g', type: 'group', label: ['a'], x: 0, y: 0, width: 9, height: 9 },
        { id: 'f', type: 'file', file: 7, x: 0, y: 0, width: 9, height: 9 },
      ],
      edges: [],
    }),
  )
  assert.equal(doc.nodes.length, 4, 'parseCanvas rejected the fixture, so the render never sees it')
  // And they survive untouched, which is why the render must cope rather than
  // the parser repair them.
  assert.equal(JSON.parse(serializeCanvas(doc)).nodes[0].text, 42)
})

test('the render narrows text, label and file instead of trusting them', () => {
  // THE LOAD-BEARING ASSERTION. `{n.text ?? ''}` throws "Objects are not valid
  // as a React child" for an object, and fileNodeTitle calls .split on whatever
  // it is handed. App.tsx wraps the whole VaultPane in ONE ErrorBoundary, so a
  // single bad field on one card unmounts the pane — taking the unsaved note
  // buffer with it, which is the thing review-s2 exists to protect.
  assert.match(VIEW, /typeof n\.text === 'string'/, 'a non-string text reaches React')
  assert.match(VIEW, /typeof n\.label === 'string'/, 'a non-string label reaches React')
  assert.match(VIEW, /typeof n\.file === 'string'/, 'a non-string file reaches fileNodeTitle')
})

test('the editor opens on a string even when the card holds something else', () => {
  const edit = VIEW.slice(VIEW.indexOf('className="canvas-text-edit"'), VIEW.indexOf('onKeyDown'))
  assert.match(edit, /typeof n\.text === 'string'/, 'the textarea can be handed a non-string')
})

// ------------------------------------------------------------------- IME

test('Enter does not commit the card while an IME candidate is open', () => {
  // Typing Japanese, Chinese or Korean, Enter ACCEPTS the candidate — it is not
  // a submit. Without an isComposing check the card commits mid-composition and
  // closes, storing the un-converted romaji as the card's real text. This is
  // the pane's first keyboard-commit, so it is the first place the trap exists;
  // Editor.tsx commits on a button and never had it.
  const key = VIEW.slice(VIEW.indexOf('onKeyDown={(e) => {'), VIEW.indexOf('Escape'))
  assert.ok(key.length > 0, 'the textarea key handler no longer has the shape this test reads')
  assert.match(key, /isComposing/, 'Enter commits during IME composition')
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
