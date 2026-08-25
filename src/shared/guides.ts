/**
 * ALIGNMENT AND SPACING GUIDES: the lines that appear while you drag a card.
 *
 * Shift-dragging a card already snapped it — to another card's edge or centre,
 * or failing that to the dot grid. What it never did was SAY SO. The card
 * jumped, and whether it had locked onto the neighbour you were aiming at, some
 * other card across the board, or just the nearest dot was left for you to work
 * out by looking. A snap you cannot see is indistinguishable from a twitch.
 *
 * So this returns the offset AND the evidence: which line was matched, and
 * between which two boxes. The view draws that, and the gesture explains itself
 * while it happens.
 *
 * IT ALSO ADDS SPACING, which alignment alone cannot express. "These three are
 * left-aligned" is one relationship; "these three are evenly spaced" is another,
 * and no amount of edge-snapping gets you the second. Two mechanisms, both
 * below, and they are kept apart because they answer different questions.
 *
 * WHY `shared/` AND WHY PURE. The same reason `pipeline.ts` and the edge
 * geometry give: while this arithmetic sat in CanvasView the only thing a test
 * could do was regex its source, which proves a line was written and not that it
 * computes the right answer. canvas-snap.test.mjs says so in its own header. It
 * imports this now instead of re-declaring it.
 *
 * No DOM, no React, no constants of its own — `grid` and `range` are passed in,
 * because CanvasView owns them (it publishes the grid spacing to CSS so the dots
 * and the snap cannot disagree) and two copies of a number is how they start to.
 */

export type GuideBox = { x: number; y: number; width: number; height: number }

/**
 * One line the view draws.
 *
 * `axis` names the axis the RELATIONSHIP is on, not the direction the line is
 * drawn in, and the two are perpendicular. An `x` alignment means "these boxes
 * share an x coordinate", which is drawn as a VERTICAL line: `at` is the shared
 * x, and `from`/`to` are the y range it spans.
 *
 * A `gap` is the other way round: `at` is the cross-axis position to draw it at,
 * and `from`/`to` bound the gap itself along `axis`. `size` is its length, which
 * the view prints, because "these two gaps are equal" is a claim the user should
 * be able to check rather than take on trust.
 */
export type Guide =
  | { kind: 'align'; axis: 'x' | 'y'; at: number; from: number; to: number }
  | { kind: 'gap'; axis: 'x' | 'y'; at: number; from: number; to: number; size: number }

/**
 * A guide's two endpoints, in world units.
 *
 * THE ONE PLACE THE PERPENDICULARITY IS RESOLVED, and it lives here rather than
 * inline in the view for exactly one reason: `at` and `from`/`to` swap roles
 * between the two kinds, an `x` relationship draws a `y`-spanning line, and
 * every one of those is a chance to write `x1={g.from}` and get a plausible
 * picture of the wrong thing. In JSX that is invisible to every test in this
 * repo. Here it is four numbers a test can assert.
 */
export function guideLine(g: Guide): { x1: number; y1: number; x2: number; y2: number } {
  // An ALIGN on x is a shared x drawn as a vertical line: constant x, spanning
  // y. A GAP on x is a distance along x drawn as a horizontal bar: constant y,
  // spanning x. Same word, opposite orientation, which is the whole trap.
  const along = g.kind === 'align' ? g.axis === 'y' : g.axis === 'x'
  return along
    ? { x1: g.from, y1: g.at, x2: g.to, y2: g.at }
    : { x1: g.at, y1: g.from, x2: g.at, y2: g.to }
}

/** One box reduced to the axis under consideration. `cross` is the other one. */
type Span = { start: number; size: number; crossStart: number; crossSize: number }

const spanEnd = (s: Span): number => s.start + s.size

/**
 * The candidate lines a box offers: its two edges and its centre.
 *
 * All three, because all three come up when laying out a board. Edge-to-edge
 * builds a column, centre-to-centre centres a caption under a page, and
 * left-to-RIGHT is what puts two pages flush side by side.
 */
export const alignLines = (start: number, size: number): number[] => [
  start,
  start + size / 2,
  start + size,
]

/** Each of a box's own lines, rounded to the nearest dot. */
export const gridLines = (start: number, size: number, grid: number): number[] =>
  alignLines(start, size).map((v) => Math.round(v / grid) * grid)

/**
 * The closest line, and how far it is.
 *
 * `index` is the position in `lines`, which is the only way the caller can tell
 * a card line from a grid line afterwards — a guide is worth drawing for the
 * first and not for the second, because a line through a dot explains nothing.
 *
 * The double loop is ordered mine-outer, theirs-inner, and the comparison is
 * strictly less-than, so the FIRST line encountered wins a tie. That ordering is
 * load-bearing rather than incidental: it is what the view did before this
 * module existed, and changing it would silently re-resolve every tie on every
 * board.
 */
export function bestLine(
  start: number,
  size: number,
  lines: number[],
  range: number,
): { offset: number; line: number; index: number; gap: number } | null {
  let best: { offset: number; line: number; index: number; gap: number } | null = null
  for (const mine of alignLines(start, size)) {
    for (let i = 0; i < lines.length; i++) {
      const gap = Math.abs(lines[i] - mine)
      if (gap < (best ? best.gap : range)) {
        best = { offset: lines[i] - mine, line: lines[i], index: i, gap }
      }
    }
  }
  return best
}

/**
 * The offset alone. The shape the view used before guides existed, kept because
 * it is the honest unit to test the tie-breaking and range rules against.
 */
export function snapOffset(
  start: number,
  size: number,
  lines: number[],
  range: number,
): number {
  return bestLine(start, size, lines, range)?.offset ?? 0
}

/**
 * Do two boxes share any of the cross axis?
 *
 * The filter that makes spacing mean anything. A gap to a card in a different
 * row is not a gap the eye reads as a gap, so distributing against it would
 * snap the card to a relationship nobody can see. Overlap on the perpendicular
 * axis is the standard rule for this and it is the cheap one.
 */
const inBand = (a: Span, b: Span): boolean =>
  a.crossStart < b.crossStart + b.crossSize && b.crossStart < a.crossStart + a.crossSize

/**
 * Every gap that already exists between neighbours in this band.
 *
 * These are the "similar distances" a new card can be made to match. Taken from
 * ADJACENT pairs only, after sorting: the space between card 1 and card 3 is not
 * a gap anyone is looking at when card 2 sits between them.
 *
 * Zero and negative gaps are dropped. Two boxes that touch or overlap describe
 * no spacing to repeat, and offering 0 as a target would make every card want to
 * stick to every other card.
 */
function existingGaps(peers: Span[]): { size: number; from: number; to: number }[] {
  const sorted = [...peers].sort((a, b) => a.start - b.start)
  const out: { size: number; from: number; to: number }[] = []
  const seen = new Set<number>()
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = spanEnd(sorted[i])
    const to = sorted[i + 1].start
    // Rounded before de-duplication: two gaps that differ by a hundredth of a
    // unit are the same gap to anyone looking at the board, and treating them
    // as two would offer two snap targets a pixel apart.
    const size = Math.round(to - from)
    if (size <= 0 || seen.has(size)) continue
    seen.add(size)
    // The SOURCE segment is carried, not just the number, so the view can draw
    // the gap that was matched alongside the one that was made. "The same
    // distance as those two" is a claim about a pair; showing only the new gap
    // states the conclusion and hides the evidence.
    out.push({ size, from, to })
  }
  return out
}

/**
 * Where the moving box could go to make its spacing match something.
 *
 * Two families, and they are different intentions:
 *
 *   REPEAT — sit at an existing gap's distance from some card, on either side of
 *   it. This is "put this one the same distance away as those two are", which is
 *   what building a row of evenly spaced cards actually consists of.
 *
 *   CENTRE — sit between two cards with equal space either side. This one needs
 *   no existing gap to copy, which is why it is separate: it is the only spacing
 *   relationship available when there are just two other cards on the board.
 *
 * Each candidate carries the segments to draw, because the position alone would
 * leave the view re-deriving which gaps it was that matched, and re-derivation
 * is where the drawn line stops agreeing with the applied snap.
 */
function spacingCandidates(
  moving: Span,
  peers: Span[],
): { start: number; pair: [number, number][] }[] {
  const out: { start: number; pair: [number, number][] }[] = []
  const gaps = existingGaps(peers)
  const sorted = [...peers].sort((a, b) => a.start - b.start)

  for (const p of peers) {
    for (const g of gaps) {
      // The matched gap is drawn alongside the new one, so the two equal bars
      // sit on the board together. Skipped when the new gap IS the source —
      // that happens when the card is placed back where the pair already
      // touches, and drawing one bar twice reads as a rendering fault.
      const source: [number, number] = [g.from, g.to]
      // To the right of p.
      const right = spanEnd(p)
      if (right !== g.from) {
        out.push({ start: right + g.size, pair: [[right, right + g.size], source] })
      } else {
        out.push({ start: right + g.size, pair: [[right, right + g.size]] })
      }
      // To the left of p.
      const left = p.start - g.size
      if (p.start !== g.to) {
        out.push({ start: left - moving.size, pair: [[left, p.start], source] })
      } else {
        out.push({ start: left - moving.size, pair: [[left, p.start]] })
      }
    }
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i]
    const right = sorted[i + 1]
    const room = right.start - spanEnd(left) - moving.size
    // Only when the box actually fits between them with space on both sides.
    if (room <= 0) continue
    const half = room / 2
    const start = spanEnd(left) + half
    out.push({
      start,
      pair: [
        [spanEnd(left), start],
        [start + moving.size, right.start],
      ],
    })
  }
  return out
}

/**
 * The spacing snap: nearest candidate position, or nothing.
 *
 * Rounded to a whole unit because the board writes integer coordinates, and a
 * half-unit target is one the card can never actually reach — it would sit
 * fractionally off its own guide forever.
 */
function bestSpacing(
  moving: Span,
  peers: Span[],
  range: number,
): { offset: number; pair: [number, number][] } | null {
  let best: { offset: number; pair: [number, number][] } | null = null
  for (const c of spacingCandidates(moving, peers)) {
    const offset = Math.round(c.start) - moving.start
    if (Math.abs(offset) < range && (!best || Math.abs(offset) < Math.abs(best.offset))) {
      best = { offset, pair: c.pair }
    }
  }
  return best
}

/**
 * How close a card has to be before a relationship to ANOTHER CARD outranks the
 * dot grid.
 *
 * THE GRID IS WHY THIS CONSTANT EXISTS, and the number was chosen after
 * watching the feature fail without it. A grid line is never further than half a
 * cell — twelve units here — so the old rule, which threw card lines and grid
 * lines into one contest decided purely on distance, meant a card edge only ever
 * won by being closer than twelve. Rendering six representative drags through
 * the real code, FOUR produced no guide at all: in one the nearest dot sat
 * exactly on the card's own centre line, beating a neighbour four units away by
 * a perfect zero. Lines that appear on a third of the drags you would want them
 * on do not read as a feature, they read as a glitch.
 *
 * So the grid is demoted rather than beaten. Inside this window, an edge, a
 * centre or an equal gap — all three of them deliberate relationships to
 * something the user can see — takes precedence outright. Outside it, the old
 * contest runs unchanged and the grid does what it has always done.
 *
 * Sixteen, not the alignment range of 120: this is a "you are clearly aiming at
 * that" window, not a "there is something over there" one. At 120 a card would
 * leap across a fifth of a page to touch anything at all.
 */
export const CARD_PRIORITY = 16

/**
 * The snap and the guides, for one drag.
 *
 * `others` must already exclude the moving box and anything that should not be
 * a target (CanvasView drops groups: a group is a region drawn AROUND cards, so
 * its edges are wherever it was sized to and are not a line to be flush with).
 *
 * Both axes are computed independently and that is deliberate — a card can lock
 * to a neighbour's left edge while sitting anywhere vertically. Locking both or
 * neither would make building a column a fight.
 */
export function guideSnap(
  moving: GuideBox,
  others: GuideBox[],
  opts: { grid: number; range: number },
): { dx: number; dy: number; guides: Guide[] } {
  const guides: Guide[] = []

  const axis = (which: 'x' | 'y'): number => {
    const horizontal = which === 'x'
    const span = (b: GuideBox): Span =>
      horizontal
        ? { start: b.x, size: b.width, crossStart: b.y, crossSize: b.height }
        : { start: b.y, size: b.height, crossStart: b.x, crossSize: b.width }

    const me = span(moving)
    const peers = others.map(span)

    const cardLines = peers.flatMap((p) => alignLines(p.start, p.size))

    const drawAlign = (line: number, peer: Span) => {
      const lo = Math.min(me.crossStart, peer.crossStart)
      const hi = Math.max(me.crossStart + me.crossSize, peer.crossStart + peer.crossSize)
      guides.push({ kind: 'align', axis: which, at: line, from: lo, to: hi })
    }

    /**
     * THE PRECEDENCE, which is the only interesting decision in this file.
     *
     * Two relationships to another card — "flush with that edge" and "the same
     * distance away as those" — compete on DISTANCE, because both are things
     * the user is deliberately reaching for and the nearer one is the better
     * guess at which. Alignment takes a tie: it is the older gesture and the
     * cheaper one to undo by nudging.
     *
     * Both of them outrank the dot grid outright inside CARD_PRIORITY. See that
     * constant for the measurements that forced it.
     */
    const near = bestLine(me.start, me.size, cardLines, CARD_PRIORITY)
    const spacing = bestSpacing(me, peers.filter((p) => inBand(me, p)), CARD_PRIORITY)

    if (near && Math.abs(near.offset) <= Math.abs(spacing?.offset ?? Infinity)) {
      drawAlign(near.line, peers[Math.floor(near.index / 3)])
      return near.offset
    }
    if (spacing) {
      // Drawn at the moving card's cross centre so the matched gaps read as one
      // row of equal ticks. Every peer here overlaps that band by construction,
      // so the ticks land beside the cards they are talking about.
      const at = me.crossStart + me.crossSize / 2
      for (const [from, to] of spacing.pair) {
        guides.push({ kind: 'gap', axis: which, at, from, to, size: Math.round(to - from) })
      }
      return spacing.offset
    }

    // Nothing deliberate within reach: the original contest, cards and grid
    // together, closest wins, ties resolved exactly as they were before guides
    // existed. In practice the grid takes this every time — a card line that
    // could have won it was already caught above.
    const best = bestLine(
      me.start,
      me.size,
      [...cardLines, ...gridLines(me.start, me.size, opts.grid)],
      opts.range,
    )
    if (!best) return 0
    // A guide is only worth drawing for a CARD line. A line through a dot
    // explains nothing the grid was not already showing, and drawing one on
    // every shift-drag would bury the useful case in noise.
    if (best.index < cardLines.length) drawAlign(best.line, peers[Math.floor(best.index / 3)])
    return best.offset
  }

  return { dx: axis('x'), dy: axis('y'), guides }
}
