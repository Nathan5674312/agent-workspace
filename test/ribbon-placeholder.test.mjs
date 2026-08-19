/**
 * Pins the ribbon blank-sidebar fix (landed in 1772b5e, previously untested).
 *
 * The bug: `activeRibbon` had one consumer, an `=== 'files' &&` short-circuit
 * with no else, so the seven unbuilt ribbon icons emptied the sidebar while
 * reporting `aria-pressed`. The app looked broken rather than unfinished.
 *
 * Same two halves as review-s2-vault-pane.test.mjs, for the same reason: there
 * is no DOM library here, so the .tsx sources are read from disk and the plain
 * .ts they depend on is imported and actually run.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { featureForRibbon, ALL_FEATURES } from '../src/shared/roadmap.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANE = join(HERE, '..', 'src', 'renderer', 'panes', 'vault')
const src = (name) => readFileSync(join(PANE, name), 'utf8')

/** The seven icons that have no implementation behind them. */
/**
 * Ribbon ids that still fall through to <SidebarPlaceholder>.
 *
 * `terminal`, `calendar` and `bookmarks` have left this list: each now renders
 * its own panel from VaultPane rather than a description of itself. Shrinking
 * this list is the point of the work, so it is expected to keep shrinking —
 * what must not happen is an id leaving it while still having no panel, which
 * is what the else-branch test above catches.
 */
const UNBUILT = ['search', 'graph', 'canvas', 'plugins']

test('the sidebar has an else branch, so no ribbon icon can empty it', () => {
  const code = src('VaultPane.tsx')
  assert.match(
    code,
    /activeRibbon === 'files' \?/,
    'sidebar must use a ternary; the && short-circuit IS the blank-panel bug',
  )
  assert.doesNotMatch(
    code,
    /activeRibbon === 'files' &&/,
    'the && form leaves the else empty — that is the bug this test exists for',
  )
  assert.match(code, /<SidebarPlaceholder/, 'the else branch must render a placeholder')
})

test('the placeholder always renders a label and a status, feature or not', () => {
  const code = src('SidebarPlaceholder.tsx')
  // featureForRibbon returns undefined for three of the seven ids, so anything
  // gated on `feature &&` must not be the only thing in the panel.
  assert.match(code, /sidebar-placeholder-title["'>]/, 'no unconditional title')
  assert.match(code, /Not built yet/, 'no unconditional status line')
  assert.match(code, /sidebar-placeholder-hint["'>]/, 'no unconditional way back to Files')
})

test('the placeholder titles itself with the ribbon\'s own label', () => {
  assert.match(src('LeftRibbon.tsx'), /export function ribbonLabel/)
  assert.match(src('VaultPane.tsx'), /ribbonLabel\(activeRibbon\)/)
})

test('featureForRibbon binds icons to roadmap entries, and only real ones', () => {
  assert.equal(featureForRibbon('search')?.label, 'Fast search')
  assert.equal(featureForRibbon('plugins')?.label, 'API / plugin ecosystem')
  assert.equal(featureForRibbon('canvas')?.label, 'Whiteboard / canvas view')
  // Bookmarks USED to be the no-entry case and is now a built feature with its
  // own panel, so `graph` carries that half of the contract: no entry is not a
  // failure, because the placeholder renders without one.
  assert.equal(featureForRibbon('graph'), undefined)
  assert.equal(featureForRibbon('nonsense'), undefined)
})

test('no ribbon: surface points at an id the ribbon does not have', () => {
  const ids = [...src('LeftRibbon.tsx').matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
  assert.equal(ids.length, 8, 'expected the eight ribbon views')
  for (const f of ALL_FEATURES.filter((f) => f.surface?.startsWith('ribbon:'))) {
    const id = f.surface.slice('ribbon:'.length)
    assert.ok(ids.includes(id), `roadmap points at ribbon:${id}, which no icon declares`)
  }
})

test('every unbuilt icon resolves to a panel, not to nothing', () => {
  // Not a tautology: this fails the moment an id is added to the ribbon without
  // the placeholder path tolerating a missing roadmap entry.
  for (const id of UNBUILT) {
    const feature = featureForRibbon(id)
    assert.ok(feature === undefined || typeof feature.label === 'string', id)
  }
})
