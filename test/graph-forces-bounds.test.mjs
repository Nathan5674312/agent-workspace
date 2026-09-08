/**
 * THE FORCES PANEL HAS TO FIT UNDER THE AGENT PANEL THAT PUSHES IT DOWN.
 *
 * Nathan, 2026-09-07: "you also just completely broke the forces tab in the
 * graph". Nothing was broken in the sense of throwing: the button opened the
 * panel, every slider rendered, and moving one moved the graph. The panel was
 * simply past the bottom edge of the window.
 *
 * `.graph-forces` is `position: fixed` and its `top` is the agent panel's
 * measured bottom edge (`--agents-drop`) plus a gap. The panel is 733px of
 * sliders. MEASURED on his vault, window 1000px tall, two agents working:
 *
 *   --agents-drop  303px
 *   panel top      315   bottom 1048   -> 48px off the bottom
 *   five cards     372          1105   -> 105px off, last slider unreachable
 *
 * A fixed box with no `max-height` never scrolls, so there was no way to reach
 * the bottom controls at all. It could not show up in a test run or a demo:
 * with no agents the variable is unset, the panel rests at 48px, and 733 fits
 * in any normal window.
 *
 * The bound and the drop have to be the SAME expression — a second copy of the
 * `max(...)` is the kind of duplicate that goes stale the next time the gap
 * changes — so the drop is a custom property that `top` and `max-height` both
 * read. These assertions pin that shape.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(ROOT, 'src', 'renderer', 'panes', 'vault', 'graph.css'), 'utf8')

/** The body of the `.graph-forces` rule, comments stripped. */
const rule = (() => {
  const i = css.indexOf('.graph-forces {')
  assert.notEqual(i, -1, 'no .graph-forces rule in graph.css')
  const open = css.indexOf('{', i)
  let depth = 0
  let end = open
  for (let j = open; j < css.length; j++) {
    if (css[j] === '{') depth++
    else if (css[j] === '}' && --depth === 0) {
      end = j
      break
    }
  }
  return css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '')
})()

test('the drop is written once, as a property both rules can read', () => {
  assert.match(
    rule,
    /--forces-top:\s*max\(/,
    'the panel’s drop is not a custom property, so its height cannot subtract it',
  )
  assert.match(rule, /top:\s*var\(--forces-top\)/, '`top` no longer reads the drop property')
  assert.match(
    rule,
    /--forces-top:[^;]*--agents-drop/,
    'the drop no longer follows the agent panel’s measured bottom edge',
  )
})

test('the panel is bounded by the window it was pushed down inside', () => {
  const m = rule.match(/max-height:\s*calc\(([^;]+)\)/)
  assert.ok(m, '.graph-forces has no max-height, so the agent panel pushes it off screen')
  const expr = m[1]
  assert.match(expr, /100vh/, 'the bound is not measured against the window')
  assert.match(
    expr,
    /var\(--forces-top\)/,
    'the bound does not subtract the drop, so a tall agent stack still overflows',
  )
})

test('a panel taller than the space left scrolls rather than spilling', () => {
  assert.match(
    rule,
    /overflow-y:\s*auto/,
    'the panel does not scroll, so a bound only clips the controls instead of reaching them',
  )
})
