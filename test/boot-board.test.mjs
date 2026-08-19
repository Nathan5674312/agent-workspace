/**
 * THE BOOT BOARD'S GEOMETRY, RUN RATHER THAN GREPPED.
 *
 * `src/renderer/bootBoard.ts` exists so this file can exist. LoadingScreen.tsx
 * is JSX and node's type stripping does not handle it, so everything that stays
 * in there can only be checked by matching regexes against its own source —
 * which proves a line was written, not that it computes the right answer. The
 * geometry is the part where a wrong answer is invisible in review and obvious
 * on screen, so it lives in plain .ts and gets executed here.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  MAX_LINE,
  DRIFT_ROWS,
  CHARSET,
  noiseLike,
  wrap,
  padCentre,
  boardSize,
  layout,
  fieldSize,
} = await import('../src/renderer/bootBoard.ts')

// ------------------------------------------------------------------ wrapping

test('a phrase that fits stays on one line', () => {
  assert.deepEqual(wrap('SHOOT FOR THE MOON', 18), ['SHOOT FOR THE MOON'])
})

test('a long phrase breaks on spaces and never mid-word', () => {
  const lines = wrap('IF YOU MISS THE MOON YOULL LAND IN THE STARS', 18)
  assert.deepEqual(lines, ['IF YOU MISS THE', 'MOON YOULL LAND IN', 'THE STARS'])
  // The load-bearing property, stated independently of the expected value
  // above: rejoining the lines has to give back the original phrase. A wrap
  // that drops or duplicates a word would still look plausible line by line.
  assert.equal(lines.join(' '), 'IF YOU MISS THE MOON YOULL LAND IN THE STARS')
  for (const l of lines) assert.ok(l.length <= 18, `"${l}" is over the width`)
})

test('wrapping never loses or invents a word, for any width', () => {
  const phrase = 'COUNT THE TIME IN DAYS NOT HOURS ANYMORE'
  for (let max = 8; max <= 40; max++) {
    assert.equal(wrap(phrase, max).join(' '), phrase, `width ${max} corrupted the phrase`)
  }
})

// ------------------------------------------------------------------ centring

test('a line is centred, not left-aligned with trailing blanks', () => {
  // The original bug: padEnd put every blank on the right, so 'VAULT ONLINE'
  // in 13 tiles sat half a tile left of centre.
  const padded = padCentre('DONE', 10)
  assert.equal(padded, '   DONE   ')
  assert.equal(padded.length, 10)
})

test('an odd remainder leans left by half a cell, not by a whole one', () => {
  const padded = padCentre('ABC', 8)
  assert.equal(padded.length, 8)
  const left = padded.length - padded.trimStart().length
  const right = padded.length - padded.trimEnd().length
  assert.ok(Math.abs(left - right) <= 1, `lopsided by ${Math.abs(left - right)}`)
})

// -------------------------------------------------------------------- blocks

test('every phrase becomes the SAME number of tiles', () => {
  // This is what lets the flap engine animate a flat array of constant length.
  // A phrase that produced a different tile count would be a resize mid-boot.
  const phrases = ['DONE', 'IF YOU MISS THE MOON YOULL LAND IN THE STARS', 'ANYTHING NEW?']
  const { width, rows } = boardSize(phrases, MAX_LINE)
  const sizes = new Set(phrases.map((p) => layout(p, MAX_LINE, width, rows).length))
  assert.equal(sizes.size, 1, 'phrases produced different tile counts')
  assert.equal([...sizes][0], width * rows)
})

test('a short phrase sits on the MIDDLE row of a taller block', () => {
  const block = layout('DONE', MAX_LINE, 8, 3)
  const rows = [block.slice(0, 8), block.slice(8, 16), block.slice(16, 24)]
  assert.equal(rows[0].trim(), '', 'the phrase was pinned to the top row')
  assert.equal(rows[1].trim(), 'DONE')
  assert.equal(rows[2].trim(), '')
})

test('a block reads back as the phrase it was built from', () => {
  const phrase = 'HOW MANY FACES WILL BE IN YOUR LIFE'
  const { width, rows } = boardSize([phrase], MAX_LINE)
  const block = layout(phrase, MAX_LINE, width, rows)
  const read = Array.from({ length: rows }, (_, r) =>
    block.slice(r * width, (r + 1) * width).trim(),
  )
    .filter(Boolean)
    .join(' ')
  assert.equal(read, phrase)
})

// ------------------------------------------------------------------ the noise

test('only the cells that will hold a letter ever carry a glyph', () => {
  // The change this pins: the board used to open as a solid rectangle of
  // static. Now a cell that lands on a space is blank from the first frame to
  // the last, so the SHAPE of the phrase is there before any of its letters.
  const block = layout('IS THE SUN OUT?', MAX_LINE, 18, 3)
  const noise = noiseLike(block)

  assert.equal(noise.length, block.length)
  for (let i = 0; i < block.length; i++) {
    if (block[i] === ' ') assert.equal(noise[i], ' ', `cell ${i} scrambles but lands blank`)
    else assert.ok(CHARSET.includes(noise[i]), `cell ${i} shows "${noise[i]}", not in CHARSET`)
  }
})

/* ----------------------------------------------------------------- placement

   THE TWO `placement` TESTS THAT WERE HERE ARE GONE ON PURPOSE, and this note
   is here so the next person does not helpfully restore them.

   They tested a `placement(cols, rows, w, r)` that returned the runs of blank
   cells before, between and after the phrase rows — the arithmetic the ONE-GRID
   board needed, where every cell of the field and the phrase was a child of the
   same grid and the phrase was positioned by counting blanks around it.

   The board no longer works that way. `.boot-field` and `.boot-letters` are two
   grids now, each `position: absolute; inset: 0`, each centring its own tracks,
   so the phrase is CENTRED rather than positioned and there are no surrounding
   blanks to count. Nothing imports `placement`; keeping tests for it would have
   forced an exported function into bootBoard.ts that the screen never calls.

   What replaced the guarantee is the parity contract, and it is tested below in
   "the block can always be centred exactly, at any window size": two
   independently centred grids line up only when `cols - width` and
   `rows - blockRows` are both EVEN, and `fieldSize` enforces that. That test is
   the one that fails if the letters ever sit half a cell off their wells. */

// ----------------------------------------------------------------- the field

const CELL = { w: 29.95, h: 48.26, gap: 9.15 } // 2.6rem, the clamp ceiling

test('the field covers the window and then some, on every side', () => {
  const { cols, rows } = fieldSize(1920, 1080, CELL, 18, 3)
  assert.ok(
    cols * CELL.w + (cols - 1) * CELL.gap > 1920,
    'the field is narrower than the window',
  )
  assert.ok(
    rows * CELL.h + (rows - 1) * CELL.gap > 1080,
    'the field is shorter than the window',
  )
})

test('the field carries enough rows for the crawl', () => {
  // Paired with `@keyframes boot-crawl`, which translates the letters by 2.5 cells. The
  // surplus is centred, so half of it sits above the window.
  const bare = fieldSize(1920, 1080, CELL, 18, 3)
  assert.ok(DRIFT_ROWS >= 6, `${DRIFT_ROWS} rows is under 3 cells of cover at each end`)
  const covered = Math.floor(DRIFT_ROWS / 2)
  assert.ok(covered >= 3, `only ${covered} cells of cover for a 3-cell drift`)
  assert.ok(bare.rows > 1080 / (CELL.h + CELL.gap) + 3)
})

test('the block can always be centred exactly, at any window size', () => {
  // Parity. Without it the block sits half a cell off — ~15px, small, but on a
  // grid this regular it is the kind of thing you see without being able to say
  // what is wrong.
  for (let w = 400; w <= 2400; w += 37) {
    for (let h = 300; h <= 1600; h += 53) {
      const { cols, rows } = fieldSize(w, h, CELL, 18, 3)
      assert.equal((cols - 18) % 2, 0, `${w}x${h}: ${cols} cols cannot centre an 18 block`)
      assert.equal((rows - 3) % 2, 0, `${w}x${h}: ${rows} rows cannot centre a 3 block`)
      assert.ok(cols >= 18 && rows >= 3, `${w}x${h}: field smaller than the block`)
    }
  }
})

test('a window narrower than the board still fits the board', () => {
  // The clamp keeps this from happening in practice, but a field smaller than
  // its own phrase would clip the phrase rather than the field.
  const { cols, rows } = fieldSize(120, 90, CELL, 18, 3)
  assert.ok(cols >= 18)
  assert.ok(rows >= 3)
})
