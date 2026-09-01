/**
 * Themes: the list, the stylesheet, and the CONTRAST OF EVERY PALETTE.
 *
 * The ratios in themes.css are comments, and a comment cannot fail. This file
 * is what makes them load-bearing: it re-measures every colour in the file with
 * the WCAG formula on every run, so a hand-edited hex that drops a label under
 * its bar fails the suite instead of shipping.
 *
 * The measurement is checked against a known answer first. tokens.css documents
 * the founder's palette at 10.0 / 7.4 / 5.0, measured by the owner with
 * palette.py; the implementation below has to reproduce those before any theme
 * is judged by it. A contrast test with a wrong contrast function passes
 * everything.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_THEME, THEMES, THEME_IDS } from '../src/shared/themes.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')
const CSS = read('src/renderer/themes.css')
const TOKENS = read('src/renderer/tokens.css')

// ------------------------------------------------------------------ contrast

const srgb = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : (((c / 255) + 0.055) / 1.055) ** 2.4)
const parseHex = (hex) => {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}
const lum = (hex) => {
  const [r, g, b] = parseHex(hex).map(srgb)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

test('the contrast function reproduces the ratios tokens.css already published', () => {
  // Ink, and the four labels the owner measured against it with palette.py.
  const ink = '#160C08'
  assert.equal(ratio('#D8B493', ink).toFixed(1), '10.0', 'Sand should be 10.0:1')
  assert.equal(ratio('#BA9B7D', ink).toFixed(1), '7.4', 'Tan should be 7.4:1')
  assert.equal(ratio('#987D65', ink).toFixed(1), '5.0', 'Clay should be 5.0:1')
  // Symmetric, and identical colours are 1:1 — the two ways to get this wrong.
  assert.equal(ratio(ink, '#D8B493').toFixed(1), '10.0')
  assert.equal(ratio(ink, ink).toFixed(2), '1.00')
})

// -------------------------------------------------------------------- parsing

/** Every `--token: value` in every `:root[data-theme='id']` block, merged. */
function palettes(css) {
  const out = new Map()
  const block = /:root\[data-theme='([a-z]+)'\]\s*\{([^}]*)\}/g
  for (const m of css.matchAll(block)) {
    const acc = out.get(m[1]) ?? new Map()
    for (const d of m[2].matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
      acc.set(d[1], d[2].trim())
    }
    out.set(m[1], acc)
  }
  return out
}

const P = palettes(CSS)

test('themes.ts and themes.css name the same set, minus the default', () => {
  // The drift guard. A theme in the list with no block would silently paint the
  // founder's palette under another name; a block with no list entry would be
  // unreachable from the picker.
  const declared = new Set(THEME_IDS.filter((id) => id !== DEFAULT_THEME))
  assert.deepEqual([...P.keys()].sort(), [...declared].sort())
})

test("the founder's theme has NO block, because it IS tokens.css", () => {
  assert.ok(!P.has(DEFAULT_THEME), 'a founders block would be a second copy of the owner palette')
  assert.equal(THEMES[0].id, DEFAULT_THEME, 'the default is offered first')
})

test('every theme is labelled and hinted, and ids are unique', () => {
  assert.equal(new Set(THEME_IDS).size, THEMES.length)
  for (const t of THEMES) {
    assert.ok(t.label.trim(), `${t.id} has no label`)
    assert.ok(t.hint.trim().length > 10, `${t.id} has no useful hint`)
  }
})

/**
 * The tokens a theme MUST set. Anything missing here falls through to
 * tokens.css and the theme quietly inherits a brown — which looks like a
 * styling bug and is really a half-written palette.
 */
const REQUIRED = [
  '--scrim-rgb', '--bg-app', '--bg-elevated', '--bg-sunken',
  '--material-heavy', '--material-regular', '--material-light',
  '--fill-hover', '--fill-active', '--fill-selected',
  '--label', '--label-secondary', '--label-tertiary', '--label-quaternary',
  '--label-on-accent', '--separator', '--separator-opaque', '--edge-highlight',
  '--accent', '--accent-pressed',
]

test('no theme is half-written — every one sets the full colour set', () => {
  for (const [id, tokens] of P) {
    for (const key of REQUIRED) {
      assert.ok(tokens.has(key), `${id} is missing ${key}, so it inherits tokens.css`)
    }
  }
})

test('a theme sets COLOUR only — never type, rhythm, shape or motion', () => {
  // The picker changes the palette. A theme that moved the radii or the easing
  // would be a different app, not a different colour scheme.
  const forbidden = /^--(font|text|weight|tracking|leading|space|radius|duration|ease|icon)/
  for (const [id, tokens] of P) {
    for (const key of tokens.keys()) {
      assert.ok(!forbidden.test(key), `${id} sets ${key}, which is not colour`)
    }
  }
})

// ------------------------------------------------------------------- the bars
//
// The founder's palette, from tokens.css, is the bar. Floors sit a little under
// its exact ratios so that rounding in the solver is not a failure, but they are
// far above the WCAG minimum each one is claimed to meet.

const BARS = [
  ['--label', 9.5, 'AAA body text'],
  ['--label-secondary', 7.0, 'AAA secondary'],
  ['--label-tertiary', 4.5, 'AA tertiary'],
  ['--accent', 12.0, 'the brightest thing in the palette'],
]

test('every theme clears the founder\'s own contrast bars against its own ground', () => {
  const rows = []
  for (const [id, tokens] of P) {
    const bg = tokens.get('--bg-app')
    assert.match(bg, /^#[0-9a-f]{6}$/i, `${id} --bg-app is not a hex`)
    for (const [key, floor, what] of BARS) {
      const r = ratio(tokens.get(key), bg)
      assert.ok(r >= floor, `${id} ${key} is ${r.toFixed(2)}:1 against ${bg}, needs ${floor} (${what})`)
      rows.push(`${id}/${key.slice(2)} ${r.toFixed(1)}`)
    }
  }
  console.log(`      ${rows.length} measured: ${rows.join(' · ')}`)
})

test('quaternary stays decorative — bright enough to see, too dim for body text', () => {
  // tokens.css §3 is explicit that Taupe is never body text. A theme that
  // pushed this to AA would be inviting exactly the misuse the note forbids,
  // and one that let it fall to the ground would make it invisible.
  for (const [id, tokens] of P) {
    const r = ratio(tokens.get('--label-quaternary'), tokens.get('--bg-app'))
    assert.ok(r >= 3.0 && r < 4.5, `${id} --label-quaternary is ${r.toFixed(2)}:1, want 3.0–4.5`)
  }
})

test('text on the accent is readable, in both directions', () => {
  // The one pair that inverts: on a dark theme the accent is light and its ink
  // is dark, and Parchment is the other way round. Neither may collapse.
  for (const [id, tokens] of P) {
    const r = ratio(tokens.get('--label-on-accent'), tokens.get('--accent'))
    assert.ok(r >= 7, `${id} --label-on-accent is ${r.toFixed(2)}:1 on its accent`)
  }
})

test('the pressed accent recedes, and stays on the same side of the ground', () => {
  for (const [id, tokens] of P) {
    const bg = lum(tokens.get('--bg-app'))
    const a = lum(tokens.get('--accent'))
    const pressed = lum(tokens.get('--accent-pressed'))
    const light = a > bg
    assert.equal(pressed > bg, light, `${id} --accent-pressed crosses its own ground`)
    assert.ok(
      light ? pressed < a : pressed > a,
      `${id} --accent-pressed does not recede under the press`,
    )
  }
})

test('the elevated and sunken grounds stay near the app ground, never a step of contrast', () => {
  // tokens.css: the darks sit within 1.1–1.6:1 and separation is the job of the
  // hairline separators, never of the ground. A theme that stacked grounds for
  // contrast is how text vanishes on one surface and not another.
  for (const [id, tokens] of P) {
    for (const key of ['--bg-elevated', '--bg-sunken']) {
      const r = ratio(tokens.get(key), tokens.get('--bg-app'))
      assert.ok(r < 1.8, `${id} ${key} is ${r.toFixed(2)}:1 from --bg-app, too much separation`)
    }
  }
})

test('the scrim follows the ground, or a brown film lands on a green app', () => {
  // Four surfaces darken what is behind them at an alpha — the canvas scrim and
  // the three modal backdrops — and rgba() can only take channels, not a hex.
  // These were hardcoded Ink and were invisible to a theme until Parchment made
  // it obvious: a dark brown gradient over paper. So the channels must MATCH the
  // theme's own --bg-app, not merely be present.
  for (const [id, tokens] of P) {
    const want = parseHex(tokens.get('--bg-app')).join(', ')
    assert.equal(tokens.get('--scrim-rgb'), want, `${id} --scrim-rgb is not its own --bg-app`)
  }
})

test('Parchment is the light theme and empties the artwork slot', () => {
  // The treated jpg has a duotone Ink -> Sand LUT baked in, so it is made of the
  // DARK palette; on paper it is a grey smear no opacity rescues.
  const p = P.get('parchment')
  assert.ok(lum(p.get('--bg-app')) > 0.5, 'parchment ground should be light')
  assert.ok(lum(p.get('--label')) < 0.2, 'parchment ink should be dark')
  assert.equal(p.get('--canvas-art'), 'none')
  // And it is the ONLY light one, so the artwork exception needs no other case.
  for (const [id, tokens] of P) {
    if (id === 'parchment') continue
    assert.ok(lum(tokens.get('--bg-app')) < 0.2, `${id} is unexpectedly light`)
    assert.ok(!tokens.has('--canvas-art'), `${id} should leave the artwork slot alone`)
  }
})

test('tokens.css is untouched — the founder palette is still Ink and Sand', () => {
  // The whole point of the no-block rule. If someone "themes" the default by
  // editing tokens.css, the owner's measured palette is gone and this catches it.
  assert.match(TOKENS, /--bg-app:\s*#160c08/i)
  assert.match(TOKENS, /--label:\s*#d8b493/i)
  assert.match(TOKENS, /--accent:\s*#f0cba5/i)
})
