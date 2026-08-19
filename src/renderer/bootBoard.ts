/**
 * The boot board's pure geometry — wrapping, centring, and where the phrase
 * block sits in the field.
 *
 * SEPARATE FROM LoadingScreen.tsx SO IT CAN BE TESTED FOR REAL. That file is
 * JSX and node's type stripping does not handle it, so everything in it can
 * only be checked by matching regexes against its own source — which proves the
 * code was written, not that it computes anything. This module is plain .ts,
 * so `test/boot-board.test.mjs` imports it and runs it.
 *
 * Nothing here touches the DOM or React.
 */

/**
 * The widest a single LINE may be, in tiles.
 *
 * Not a limit on a phrase — phrases wrap. It is the board's column count, and
 * it is bounded by geometry rather than taste: the board is `(0.94n - 0.22)em`
 * wide and the font is `clamp(1.4rem, 4.2vw, 2.6rem)`, so on a narrow window 18
 * tiles take about 70% of the width. Past roughly 20 the board starts running
 * into the window edge at the vw-driven size.
 */
export const MAX_LINE = 18

/**
 * The alphabet every tile tumbles through.
 *
 * '?' AND '>' EARN THEIR PLACE HERE. A glyph outside this string lands on a
 * tile that never turned to it, so it appears from nowhere instead of arriving
 * — which is the one thing the board has to get right. Several phrases are
 * questions and one is a comparison, so the choice was to carry the punctuation
 * or to strip it out of somebody's own words. Carrying it is also what a real
 * departure board does; the letter drum has punctuation on it.
 *
 * Still no digits and no apostrophe: nothing needs them, and every glyph added
 * is one more the eye passes through before the word resolves.
 */
export const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ?>'

/**
 * Surplus rows the field carries beyond what the window needs, so the crawl
 * always has ground under it.
 *
 * `.boot-letters` animates `boot-crawl`, which translates the phrase down by
 * `--pitch * 2.5` — two and a half cells. The field does NOT move; it is the
 * ground. So the surplus is not about hiding a moving edge, it is about the
 * letters never crawling off the end of the board they are sitting on.
 *
 * Six, because the surplus is centred: three cells of cover above and three
 * below, which is one whole cell more than the crawl can consume. Without it a
 * SHORT window is the failure case — `fieldSize` floors at the block height, so
 * a window barely taller than the phrase gives a field the same height as the
 * block, and the crawl walks the letters straight off the bottom of it.
 */
export const DRIFT_ROWS = 6

export const sampleChar = (): string =>
  CHARSET.charAt(Math.floor(Math.random() * CHARSET.length))

/**
 * Opening noise for a block — random glyphs ONLY where the phrase will have a
 * letter, spaces everywhere else.
 *
 * ONLY THE CELLS THAT LAND ON SOMETHING EVER MOVE. Scrambling the whole block
 * meant the board opened as a solid rectangle of tumbling glyphs that then
 * dissolved into a sentence, so the shape of the phrase was invisible until the
 * moment it finished — and on a three-row block that rectangle is 54 cells of
 * noise. Masking the noise to the phrase means the SHAPE of what is coming is
 * there from the first frame and only the letters are unknown, which reads as a
 * board working rather than as a screen full of static.
 */
export const noiseLike = (target: string): string =>
  [...target].map((ch) => (ch === ' ' ? ' ' : sampleChar())).join('')

/**
 * Break a phrase into lines of at most `max` tiles, on word boundaries.
 *
 * THIS IS WHY THE PHRASE LIST IS NOT A LIST OF FRAGMENTS. A single-row board
 * caps a phrase at the board width, and the copy written for it is whatever
 * survives that cap — 'IF YOU MISS THE MOON YOULL LAND IN THE STARS' is 43
 * tiles, so on one row it is not a phrase you can shorten, it is a phrase you
 * have to abandon. Wrapping costs two extra rows of a field that is already a
 * thousand cells, and it is what lets the board say a sentence.
 *
 * A word longer than `max` overflows its line rather than being chopped
 * mid-word; the test suite refuses such a word instead, because a hyphenated
 * break on a flap board reads as a fault.
 */
export function wrap(phrase: string, max: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of phrase.split(' ')) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= max) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Centre a line in a fixed-width board.
 *
 * Was `padEnd`, which is two bugs. The obvious one: every phrase shorter than
 * the board carried its blank tiles on the right, so the text sat visibly left
 * of centre — 'VAULT ONLINE' in 13 tiles was off by half a tile.
 *
 * The quiet one: the width was a hardcoded 13 and the `.slice()` that enforced
 * it silently truncated 'AGENT WORKSPACE' to 'AGENT WORKSPA'. The width is now
 * derived from the longest line, so the slice can never cut a word again.
 */
export function padCentre(line: string, width: number): string {
  const left = Math.floor((width - line.length) / 2)
  return line.padStart(line.length + Math.max(0, left), ' ').padEnd(width, ' ')
}

/** The block every phrase is padded to: widest line, and most lines. */
export function boardSize(phrases: string[], max = MAX_LINE): {
  width: number
  rows: number
} {
  let width = 1
  let rows = 1
  for (const p of phrases) {
    const lines = wrap(p, max)
    rows = Math.max(rows, lines.length)
    for (const l of lines) width = Math.max(width, l.length)
  }
  return { width, rows }
}

/**
 * One phrase as a fixed `width x rows` block, read row-major.
 *
 * EVERY phrase becomes the same number of tiles, whatever its line count. That
 * is what keeps the flap engine untouched by any of this: it still animates a
 * flat array of constant length, and a two-line phrase following a three-line
 * one is not a resize. The unused rows are spaces, which tumble and land blank
 * exactly like the padding either side of a short line — on a field of blank
 * wells they are invisible.
 *
 * The block is centred vertically as well as horizontally, so a one-line phrase
 * sits on the middle row rather than at the top of a three-row box.
 */
export function layout(
  phrase: string,
  max: number,
  width: number,
  rows: number,
): string {
  const lines = wrap(phrase, max)
  const top = Math.floor((rows - lines.length) / 2)
  let out = ''
  for (let r = 0; r < rows; r++) out += padCentre(lines[r - top] ?? '', width)
  return out
}

/**
 * The field that covers a window, in cells.
 *
 * `ceil` covers the window; the `+ 1` overshoots it by a whole cell so there is
 * a PARTIAL cell at every edge for `.boot`'s overflow to clip. A field that
 * ended flush would read as a panel sitting on the screen rather than as the
 * screen itself.
 *
 * PARITY IS THE WHOLE ALIGNMENT CONTRACT NOW, and it is worth being precise
 * about why. The field and the letters are two separate grids, both
 * `position: absolute; inset: 0` and both centring their own tracks. The
 * letters therefore sit `((cols - width) * (cellW + gap)) / 2` from the field's
 * left edge, and that is a whole number of cells only when `cols - width` is
 * EVEN. Same argument vertically.
 *
 * Get it wrong and every glyph sits half a cell off its well — about 15px here.
 * Small, but on a grid this regular it is the kind of thing you see without
 * being able to say what is wrong.
 */
export function fieldSize(
  clientWidth: number,
  clientHeight: number,
  cell: { w: number; h: number; gap: number },
  width: number,
  blockRows: number,
): { cols: number; rows: number } {
  let cols = Math.ceil((clientWidth + cell.gap) / (cell.w + cell.gap)) + 1
  // Plus the crawl's headroom. Vertical only: `boot-crawl` translates on Y, so
  // the columns need no equivalent and paying for them would be a whole extra
  // column of cells on every row of a field that is already a thousand.
  let rows = Math.ceil((clientHeight + cell.gap) / (cell.h + cell.gap)) + 1 + DRIFT_ROWS
  // Never smaller than the block, or it would be clipped by its own field.
  cols = Math.max(cols, width)
  rows = Math.max(rows, blockRows + DRIFT_ROWS)
  if ((cols - width) % 2 !== 0) cols += 1
  if ((rows - blockRows) % 2 !== 0) rows += 1
  return { cols, rows }
}
