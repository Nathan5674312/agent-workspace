/**
 * The themes, as data. One list, read by the Settings picker and by the test
 * that re-measures every palette in `src/renderer/themes.css`.
 *
 * IT IS A LIST OF IDs AND WORDS, NOT OF COLOURS, and that is deliberate. The
 * values live in themes.css because that is the only place they can be
 * *applied*, and duplicating a hex here so a swatch could render it is exactly
 * the drift tokens.css warns about. themes.test.mjs asserts this list and that
 * file name the same set, so adding one without the other fails the suite.
 *
 * `'founders'` is FIRST and is the default. It has no block in themes.css: it
 * is the palette in tokens.css, so selecting it sets no `data-theme` attribute
 * at all. Same rule appearance.css states for `'system'` — the default is the
 * stylesheet, and an override is laid on top of it.
 */

export type ThemeId =
  | 'founders'
  | 'dark'
  | 'midnight'
  | 'nord'
  | 'forest'
  | 'rosepine'
  | 'parchment'

export type Theme = {
  id: ThemeId
  /** Shown in the picker. */
  label: string
  /** One line under it: what this palette is FOR, not what colour it is. */
  hint: string
}

export const THEMES: Theme[] = [
  {
    id: 'founders',
    label: "Founder's",
    hint: 'The owner-supplied warm browns. The palette the app was designed in.',
  },
  { id: 'dark', label: 'Dark', hint: "Neutral graphite. The grey one, next to Midnight's black." },
  {
    id: 'midnight',
    label: 'Midnight',
    hint: 'Near pitch black, neutral. The deep end of the scale; Dark is the grey one.',
  },
  { id: 'nord', label: 'Nord', hint: 'The arctic blue-grey palette, at its own values.' },
  { id: 'forest', label: 'Forest', hint: 'Deep green. Furthest from the default warmth.' },
  {
    id: 'rosepine',
    label: 'Rosé Pine',
    hint: 'Muted rose and violet on a soft dark ground.',
  },
  {
    id: 'parchment',
    label: 'Parchment',
    hint: 'Dark ink on warm paper. The one light theme; hides the canvas artwork.',
  },
]

/** The palette in tokens.css, and therefore the one that sets no attribute. */
export const DEFAULT_THEME: ThemeId = 'founders'

/** Ids only, for `sanitize()` in main and for the test's set comparison. */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id)
