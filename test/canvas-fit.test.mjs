/**
 * Framing a board on open — fit().
 *
 * The one arithmetic path in this view that can produce NaN, and NaN in a CSS
 * transform is silent: the world gets `scale(NaN)`, the board vanishes, the
 * zoom readout says NaN%, and nothing throws.
 *
 * Pure arithmetic plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const VIEW = readFileSync(
  new URL('../src/renderer/panes/vault/CanvasView.tsx', import.meta.url),
  'utf8',
)

// ------------------------------------------------------------ fit() and NaN

test('framing a zero-extent board cannot put NaN into the transform', () => {
  // The one arithmetic path here that can produce NaN. A board whose content
  // has zero width — legal, parseCanvas accepts width 0 — framed in a surface
  // exactly FIT_PAD*2 across gives 0/0, and NaN propagates through Math.max and
  // Math.min unchanged, so the world gets `scale(NaN)` and vanishes with no
  // error anywhere.
  const FIT_PAD = 64
  const naive = (surface, span) => Math.min(3, Math.max(0.1, (surface - FIT_PAD * 2) / span))
  assert.ok(Number.isNaN(naive(128, 0)), 'the fixture does not reproduce the NaN')
  assert.ok(Number.isNaN(Math.max(0.1, NaN)), 'Math.max does not propagate NaN, so this is moot')

  // The guard: a span is never zero.
  const guarded = (surface, span) =>
    Math.min(3, Math.max(0.1, (surface - FIT_PAD * 2) / Math.max(1, span)))
  assert.ok(Number.isFinite(guarded(128, 0)), 'the guard still yields NaN')
  assert.equal(guarded(128, 0), 0.1)
})

test('fit guards both spans before dividing by them', () => {
  const fit = VIEW.slice(VIEW.indexOf('const fit ='), VIEW.indexOf('// ── save'))
  assert.ok(fit.length > 0, 'fit no longer has the shape this test reads')
  assert.match(fit, /Math\.max\(1, maxX - minX\)/, 'a zero-width board divides by zero')
  assert.match(fit, /Math\.max\(1, maxY - minY\)/, 'a zero-height board divides by zero')
})

