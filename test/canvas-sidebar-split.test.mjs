/**
 * THE CANVAS SIDEBAR IS TWO LISTS, AND THE LOWER ONE HAD NO HEIGHT.
 *
 * Nathan's report, 2026-09-06, was four separate complaints that turned out to
 * be one bug and one line:
 *
 *   "im having trouble finding where i can navigate to the uni vault for files
 *    to drag and drop into canvas"
 *   "i just now found the files, the bar is so small its a sliver and i cant
 *    change the size of it"
 *   "when im in canvas and i hit search the Universal Vault text and the search
 *    bar overlap"
 *   "when i open the search bar in canvas a scroll on the right hand side pops
 *    up and everywhere i zoom in or out in canvas the whole app moves"
 *
 * `.canvas-list` declares `height: 100%`. That is correct when it is the only
 * thing in a panel and catastrophic when it is stacked above the finder: in a
 * flex column `height` becomes the flex BASIS, so the boards list asked for the
 * entire sidebar while the tree below it (`flex: 1`, basis 0) asked for
 * nothing. Flexbox distributes shrinkage in proportion to basis, so all of the
 * overflow came off the list and none of the leftover space reached the tree.
 *
 * Measured in the built app before the fix: the folder tree was **16px** tall
 * and the search panel was **0px** — and the search field, which has margins
 * and a fixed height, spilled out of its zero-height box and painted on top of
 * the vault name. The column also ran 30px past the window, which `.pane-vault`
 * turned into a scrollbar down the side of the WHOLE APP, and a wheel notch
 * over the board then zoomed the canvas and scrolled the app underneath it.
 *
 * After: list 380px, tree 416px, search panel 445px, nothing overlapping and
 * `pane-vault.scrollHeight === clientHeight`.
 *
 * These assertions pin the four values that keep it that way. Every one of them
 * looks harmless to change back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

/**
 * The body of the LAST rule whose selector list contains `selector`.
 *
 * Last rather than first because CSS is won on order and several of these
 * selectors appear twice — `.vault-sidebar > .canvas-list` is named once for
 * its scroller and again for its share of the column, and it is the later
 * declaration that decides the layout.
 */
function rule(css, selector) {
  const i = css.lastIndexOf(selector)
  assert.notEqual(i, -1, `no rule for ${selector}`)
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

test('the app pane never scrolls, so a canvas zoom cannot move the window', () => {
  const base = read('src', 'renderer', 'base.css')
  const body = rule(base, '.pane-vault {')
  assert.match(
    body,
    /overflow:\s*hidden/,
    '.pane-vault is scrollable again. Every surface below it owns its own ' +
      'scroller, so the only thing this can scroll is a layout bug — and it ' +
      'turns one into a scrollbar down the whole app plus a window that ' +
      'slides under a canvas zoom.',
  )
})

test('the boards list takes a fixed share of the canvas sidebar', () => {
  const app = read('src', 'renderer', 'app.css')
  const body = rule(app, '.vault-sidebar > .canvas-list {')
  assert.match(
    body,
    /flex:\s*none/,
    'without `flex: none` the list falls back to `height: 100%` as its basis ' +
      'and eats the whole column',
  )
  assert.match(
    body,
    /height:\s*var\(--canvas-list-h/,
    'the split has to be a variable, or the resizer has nothing to write to',
  )
})

test('whichever finder is showing gets the rest of the column', () => {
  const app = read('src', 'renderer', 'app.css')
  /* Anchored on the search panel: `.vault-folder-tree` is also named by the
     scroller rule above this one. */
  const body = rule(app, '.vault-sidebar > .search-panel,')
  assert.match(
    body,
    /flex:\s*1 1 0/,
    'the lower half must GROW into the space the boards list left. A basis of ' +
      'auto here is what rendered the search panel at zero height.',
  )
})

test('the two stacked lists have a handle between them', () => {
  const pane = read('src', 'renderer', 'panes', 'vault', 'VaultPane.tsx')
  assert.match(
    pane,
    /orientation="horizontal"/,
    'the boards/files seam is not draggable — "i cant change the size of it"',
  )
  assert.match(pane, /variable="--canvas-list-h"/)
  const css = read('src', 'renderer', 'panes', 'vault', 'resizer.css')
  assert.match(
    rule(css, '.vault-sidebar-resizer--h {'),
    /cursor:\s*row-resize/,
    'a handle that does not say which way it drags is a handle nobody drags',
  )
})

test('the tree says it is a drag source while a board is open', () => {
  const pane = read('src', 'renderer', 'panes', 'vault', 'VaultPane.tsx')
  assert.match(
    pane,
    /vault-sidebar-hint/,
    'the tree has always been the drag source for the canvas and has never ' +
      'said so, which is why the report was "I cannot find the files"',
  )
})

/**
 * The camera is not part of the document, so an undo must not move it.
 *
 * `framed` used to hold the `doc` OBJECT. `undo` calls `setDoc(parseCanvas())`
 * — a new object for the same file — so every Ctrl+Z failed the identity check
 * and refit the board, throwing away the pan and zoom the user was working at.
 * Keyed by path it fires once per board, which is what "frame on open" means.
 */
test('undo does not refit the camera', () => {
  const view = read('src', 'renderer', 'panes', 'vault', 'CanvasView.tsx')
  assert.match(
    view,
    /const framed = useRef<string \| null>\(null\)/,
    'framed is keyed by the doc object again, so undo refits the board',
  )
  assert.match(view, /if \(framed\.current !== path\) \{/)
})

/**
 * The hit path lives inside the world, so its stroke is in WORLD units and the
 * board's `scale(k)` shrinks the target along with the picture. A flat 14 was
 * 14px at 1:1 and about four screen pixels at the 30% you actually survey a
 * board from — hardest to hit exactly when there are most arrows to hit.
 * Measured after: 12px either side of the line at both 68% and 13% zoom.
 */
test('the arrow hit target is a constant size on screen', () => {
  const css = read('src', 'renderer', 'panes', 'vault', 'canvas.css')
  const body = rule(css, '.canvas-edge-hit {')
  assert.match(
    body,
    /stroke-width:\s*calc\(\d+\s*\/\s*var\(--canvas-k/,
    'a flat stroke-width here is in world units and shrinks with the zoom',
  )
  assert.match(body, /pointer-events:\s*stroke/)
})

test('drawing an arrow says an arrow can be labelled, a few times', () => {
  const view = read('src', 'renderer', 'panes', 'vault', 'CanvasView.tsx')
  assert.match(view, /EDGE_HINT_TIMES/, 'the hint has no ceiling, so it is noise forever')
  assert.match(
    view,
    /canvas-tool-hint--tip/,
    'nothing tells a first-time user the arrow menu exists, and it is ' +
      'right-click only — a control with no visible trigger',
  )
  assert.match(
    view,
    /localStorage\.setItem\(EDGE_HINT_KEY/,
    'the count belongs to the install, not the vault',
  )
})
