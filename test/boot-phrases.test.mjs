/**
 * THE BOOT BOARD'S COPY.
 *
 * The phrase list is content and lives in LoadingScreen.tsx, so it is read out
 * of that file's source. Everything it is checked AGAINST is imported and run
 * from `src/renderer/bootBoard.ts` — the board's real wrap, its real charset —
 * rather than reimplemented here, because a test that reimplements the thing it
 * is testing agrees with itself no matter what the app does.
 *
 * The list is quietly constrained in ways nobody would guess by looking at it,
 * and every one of them fails SILENTLY — the screen still renders, it just stops
 * being convincing:
 *
 *   1. A character outside CHARSET lands on a tile that never tumbled to it, so
 *      it appears from nowhere instead of arriving. Lowercase, digits and the
 *      apostrophe are the traps.
 *   2. A WORD wider than MAX_LINE cannot be broken — wrap splits on spaces only
 *      — so it overflows the board rather than wrapping.
 *   3. Every phrase is padded to the tallest one, so ONE long entry sets the
 *      block height for every boot.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { MAX_LINE, CHARSET, wrap, boardSize } = await import(
  '../src/renderer/bootBoard.ts'
)

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Newlines normalised: core.autocrlf=true means CRLF on disk, and any
// assertion spanning a line break matches nothing without this.
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')
const SRC = read('src/renderer/LoadingScreen.tsx')
const SRC_BOARD = read('src/renderer/bootBoard.ts')

/** The array body, with `//` comments stripped so quoted examples inside them
 *  are not mistaken for entries. */
const phrases = () => {
  const open = SRC.indexOf('const PHRASES = [')
  assert.ok(open > -1, 'PHRASES is gone or was renamed')
  const close = SRC.indexOf('\n]', open)
  const body = SRC.slice(open, close).replace(/\/\/.*$/gm, '')
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

test('the charset is exactly what the board can tumble to', () => {
  // Exact rather than a subset check: a glyph silently ADDED here is a glyph
  // every tile now passes through on every boot, which changes the feel of the
  // thing and should be deliberate.
  assert.equal(CHARSET, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ?>')
})

test('there is more than one phrase, or there is no surprise', () => {
  assert.ok(phrases().length >= 2, 'a single phrase makes the random pick pointless')
})

test('every character can be reached by a tumbling tile', () => {
  // Space is legal even though it is not in CHARSET: padCentre inserts it, and
  // a blank cell is a resting state rather than a glyph to land on.
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
    assert.doesNotMatch(p, / {2}/, `"${p}" has a double space, which reads as a hole in the board`)
  }
})

test('no word is too wide to wrap', () => {
  // wrap() breaks on spaces only, so a word wider than the board overflows it
  // rather than being chopped. Chopping mid-word on a flap board reads as a
  // fault, so the word is refused here instead.
  for (const p of phrases()) {
    for (const word of p.split(' ')) {
      assert.ok(
        word.length <= MAX_LINE,
        `"${word}" is ${word.length} tiles and cannot be broken — the board is ${MAX_LINE}`,
      )
    }
  }
})

test('every wrapped line fits the board', () => {
  for (const p of phrases()) {
    for (const line of wrap(p, MAX_LINE)) {
      assert.ok(line.length <= MAX_LINE, `"${line}" is ${line.length}, over the board width`)
    }
  }
})

test('the block stays a sane number of rows', () => {
  // Every phrase is padded to the tallest, so one long entry sets the height
  // for EVERY boot, and the tile count is width x rows cells all animating.
  // Three rows is a phrase; ten is a paragraph on a splash screen.
  const { width, rows } = boardSize(phrases(), MAX_LINE)
  assert.ok(
    rows <= 4,
    `the tallest phrase needs ${rows} rows, and that is the height every boot gets`,
  )
  assert.ok(width <= MAX_LINE)
})

test('no duplicates — a repeat halves the odds of something else', () => {
  const all = phrases()
  assert.equal(new Set(all).size, all.length, 'PHRASES contains a duplicate')
})

test('the board does not always open on the same phrase', () => {
  /**
   * The regression this exists for, because it shipped: `let index = 0` plus
   * `animateTo(padded[0])` meant every boot opened on PHRASES[0] — and a boot
   * shows ONE phrase, so it never advanced off it either. Fifteen phrases, one
   * of them ever seen.
   *
   * Which one you get is the whole feature, so the START index is the whole
   * mechanism, and it is worth a guard.
   */
  assert.doesNotMatch(
    SRC,
    /animateTo\(padded\[0\]/,
    'the opening phrase is hardcoded to the first entry',
  )
  assert.match(
    SRC,
    /let index = Math\.floor\(Math\.random\(\) \* padded\.length\)/,
    'the starting index is not randomised',
  )
})

test('nothing scrambles once the crawl has started', () => {
  /**
   * A scramble repaints well backgrounds onto the letter cells so the flap
   * reads. Those cells are mid-crawl by then, so a second phrase would drag a
   * set of sliding rectangles across a board whose whole point is that the
   * wells hold still. The cycling timer that used to do this is gone; this
   * stops it coming back.
   */
  assert.doesNotMatch(SRC, /const HOLD_MS/, 'the phrase-cycling timer is back')
  assert.doesNotMatch(SRC, /schedule\(/, 'something re-schedules a second scramble')
})

test('the boot lasts long enough to finish its own animations', () => {
  /**
   * BOOT_MIN_MS is the sum of three numbers that live in two files. Cut it and
   * the crawl is truncated mid-move, which reads as the splash being yanked
   * away rather than finishing.
   */
  const css = read('src/renderer/LoadingScreen.css')

  // The timing function is matched loosely on purpose: this test is about
  // DURATION outliving the animation, and pinning the easing here made it
  // fail the moment the crawl was quantised to steps().
  const crawl = css.match(/animation: boot-crawl ([\d.]+)s [^;]*?([\d.]+)s both/)
  assert.ok(crawl, 'the crawl animation is gone or was rewritten')
  const crawlEnds = (Number(crawl[1]) + Number(crawl[2])) * 1000

  const fade = css.match(/animation: boot-out var\(--duration-normal\)[^;]*?([\d.]+)s both/)
  assert.ok(fade, 'the fade animation is gone or was rewritten')
  const fadeStarts = Number(fade[1]) * 1000

  const min = Number(SRC.match(/const BOOT_MIN_MS = (\d+)/)[1])

  assert.ok(
    min >= crawlEnds,
    `the boot ends at ${min}ms but the crawl runs to ${crawlEnds}ms`,
  )
  assert.ok(
    fadeStarts >= crawlEnds - 400,
    `the fade starts at ${fadeStarts}ms, well before the crawl ends at ${crawlEnds}ms`,
  )
})

test('the crawl moves a WHOLE number of cells, so the letters land in wells', () => {
  /**
   * The bug this exists for, found by Nathan looking at it: the crawl ended on
   * `--pitch * 2.5`. `--pitch` is one cell plus one gap, so a half-pitch leaves
   * every glyph straddling the gap between two wells — and because the
   * animation is `both`, that is where the board COMES TO REST. The letters
   * read as floating on the board instead of sitting in it, which is the one
   * thing the well modelling exists to convey.
   *
   * Measured before the fix, against the running app: 0px off before the crawl
   * started, 6.8px at 2.6s, 20.7px at 3.9s, heading for a full half-pitch.
   *
   * A fraction here is invisible in review and obvious on screen, which is
   * exactly the kind of thing that belongs in a test rather than in a comment.
   */
  const css = read('src/renderer/LoadingScreen.css')

  // `[\s\S]*?` not `[^}]*?`: the `from` block closes with a brace, and a
  // negated-brace class stops dead at it before ever reaching the `to` line.
  const move = css.match(/@keyframes boot-crawl[\s\S]*?translateY\(calc\(var\(--pitch\) \* ([\d.]+)\)\)/)
  assert.ok(move, 'the crawl no longer translates by a multiple of --pitch')
  const cells = Number(move[1])
  assert.equal(cells, Math.round(cells), `the crawl moves ${cells} cells and would rest off-well`)
  assert.ok(cells >= 1, 'a crawl of zero cells is not a crawl')

  // And the field has to carry cover for however far it moves, at both ends.
  const drift = Number(SRC_BOARD.match(/export const DRIFT_ROWS = (\d+)/)[1])
  assert.ok(
    Math.floor(drift / 2) >= cells,
    `${drift} surplus rows gives ${Math.floor(drift / 2)} cells of cover for a ${cells}-cell crawl`,
  )
})

test('the crawl STEPS between wells instead of gliding across them', () => {
  /**
   * The defect, seen by Nathan and then in a screenshot: with a `linear` crawl
   * the letters glide continuously down the board, so for all but three
   * instants of a 2.6s animation they sit BETWEEN wells — the phrase floats on
   * the grid rather than sitting in it. Landing on a whole cell at the end
   * fixed the final frame and left the other 2.59 seconds wrong.
   *
   * `steps(n)` quantises the move to a cell at a time. Measured against the
   * running app afterwards: 0px off its well at 2.4s, 3.2s and 3.9s, where the
   * gliding version was 6.8px and 20.7px off.
   *
   * The step count must equal the cell distance, or it quantises to something
   * that is not a cell and the whole point is lost.
   */
  const css = read('src/renderer/LoadingScreen.css')

  const timing = css.match(/animation: boot-crawl [\d.]+s steps\((\d+)[^)]*\)/)
  assert.ok(timing, 'the crawl is no longer stepped — it will float between wells')

  const move = css.match(/@keyframes boot-crawl[\s\S]*?translateY\(calc\(var\(--pitch\) \* ([\d.]+)\)\)/)
  assert.ok(move, 'the crawl no longer translates by a multiple of --pitch')

  assert.equal(
    Number(timing[1]),
    Number(move[1]),
    `${timing[1]} steps over ${move[1]} cells does not land on cell boundaries`,
  )
})
