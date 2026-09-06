/**
 * THE INVARIANT THE THEME PICKER IS BUILT ON, which nothing else checks.
 *
 * Every card in the picker is a small mockup of this window carrying
 * `data-theme="<id>"`, and its colours come from `themes.css` rather than from
 * the component — that is what stops the picker becoming a second table of hex
 * values that quietly drifts from the palettes it claims to show. For that to
 * work, each palette has to be declared for a BARE `[data-theme='x']` as well
 * as for `:root[data-theme='x']`, because a card is a <span> in the middle of
 * the document, not the document root.
 *
 * HOW IT BREAKS, and why it breaks silently: add an eighth theme, give it the
 * `:root`-scoped block every other palette has, and everything works. The app
 * themes correctly, the picker renders eight cards, the suite stays green — and
 * the new card paints itself in the SURROUNDING window's palette, because
 * nothing scoped to it ever matched. That is the "one swatch that lies", and
 * the only symptom is a picture that is wrong in a way you have to already know
 * the palette to notice.
 *
 * `founders` is the default and sets no attribute on <html>, so its bare
 * selector lives in tokens.css beside `:root`. Both files are searched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { THEMES } from '../src/shared/themes.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const CSS = read('src', 'renderer', 'themes.css') + '\n' + read('src', 'renderer', 'tokens.css')

/**
 * The stylesheet with every ROOT-SCOPED selector blanked out, so what is left
 * mentioning a theme id is a bare one.
 *
 * Done by substitution rather than by matching, because `[data-theme='dark']`
 * is a substring of `:root[data-theme='dark']` — a plain `includes` on the
 * whole file passes on exactly the stylesheet this test exists to reject.
 */
const BARE_ONLY = CSS.split(":root[data-theme='").join("ROOT_SCOPED('")

test('every theme is declared for a bare [data-theme], not only for :root', () => {
  for (const { id, label } of THEMES) {
    assert.ok(
      BARE_ONLY.includes(`[data-theme='${id}']`),
      `${label} (${id}) has no bare [data-theme='${id}'] block, so its card in the ` +
        `picker paints itself in whatever palette the window is already on`,
    )
  }
})

test('the picker puts the theme id on the mockup, which is what selects the palette', () => {
  // The other half of the same guarantee. The CSS can be perfect and every card
  // still identical if the attribute stops being written.
  const picker = read('src', 'renderer', 'panes', 'vault', 'ThemePicker.tsx')
  assert.ok(
    picker.includes('data-theme={t.id}'),
    'the mockup no longer carries the theme id, so every card is the same palette',
  )
  // The picker renders THEMES rather than a list of its own, which is what
  // makes adding a palette add a card — and brings it under the test above.
  assert.ok(picker.includes('THEMES.map'), 'the picker no longer renders every theme in THEMES')
})

test('picking a card is the same write the old <select> made', () => {
  // The visual change must not have changed what a choice DOES. `update()` is
  // the optimistic apply plus the settings write; a picker that only set local
  // state would look right and forget the theme on restart.
  const dialog = read('src', 'renderer', 'panes', 'vault', 'SettingsDialog.tsx')
  assert.ok(
    dialog.includes('onPick={(id) => void update({ theme: id })}'),
    'the picker no longer writes the theme through update(), so it will not persist',
  )
})
