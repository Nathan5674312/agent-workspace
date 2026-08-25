/**
 * Card and edge colours.
 *
 * The bug this closes: `color` round-tripped untouched and was never painted,
 * so a board where the user had colour-coded their cards rendered entirely
 * grey. Nathan confirmed it on screen against a real Obsidian-authored file.
 *
 * The two forms resolve DIFFERENTLY and that is the whole of this feature. A
 * preset `"1"`–`"6"` is an index into a palette the reading app chooses, so it
 * becomes a variable. A hex string is the user naming an exact colour, so it
 * passes through as itself — substituting a palette entry there would override
 * a choice they made explicitly.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource, readRaw } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')
const CSS = readRaw('canvas.css')

const BOARD = {
  nodes: [
    { id: 'preset', type: 'text', text: 'p', x: 0, y: 0, width: 100, height: 100, color: '4' },
    { id: 'hex', type: 'text', text: 'h', x: 200, y: 0, width: 100, height: 100, color: '#FF0000' },
    { id: 'plain', type: 'text', text: 'n', x: 400, y: 0, width: 100, height: 100 },
    { id: 'junk', type: 'text', text: 'j', x: 600, y: 0, width: 100, height: 100, color: 99 },
  ],
  edges: [{ id: 'e', fromNode: 'preset', toNode: 'hex', color: '2' }],
}

// ------------------------------------------------------------------- format

test('colours survive a round trip in both forms, and junk is not repaired', () => {
  // Repairing `color: 99` would be this app rewriting a file it does not
  // understand. It renders as uncoloured and is written back exactly as found.
  const doc = parseCanvas(JSON.stringify(BOARD))
  const back = JSON.parse(serializeCanvas(doc))
  assert.equal(back.nodes[0].color, '4')
  assert.equal(back.nodes[1].color, '#FF0000')
  assert.equal('color' in back.nodes[2], false, 'a colour was invented for an uncoloured card')
  assert.equal(back.nodes[3].color, 99, 'an unusable colour was rewritten')
  assert.equal(back.edges[0].color, '2')
})

// ------------------------------------------------------------------- wiring

test('a preset resolves to a variable and a hex passes through as itself', () => {
  // THE LOAD-BEARING ASSERTION. Collapsing both to one branch is the plausible
  // wrong version: map a hex through the palette and the user's exact colour is
  // replaced by an approximation, silently.
  assert.match(
    VIEW,
    /\/\^\[1-6\]\$\/\.test\(color\)\) return `var\(--canvas-color-\$\{color\}\)`/,
    'presets do not resolve to a palette variable',
  )
  // Pins the hex TEST and its return together. `/return color\b/` alone never
  // touched the hex branch: delete the whole `/^#.../` check and it still
  // passed, as long as some function somewhere returned a variable called
  // `color`. Which is exactly the branch whose absence would silently replace a
  // user's chosen colour with a palette approximation.
  assert.match(
    VIEW,
    /\/\^#\[0-9a-f\]\{3,8\}\$\/i\.test\(color\)\)\s*return color\b/,
    'a hex colour is not passed through unchanged',
  )
})

test('no colour means the property is REMOVED, not blanked', () => {
  // An empty custom property still counts as set, so `var(--canvas-color,
  // fallback)` would resolve to nothing rather than the fallback and an
  // uncoloured card would lose its border entirely.
  assert.match(
    VIEW,
    /removeProperty\('--canvas-color'\)/,
    'an uncoloured element blanks the property instead of removing it',
  )
  assert.match(VIEW, /setProperty\('--canvas-color', value\)/, 'the colour is never applied')
})

test('colour is applied through setProperty, never an inline style object', () => {
  // review-s2-vault-pane bans style={{}} in this pane. A per-element hex from
  // a file cannot become a stylesheet rule, so the custom property is the only
  // route that satisfies both.
  assert.doesNotMatch(VIEW, /style=\{\{/, 'the pane grew an inline style object')
})

test('every element that can carry a colour falls back when it has none', () => {
  for (const rule of [
    // This pins the FALLBACK — what the test is actually about — rather than the
    // literal `1px` it used to spell out. A card with no colour must still have
    // an edge. The card's edge is an inset shadow rather than a border because
    // Chromium truncates border-width to whole pixels and the board scales.
    /box-shadow: inset 0 0 0 var\(--canvas-edge\) var\(--canvas-color, var\(--separator-opaque\)\)/,
    /border: var\(--canvas-edge\) dashed var\(--canvas-color, var\(--label-quaternary\)\)/,
    /stroke: var\(--canvas-color, var\(--label-tertiary\)\)/,
    /fill: var\(--canvas-color, var\(--label-secondary\)\)/,
  ]) {
    assert.match(CSS, rule, `a colourable element has no fallback: ${rule}`)
  }
})

test('both colour strokes cancel the board zoom, so neither outruns the other', () => {
  // The defect this closes: the spine cancelled zoom and the border did not, so
  // at 20% the border was a fifth of a pixel and gone while the spine stayed —
  // a card whose colour changed character with how far you had zoomed out.
  assert.match(CSS, /--canvas-edge: min\(calc\(1px \/ var\(--canvas-k, 1\)\), \d+px\)/)
  assert.match(CSS, /--canvas-spine: min\(calc\(3px \/ var\(--canvas-k, 1\)\), \d+px\)/)
  assert.match(CSS, /width: var\(--canvas-spine\)/, 'the spine stopped using the shared width')
})

test('all six presets are defined in one place, and derived rather than borrowed', () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    assert.match(CSS, new RegExp(`--canvas-color-${n}: #[0-9a-f]{6};`), `preset ${n} is not a literal`)
  }

  /**
   * NO PRESET MAY BORROW A SEMANTIC TOKEN. 1/2/4 used to be --danger,
   * --warning and --success, which was a category error: those tokens mean
   * something in this app and a red CARD does not mean danger. It also dragged
   * their wildly different lightnesses into what was supposed to be one set.
   */
  for (const token of ['--danger', '--warning', '--success']) {
    assert.doesNotMatch(
      CSS,
      new RegExp(`--canvas-color-\\d: var\\(${token}\\)`),
      `a preset borrows ${token}, which means something else in this app`,
    )
  }

  // Each one records the oklch it came from, so the next person can see the set
  // was derived at one lightness and one chroma rather than eyeballed.
  const derivations = [...CSS.matchAll(/--canvas-color-\d: #[0-9a-f]{6}; \/\* \w+\s+oklch\((0\.\d+) (0\.\d+)\s+\d+\) \*\//g)]
  assert.equal(derivations.length, 6, 'not every preset records its oklch derivation')
  const lightnesses = new Set(derivations.map((m) => m[1]))
  const chromas = new Set(derivations.map((m) => m[2]))
  assert.equal(lightnesses.size, 1, `the set spans ${lightnesses.size} lightnesses, so it is not one set`)
  assert.equal(chromas.size, 1, `the set spans ${chromas.size} chromas, so it is not one set`)
})
