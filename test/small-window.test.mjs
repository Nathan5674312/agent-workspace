/**
 * THE APP HAS TO WORK IN A CORNER OF A MONITOR, not only across one.
 *
 * Nathan's ask, 2026-09-04: "each box should work at any size length or width
 * and user should be able to seamlessly put it anywhere whether that would be
 * a corner of their monitor or half or the whole thing."
 *
 * Two numbers decide whether that is true, and both are easy to change back
 * without noticing, because nothing looks wrong on the machine of whoever
 * changes them — a developer works maximised.
 *
 *   THE FLOOR. `minWidth`/`minHeight` in src/main/index.ts. It was 1100x700,
 *   which is wider than half of a 1920 screen: the app could not be snapped
 *   beside an editor at all. Windows quarter-snaps to 960x540 on that display,
 *   so anything above that is a floor that forbids a corner.
 *
 *   THE SIDEBAR CAP. A fixed 15rem sidebar at the 360px floor leaves the note
 *   about 90px — measured, and unusable. The width the user dragged to has to
 *   be capped against the WINDOW, not just set.
 *
 * The cap is a proportion rather than a breakpoint that hides the sidebar,
 * deliberately: nothing else in the app opens the file tree, so hiding it would
 * make the tree unreachable at small sizes rather than small. "Works at any
 * size" means every surface stays reachable at every size.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

/** What Windows gives a quarter-snap on a 1920x1080 display. */
const CORNER = { w: 960, h: 540 }

test('the window floor allows a quarter-screen snap', () => {
  const main = read('src', 'main', 'index.ts')
  const num = (key) => {
    const m = main.match(new RegExp(key + ':\\s*(\\d+)'))
    assert.ok(m, `${key} is not set in createWindow, so the floor is Electron's default`)
    return Number(m[1])
  }
  const minWidth = num('minWidth')
  const minHeight = num('minHeight')
  assert.ok(
    minWidth <= CORNER.w,
    `minWidth is ${minWidth}, so the app cannot be snapped into a ${CORNER.w}px corner`,
  )
  assert.ok(
    minHeight <= CORNER.h,
    `minHeight is ${minHeight}, so the app cannot be snapped into a ${CORNER.h}px corner`,
  )
})

test('the sidebar is capped against the window, not just set', () => {
  const css = read('src', 'renderer', 'app.css')
  /**
   * The declaration, not the whole rule: `.vault-sidebar` carries a comment
   * block explaining the cap, and matching to the semicolon after `width:` is
   * what keeps this reading the value rather than the prose.
   */
  const decl = css.match(/\.vault-sidebar\s*\{[\s\S]*?width:\s*([^;]+);/)
  assert.ok(decl, '.vault-sidebar declares no width at all')
  const width = decl[1]
  assert.ok(
    width.includes('min('),
    `.vault-sidebar width is "${width.trim()}" — an uncapped width takes the same ` +
      `pixels in a 360px window as in a 1920px one, which leaves the note unusable`,
  )
  assert.ok(
    /\d+vw/.test(width),
    `.vault-sidebar width is "${width.trim()}" — the cap has to be against the ` +
      `window (a vw), or it is just a second fixed width`,
  )
})

test('the note footer stacks rather than overflowing', () => {
  // Links and Backlinks sit side by side and must fall to one column on their
  // own. `auto-fit` + `minmax` does that without a breakpoint; a fixed
  // two-column grid would push the note off the canvas in a narrow window.
  const css = read('src', 'renderer', 'app.css')
  const rule = css.match(/\.vault-editor-links\s*\{[\s\S]*?\}/)
  assert.ok(rule, '.vault-editor-links has no rule')
  assert.match(
    rule[0],
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/,
    'the links footer no longer collapses to one column in a narrow pane',
  )
})
