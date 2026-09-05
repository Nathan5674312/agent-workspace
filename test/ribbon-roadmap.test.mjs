/**
 * The ribbon and the roadmap must agree about which icons exist.
 *
 * WHAT THIS FILE USED TO BE. `ribbon-placeholder.test.mjs`, pinning the
 * blank-sidebar fix from 1772b5e: `activeRibbon` had one consumer, an
 * `=== 'files' &&` short-circuit with no else, so seven unbuilt ribbon icons
 * lit up and EMPTIED the sidebar. The app looked broken rather than unfinished.
 * The fix was <SidebarPlaceholder>, a panel that read this roadmap and told you
 * which feature the icon was a promise of.
 *
 * Every one of those icons now has a real panel, so the placeholder was
 * deleted, and with it went four of this file's tests — they asserted the
 * contents of a component that no longer exists. Deleting the tests alongside
 * the code is the point: a test kept for a deleted feature is a test that fails
 * for a reason nobody can act on.
 *
 * WHAT SURVIVED, and why it is not the same test. The invariant that outlived
 * the placeholder is a data one: `surface: 'ribbon:x'` in roadmap.ts claims a
 * place in the left ribbon, and nothing reads those strings at runtime any
 * more — `featureForRibbon()` went with the component. An unchecked pointer
 * into a UI that has moved on is exactly the kind of claim that rots quietly,
 * so it is checked here.
 *
 * The OTHER half — every ribbon id being handled by name in VaultPane, which is
 * what makes the sidebar's else branch unreachable — lives in
 * review-s2-vault-pane.test.mjs, next to the rest of that pane's rules.
 *
 * No DOM library here, so LeftRibbon.tsx is read from disk as text and the
 * plain .ts it is checked against is imported and actually run.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ALL_FEATURES } from '../src/shared/roadmap.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANE = join(HERE, '..', 'src', 'renderer', 'panes', 'vault')
const src = (name) => readFileSync(join(PANE, name), 'utf8')

test('no ribbon: surface points at an id the ribbon does not have', () => {
  const ids = [...src('LeftRibbon.tsx').matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
  /**
   * EIGHT. It was eight of three different kinds; it is eight of ONE kind now —
   * the surfaces that are about your notes, and nothing else. Still an EXACT
   * count rather than a floor, for the reason it always was: adding or dropping
   * an icon should be a deliberate act that shows up right here.
   *
   * The roadmap surface IS among them now (2026-09-04): the icon opens the
   * vault's own roadmap notes, not Fate's feature list. It took Inbox's slot,
   * so the count is unchanged — which is the point of asserting a count rather
   * than a floor. `review-s2` holds the reasoning and asserts Help still opens
   * the same surface.
   */
  assert.equal(ids.length, 8, 'expected the eight surfaces')
  assert.ok(ids.includes('roadmap'), 'the roadmap icon is gone again')
  for (const f of ALL_FEATURES.filter((f) => f.surface?.startsWith('ribbon:'))) {
    const id = f.surface.slice('ribbon:'.length)
    assert.ok(ids.includes(id), `roadmap points at ribbon:${id}, which no icon declares`)
  }
  /**
   * The other half of the same guarantee, and it is new because the sidebar is
   * new. Files, Search and Bookmarks stopped being ribbon icons, so the roadmap
   * entries pointing at `ribbon:files` and friends were left describing a
   * control that no longer existed. They say `sidebar:` now, and this keeps
   * them honest the same way.
   */
  const finders = [...src('SidebarFinder.tsx').matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
  assert.equal(finders.length, 3, 'expected files, search and bookmarks')
  for (const f of ALL_FEATURES.filter((f) => f.surface?.startsWith('sidebar:'))) {
    const id = f.surface.slice('sidebar:'.length)
    assert.ok(finders.includes(id), `roadmap points at sidebar:${id}, which no finder declares`)
  }
})

test('the not-built placeholder is gone, component and styles alike', () => {
  // Not ceremony. The component was reachable only through the sidebar's else
  // branch, and a half-deletion — the file removed but an import left, or the
  // CSS left behind to be copied into the next panel — is the failure mode of
  // deleting something that four other files mentioned.
  const pane = src('VaultPane.tsx')
  assert.doesNotMatch(pane, /import .*SidebarPlaceholder/, 'a dead import survives')
  assert.doesNotMatch(pane, /<SidebarPlaceholder/, 'the component is still rendered')
  assert.doesNotMatch(
    src('LeftRibbon.tsx'),
    /export function ribbonLabel/,
    'ribbonLabel was exported only to title that panel',
  )
  const css = readFileSync(join(HERE, '..', 'src', 'renderer', 'app.css'), 'utf8')
  assert.doesNotMatch(css, /sidebar-placeholder/, 'the styles outlived the markup')
})

test('the sidebar still uses a ternary, so its else cannot be empty by accident', () => {
  // The ORIGINAL bug, still worth pinning even though the else now renders
  // null: `&&` has no else at all, so an unhandled id renders nothing AND
  // nothing can assert what should have been there. The ternary keeps the
  // fall-through a visible branch that review-s2-vault-pane's exhaustiveness
  // test can reason about.
  const code = src('VaultPane.tsx')
  assert.match(code, /finder === 'search' \?/, 'the sidebar must use a ternary')
  assert.doesNotMatch(
    code,
    /finder === 'search' &&/,
    'the && form leaves the else empty — that is the bug this file exists for',
  )
  /**
   * The pair that caused the original confusion must not come back. Two
   * variables for one selection is what made "which icon is lit" and "which
   * panel is showing" able to disagree; see the comment in VaultPane where
   * `finder` is declared.
   */
  const live = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(live, /activeRibbon/, 'the ribbon owns a sidebar panel again')
  assert.doesNotMatch(live, /ribbonPressed/, 'the split highlight state is back')
})
