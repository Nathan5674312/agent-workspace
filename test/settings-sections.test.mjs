/**
 * The two things the settings restructure is allowed to break, and must not.
 *
 * Source-text assertions, deliberately: there is no DOM harness in this suite,
 * and both invariants are structural facts about the file rather than
 * behaviours you would drive. Same technique appearance.test.mjs uses on
 * appearance.css.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(
  new URL('../src/renderer/panes/vault/SettingsDialog.tsx', import.meta.url),
  'utf8',
)

/**
 * docs/SETTINGS-RESEARCH.md §5 names this as the one thing to preserve across a
 * nav rewrite. A div with a hand-rolled focus trap passes review and fails in
 * the ways a real <dialog> never does.
 */
test('settings is still a real <dialog> opened with showModal()', () => {
  assert.match(SRC, /<dialog\b/)
  assert.match(SRC, /\.showModal\(\)/)
  assert.match(SRC, /\.close\(\)/, 'close() is what restores focus to the gear')
})

/** A tab pointing at nothing is a nav that reads as broken to a screen reader. */
test('every section has a tab and the panel that tab controls', () => {
  const ids = [...SRC.matchAll(/\{ id: '([a-z]+)', label: '/g)].map((m) => m[1])
  assert.ok(ids.length >= 2, `expected the SECTIONS list, found ${ids.length} entries`)

  assert.match(SRC, /role="tab"/)
  for (const id of ids) {
    assert.match(SRC, new RegExp(`id="settings-panel-${id}"`), `no panel for section "${id}"`)
    assert.match(
      SRC,
      new RegExp(`aria-labelledby="settings-tab-${id}"`),
      `panel "${id}" is not named by its tab`,
    )
  }
})

/**
 * The pane bans blur as a save path outright — the artwork slider commits on
 * pointer-up, key-up and pointer-cancel, and nowhere else.
 */
test('no onBlur save path survived the restructure', () => {
  assert.doesNotMatch(SRC, /onBlur=/)
  for (const h of ['onPointerUp', 'onKeyUp', 'onPointerCancel']) {
    assert.match(SRC, new RegExp(`${h}=\\{commitArtworkOpacity\\}`), `${h} commit is missing`)
  }
})
