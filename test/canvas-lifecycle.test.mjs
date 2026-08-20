/**
 * Board-switch lifecycle — what must be torn down when `path` changes.
 *
 * The defect these pin is the worst one this view has had. `CanvasView` is not
 * remounted when you pick a different board; only the `path` prop changes. So
 * anything held in state belongs to the OLD file until something clears it,
 * and the read of the new file is async — there is a real window, tens of
 * milliseconds or longer on a slow disk, where the previous board's `doc` is on
 * screen underneath the new board's name.
 *
 * A drag in that window calls `persist(doc)`, which sends the OLD board's
 * content to the NEW board's path. The only thing between that and destroying
 * the new board is the mtime guard, and two `.canvas` files can easily share an
 * mtime — a `git checkout`, an unzip, or a sync client all produce that.
 *
 * Worse, the error page's guard is `error && !doc`. With a stale `doc` still
 * present that condition is false, so a board that fails to parse is not
 * reported at all: the previous board is displayed as if it were the broken
 * one, and the module's stated invariant — "`doc` stays null, so there is
 * nothing for a drag to mutate and nothing for a save to write" — is false
 * exactly when a board was already open.
 *
 * These are source assertions because `CanvasView.tsx` cannot be imported by
 * `node --test` (JSX plus a stylesheet import). They are scoped to the load
 * effect's body and pin ORDERING, which is the actual invariant: the teardown
 * has to happen before the branch, not inside one arm of it.
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

/** The body of the `path` load effect, up to the point it branches on `!path`. */
const teardown = () => {
  const effect = VIEW.slice(VIEW.indexOf('let cancelled = false'), VIEW.indexOf('void load()'))
  const branch = effect.indexOf('if (!path)')
  assert.ok(branch > 0, 'the load effect no longer has the shape this test reads')
  return effect.slice(0, branch)
}

test('a board change drops the previous board before reading the new one', () => {
  // THE LOAD-BEARING ASSERTION. Unconditionally, and before the branch: an
  // arm of the branch is too late, because the common case — switching from
  // one real board to another — does not take that arm at all.
  const before = teardown()
  assert.match(before, /setDoc\(null\)/, 'the previous board survives a change of path')
  assert.match(before, /setMtime\(0\)/, "the previous board's mtime survives a change of path")
})

test('an in-progress text edit does not survive a board change', () => {
  // `editing` holds a node id from the old board. Carried across, it either
  // matches nothing or, far worse, collides with an id on the new board and
  // opens an editor on a card the user never touched.
  assert.match(teardown(), /setEditing\(null\)/, 'an open editor survives a change of board')
})

test('the selection is still dropped too', () => {
  // Already true before this fix; asserted here so the teardown stays one
  // place rather than drifting back apart.
  assert.match(teardown(), /setSelected\(new Set\(\)\)/, 'the selection survives a change of board')
})

// ------------------------------------------------------- preservation rule

test('the preservation rule is intact: a board still round-trips untouched', () => {
  // Carried in every back-test. Nothing about tearing down view state may
  // change what a file looks like coming back out.
  const RICH = {
    nodes: [
      { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 100, color: '4' },
      { id: 'g', type: 'group', label: 'G', x: -10, y: -10, width: 300, height: 300 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'g', label: 'keep', fromSide: 'top', toEnd: 'none' }],
    somethingFromNoSpec: { v: 2 },
  }
  const text = `${JSON.stringify(RICH, null, 2)}\n`
  assert.equal(serializeCanvas(parseCanvas(text)), text)
})
