/**
 * Can you tell which surface you are on, by looking?
 *
 * `themes.test.mjs` already checks TEXT against its ground and every theme
 * passes, which is why this failure survived: the ribbon's text was compliant
 * the whole time. What was not compliant is the thing that says which icon is
 * SELECTED, and WCAG 1.4.11 covers that separately — 3:1 for "visual
 * information required to identify user interface components and states".
 *
 * Measured before the fix, against the real composited chrome ground:
 *
 *     selected vs unselected background      1.21:1
 *     active vs inactive glyph colour        1.35:1
 *
 * Both are indistinguishable in practice, and the ribbon is the app's primary
 * navigation, so "which surface am I on" had no visual answer.
 *
 * THE GROUND IS COMPOSITED, NOT A TOKEN. `--material-heavy` is translucent and
 * sits over `--bg-app`, and `--fill-nav-selected` is translucent over THAT.
 * Comparing the raw token values instead would compare two colours that are
 * never on screen. The artwork layer is deliberately not in this composite:
 * app.css states the ribbon and explorer are excluded from it on purpose.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const R = (...p) => join(HERE, '..', 'src', 'renderer', ...p)
const TOKENS = readFileSync(R('tokens.css'), 'utf8')
const THEMES = readFileSync(R('themes.css'), 'utf8')
const APP = readFileSync(R('app.css'), 'utf8')

// ---------------------------------------------------------------- colour

const parseHex = (h) => {
  h = h.replace('#', '').trim()
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}
/** Any CSS colour these stylesheets actually use: #hex or rgb()/rgba(). */
const parseColor = (v) => {
  v = v.trim()
  if (v.startsWith('#')) return { c: parseHex(v), a: 1 }
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (!m) throw new Error(`cannot parse colour: ${v}`)
  const p = m[1].split(',').map((x) => parseFloat(x.trim()))
  return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }
}
const channel = (c) => {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (rgb) =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
const ratio = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)]
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
/** Source-over compositing, in sRGB, which is what the browser does. */
const over = ({ c, a }, bg) => c.map((v, i) => v * a + bg[i] * (1 - a))

test('the contrast function agrees with the ratios themes.css already publishes', () => {
  /**
   * The same guard `themes.test.mjs` opens with, and for the same reason: a
   * contrast test with a wrong contrast function passes confidently and proves
   * nothing. These two are published in themes.css as comments beside the
   * values, so they are an independent check on the maths here.
   */
  // Each published ratio is against ITS OWN theme's ground, not the default
  // ink — caught by this check on its first run, which is the entire reason it
  // is here rather than assumed.
  assert.equal(ratio(parseHex('#d5d4d3'), parseHex('#121212')).toFixed(2), '12.66', 'dark accent')
  assert.equal(ratio(parseHex('#ffffff'), parseHex('#060607')).toFixed(2), '20.25', 'midnight accent')
  assert.equal(ratio(parseHex('#160c08'), parseHex('#160c08')).toFixed(2), '1.00')
})

// ---------------------------------------------------------------- themes

/** Every theme's block, plus the base `:root` that the others override. */
function themeBlocks() {
  // `[^{]*` rather than `\s*`: the base block answers to a second selector
  // now — `[data-theme='founders']` — so the palette can be scoped to an
  // element for the Settings theme preview. Same block, same values.
  const base = TOKENS.match(/:root[^{]*\{([\s\S]*?)\n\}/)
  const out = new Map([['(default)', base[1]]])
  for (const m of THEMES.matchAll(/:root\[data-theme='([a-z]+)'\]\s*\{([\s\S]*?)\n\}/g)) {
    // A theme may appear twice (parchment has a second block); merge, later wins.
    out.set(m[1], (out.get(m[1]) ?? '') + '\n' + m[2])
  }
  return out
}
/** Token lookup that falls back to the base palette, as the cascade does. */
function tokenReader(block) {
  const baseBlock = themeBlocks().get('(default)')
  return (name) => {
    const find = (src) => {
      const hits = [...src.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))]
      return hits.length ? hits[hits.length - 1][1] : null
    }
    const v = find(block) ?? find(baseBlock)
    if (!v) throw new Error(`--${name} is defined in no palette`)
    return parseColor(v)
  }
}

const THEME_IDS = [...themeBlocks().keys()]

test('every theme defines the tokens this file measures', () => {
  // Cheap, but it is what turns a missing token into a named failure instead of
  // a thrown regex error three tests down.
  for (const [id, block] of themeBlocks()) {
    const tok = tokenReader(block)
    for (const n of [
      'bg-app',
      'material-heavy',
      'fill-nav-selected',
      'accent',
      'label',
      'label-tertiary',
    ]) {
      assert.ok(tok(n), `${id} cannot resolve --${n}`)
    }
  }
  assert.ok(THEME_IDS.length >= 7, `only ${THEME_IDS.length} palettes found`)
})

/** The ribbon and sidebar ground: material over the app ground, no artwork. */
const chromeGround = (tok) => over(tok('material-heavy'), tok('bg-app').c)

/**
 * What the stylesheet ACTUALLY paints for the active state, as token names.
 *
 * Read out of app.css rather than hardcoded, because a test that measures a
 * colour the CSS does not use is the exact trap this suite is guarding: the
 * first version of the test below measured `--accent` directly and PASSED
 * against the pre-fix stylesheet, which had no accent anywhere near the ribbon.
 * It was grading a colour's potential instead of the app's behaviour.
 */
function activeStateTokens() {
  /**
   * The body of one rule, found by string scan rather than by a regex built
   * from the selector. A selector carries `.`, `-` and `:`, all of which mean
   * something else inside a pattern, and getting that escaping wrong is how
   * this helper silently matched nothing and reported "declares no colour".
   *
   * Exact-match on `selector {`, which is what keeps
   * `.vault-ribbon-icon--active` from also matching its own `::after`.
   */
  const rule = (sel) => {
    const needle = sel + ' {'
    const at = APP.indexOf(needle)
    if (at < 0) return ''
    const from = at + needle.length
    const to = APP.indexOf('}', from)
    return to < 0 ? '' : APP.slice(from, to)
  }
  /**
   * BACKGROUNDS ONLY, and that is the whole correctness of this helper.
   *
   * The first version collected every `var()` in the rule, which swept up
   * `color:` — the glyph. A bright glyph passed the check at 8:1 while the
   * actual state indicator sat at 1.21:1, so the test went green against the
   * broken stylesheet twice before this line was right. The glyph cannot carry
   * state information because the INACTIVE glyph is bright too; only something
   * that differs between the two states can.
   */
  const backgroundTokens = (body) =>
    body
      .split(';')
      .filter((d) => /(^|\s)background(-color)?\s*:/.test(d))
      .flatMap((d) => [...d.matchAll(/var\(--([a-z-]+)\)/g)].map((m) => m[1]))

  return [
    // The fill on the button itself, and the bar drawn beside it. Either may
    // carry the 3:1; the test takes the best one the CSS actually declares.
    ...backgroundTokens(rule('.vault-ribbon-icon--active')),
    ...backgroundTokens(rule('.vault-ribbon-icon--active::after')),
  ]
}

test('THE SELECTED SURFACE IS IDENTIFIABLE — 3:1, every theme', () => {
  /**
   * WCAG 1.4.11: 3:1 for the visual information that identifies a component's
   * state. Measured on whatever app.css declares for the active ribbon icon,
   * so removing the bar or reverting the fill fails this rather than sliding
   * past it.
   *
   * A fill alone cannot reach 3:1 at any alpha subtle enough to still look
   * like a dark UI, which is why the accent bar exists. It clears the bar in
   * all seven themes without a per-theme value, because each theme publishes
   * `--accent` against its own ground at 12:1 or better.
   */
  const declared = activeStateTokens()
  assert.ok(declared.length > 0, 'the active ribbon icon declares no colour at all')

  for (const [id, block] of themeBlocks()) {
    const tok = tokenReader(block)
    const ground = chromeGround(tok)
    // The strongest signal the stylesheet actually paints.
    const best = Math.max(
      ...declared
        .filter((n) => {
          try {
            tok(n)
            return true
          } catch {
            return false // a non-colour token such as --space-2
          }
        })
        .map((n) => ratio(over(tok(n), ground), ground)),
    )
    assert.ok(
      best >= 3.0,
      `${id}: the strongest thing marking the active surface is ${best.toFixed(2)}:1 ` +
        `against the ribbon (want 3.0). Declared: ${declared.join(', ')}`,
    )
  }
})

test('the active glyph is distinguishable from an inactive one', () => {
  /**
   * 1.35:1 before, which is `--label` against `--label-secondary` — two
   * near-identical creams. Dropping the inactive icons to `--label-tertiary`
   * opens the gap. The bar is the compliance; this is what makes the column
   * readable at a glance rather than after a hunt.
   */
  for (const [id, block] of themeBlocks()) {
    const tok = tokenReader(block)
    const r = ratio(tok('label').c, tok('label-tertiary').c)
    assert.ok(
      r >= 1.7,
      `${id}: active vs inactive glyph is only ${r.toFixed(2)}:1`,
    )
  }
})

test('an inactive icon is still legible in its own right', () => {
  /**
   * The other half of the trade. Dimming the inactive glyphs to open the gap
   * above must not push them under the 3:1 that WCAG asks of a meaningful
   * icon. Both bounds have to hold at once or the fix has moved the bug.
   */
  for (const [id, block] of themeBlocks()) {
    const tok = tokenReader(block)
    const r = ratio(tok('label-tertiary').c, chromeGround(tok))
    assert.ok(r >= 3.0, `${id}: inactive icons are ${r.toFixed(2)}:1 on the ribbon`)
  }
})

test('the selected fill is a separate token from the shared one', () => {
  /**
   * `--fill-selected` is also hover feedback, database chips and tone badges.
   * Strengthening IT to fix navigation would have made a dozen unrelated
   * surfaces louder, so the split is the fix and this keeps it split.
   */
  assert.match(APP, /\.vault-ribbon-icon--active\s*\{[^}]*--fill-nav-selected/)
  assert.doesNotMatch(
    APP,
    /\.vault-ribbon-icon--active\s*\{[^}]*var\(--fill-selected\)/,
    'the ribbon is back on the shared fill',
  )
})

test('the bar is drawn, not just declared', () => {
  // The token could be perfect and the rule absent. This is the one assertion
  // that the compliance-carrying element actually exists in the stylesheet.
  assert.match(
    APP,
    /\.vault-ribbon-icon--active::after\s*\{[^}]*background:\s*var\(--accent\)/,
    'the active-surface bar is gone, so nothing carries 1.4.11',
  )
  assert.match(
    APP,
    /\.vault-finder-tab--active\s*\{[^}]*var\(--accent\)/,
    'the finder tabs lost their selected indicator',
  )
})
