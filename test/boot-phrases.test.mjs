/**
 * THE BOOT BOARD'S PHRASE LIST.
 *
 * The split-flap board tumbles each tile through CHARSET before it lands. That
 * makes the phrase list quietly constrained in two ways nobody would guess from
 * looking at it, and both fail SILENTLY — the screen still renders, it just
 * stops being convincing:
 *
 *   1. A character outside CHARSET lands on a tile that never tumbled to it, so
 *      it appears from nowhere instead of arriving. `LOADING...` is the obvious
 *      trap; so is anything lowercase, and so is a digit.
 *   2. The board's width is the LONGEST phrase. One long entry silently widens
 *      every other screen, and past a point the board stops fitting the window.
 *
 * Source-level because LoadingScreen.tsx is JSX and node's type stripping does
 * not handle it — the same reason review-s2 tests the vault pane by reading it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Newlines normalised: core.autocrlf=true means CRLF on disk, and any
// assertion spanning a line break matches nothing without this.
const SRC = readFileSync(join(ROOT, 'src/renderer/LoadingScreen.tsx'), 'utf-8').replace(
  /\r\n/g,
  '\n',
)

/** The array body, with `//` comments stripped so quoted examples inside them
 *  are not mistaken for entries. */
const phraseBlock = () => {
  const open = SRC.indexOf('const PHRASES = [')
  assert.ok(open > -1, 'PHRASES is gone or was renamed')
  const close = SRC.indexOf(']', open)
  return SRC.slice(open, close).replace(/\/\/.*$/gm, '')
}

const phrases = () => [...phraseBlock().matchAll(/'([^']*)'/g)].map((m) => m[1])

const CHARSET = (() => {
  const m = SRC.match(/const CHARSET = '([^']+)'/)
  assert.ok(m, 'CHARSET is gone or was renamed')
  return m[1]
})()

test('CHARSET is the alphabet the tiles actually tumble through', () => {
  assert.equal(CHARSET, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
})

test('there is more than one phrase, or there is no surprise', () => {
  assert.ok(phrases().length >= 2, 'a single phrase makes the random pick pointless')
})

test('every character can be reached by a tumbling tile', () => {
  // Space is legal even though it is not in CHARSET: padCentre inserts it, and
  // a blank tile is a resting state rather than a glyph to land on.
  const allowed = new Set([...CHARSET, ' '])
  for (const p of phrases()) {
    for (const ch of p) {
      assert.ok(
        allowed.has(ch),
        `"${p}" contains ${JSON.stringify(ch)}, which no tile can tumble to — ` +
          `it would appear from nowhere instead of arriving`,
      )
    }
  }
})

test('no phrase is blank or padded at the edges', () => {
  for (const p of phrases()) {
    assert.ok(p.trim().length > 0, 'a blank phrase renders an empty board')
    assert.equal(p, p.trim(), `"${p}" has edge whitespace; padCentre owns the centring`)
  }
})

test('the longest phrase does not silently widen the board', () => {
  // The board is sized to the longest entry, so this is a budget shared by
  // every phrase — not a limit on the one that happens to be longest.
  const longest = phrases().reduce((a, b) => (b.length > a.length ? b : a), '')
  assert.ok(
    longest.length <= 15,
    `"${longest}" is ${longest.length} tiles; the board is sized to the longest ` +
      `phrase, so this widens EVERY boot screen`,
  )
})

test('no duplicates — a repeat halves the odds of something else', () => {
  const all = phrases()
  assert.equal(new Set(all).size, all.length, 'PHRASES contains a duplicate')
})
