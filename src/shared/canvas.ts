/**
 * JSON Canvas — the on-disk format for the Canvas view.
 *
 * This is jsoncanvas.org, the open spec Obsidian created and writes to its own
 * `.canvas` files. It is used here rather than an invented format for the same
 * reason the app reads Obsidian's `.obsidian/app.json` exclusions and its
 * `bookmarks.json`: the vault is a shared directory, and a file only this app
 * can open is a file the user does not really own.
 *
 * THE PRESERVATION RULE, which is the whole reason this module is careful.
 *
 * The spec has four node types (`text`, `file`, `link`, `group`) and this view
 * renders two of them. It also allows `color`, edge labels, and per-node fields
 * that future spec versions will add. A canvas authored in Obsidian and opened
 * here must come back out with every one of those intact.
 *
 * So `parse` does NOT map the file into a shape of our own and `serialize` does
 * NOT rebuild one. Parse validates and hands back the ACTUAL parsed object; the
 * view mutates `x`/`y` on the very node objects it was given; serialize
 * stringifies what it holds. Anything unrecognised is carried through
 * untouched because it was never taken apart. A reconstructing round-trip
 * would silently delete a user's groups and colours on the first drag.
 *
 * No DOM and no React, so `node --test` exercises this file directly.
 */

/** The four node types in the spec. Only `text` and `file` are rendered today. */
export type CanvasNodeType = 'text' | 'file' | 'link' | 'group'

/**
 * One node.
 *
 * The index signature is deliberate and is the type-level half of the
 * preservation rule: a canvas may legally carry keys this app has never heard
 * of, and the type has to permit them or the code that copies nodes around
 * would be tempted to drop them.
 */
export type CanvasNode = {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  /** `text` nodes: the markdown shown in the card. */
  text?: string
  /** `file` nodes: a vault-relative path. */
  file?: string
  /** `link` nodes: a URL. */
  url?: string
  /** `group` nodes: the group's name. */
  label?: string
  color?: string
  [key: string]: unknown
}

export type CanvasEdge = {
  id: string
  fromNode: string
  toNode: string
  fromSide?: 'top' | 'right' | 'bottom' | 'left'
  toSide?: 'top' | 'right' | 'bottom' | 'left'
  label?: string
  color?: string
  [key: string]: unknown
}

export type CanvasDoc = {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  [key: string]: unknown
}

/** A brand-new, empty board. */
export function emptyCanvas(): CanvasDoc {
  return { nodes: [], edges: [] }
}

/**
 * Ids are `crypto.randomUUID()` with the dashes stripped, which is the shape
 * Obsidian writes. Any unique string is legal per the spec; matching the
 * neighbour's convention costs nothing and keeps a diff of a file both apps
 * have touched readable.
 */
export function canvasId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Read a `.canvas` file.
 *
 * THROWS on anything it cannot vouch for, and that is a safety decision rather
 * than strictness for its own sake. Everywhere else in this app an unreadable
 * user-writable file degrades to a default — `ignoreFilters()` returns no
 * exclusions, `settings.ts` returns defaults — because there the cost of being
 * wrong is a missing preference. Here the view would render an empty board,
 * the first drag would save it, and the user's canvas would be gone. An empty
 * doc is indistinguishable from a wiped one once it is written back, so the
 * only safe failure is a loud one that also blocks saving.
 *
 * An EMPTY FILE is the one exception, and it is not a corrupt canvas: it is
 * what `save(path, '', 0)` leaves behind when a new canvas is created, so it
 * reads as the empty board it is.
 */
export function parseCanvas(text: string): CanvasDoc {
  if (text.trim() === '') return emptyCanvas()

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`Not a valid canvas file: ${(e as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Not a valid canvas file: the top level is not an object.')
  }

  const doc = raw as Record<string, unknown>
  // Both keys are optional in the spec — a canvas with only nodes omits
  // `edges` entirely — so absent is normalised to empty, but PRESENT AND WRONG
  // is refused. The difference matters: the first is a valid file, the second
  // means we are looking at something that is not a canvas.
  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) {
    throw new Error('Not a valid canvas file: `nodes` is not a list.')
  }
  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    throw new Error('Not a valid canvas file: `edges` is not a list.')
  }
  doc.nodes ??= []
  doc.edges ??= []

  // Geometry is what the view does arithmetic on, and NaN propagates silently
  // through a transform until the whole board vanishes with no error anywhere.
  // Checked here, once, at the boundary.
  for (const n of doc.nodes as CanvasNode[]) {
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isFinite(n?.[k])) {
        throw new Error(`Not a valid canvas file: node ${n?.id ?? '?'} has a bad ${k}.`)
      }
    }
  }

  return doc as CanvasDoc
}

/**
 * Write a `.canvas` file.
 *
 * Two spaces and a trailing newline: Obsidian writes this file too, and a
 * formatting-only diff every time the other app touches it is noise in the
 * user's git history.
 */
export function serializeCanvas(doc: CanvasDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** Default size for a new text card, in canvas units. Obsidian's own default. */
export const NEW_TEXT_SIZE = { width: 250, height: 60 }
/** Default size for a new file card. Obsidian's own default. */
export const NEW_FILE_SIZE = { width: 400, height: 400 }

/**
 * The house card size: US Letter at 72dpi, 8.5in x 11in.
 *
 * A card on this board is going to HOLD A FILE, so it is shaped like the page
 * that file prints to rather than like a sticky note. 72dpi is the reason the
 * numbers are these and not some other pair: it is the PostScript point, one
 * unit per point, so 8.5x11in is exactly 612x792 and the card is a page at 1:1
 * rather than a rectangle that merely has a page's proportions.
 *
 * Portrait, because that is how the documents these cards stand for are read.
 *
 * Kept separate from NEW_TEXT_SIZE rather than replacing it: that constant is
 * Obsidian's default and is what a board authored over there will carry, so it
 * stays the name for that idea. This one is a decision this app is making.
 */
export const PAGE_SIZE = { width: 612, height: 792 }

/**
 * The floor a card can be resized to.
 *
 * Not zero, and not one: a card dragged to nothing cannot be grabbed again to
 * drag it back, which is the same trap as a card buried under another. Wide
 * enough to still show a grip and a line of text.
 */
export const MIN_CARD_SIZE = { width: 120, height: 60 }

/**
 * THE NODES A GROUP IS HOLDING.
 *
 * Membership is decided by a node's CENTRE, not by whether the group encloses
 * it whole. Full containment is the stricter rule and the wrong one here: a
 * page half dragged out of a group is still a page you are moving within it
 * until you commit, and under enclosure it would fall out of the group the
 * instant one corner crossed the line, then be re-adopted on the way back. The
 * centre gives one unambiguous crossing point, which is what makes dragging a
 * page in or out of a group read as a decision rather than a wobble.
 *
 * Groups are never members of groups. JSON Canvas permits the nesting and this
 * deliberately does not model it: fitting nested groups correctly means fitting
 * them innermost-first, and a cycle of two groups each "inside" the other is
 * representable in the file. Excluding them keeps the fit a single pass with no
 * ordering to get wrong. A nested group is left exactly where the user put it.
 */
export function groupMembers(group: CanvasBox, nodes: CanvasNode[]): CanvasNode[] {
  return nodes.filter((n) => {
    if (n.type === 'group') return false
    const cx = n.x + n.width / 2
    const cy = n.y + n.height / 2
    return (
      cx >= group.x &&
      cx <= group.x + group.width &&
      cy >= group.y &&
      cy <= group.y + group.height
    )
  })
}

/**
 * Everything a drag on `target` must carry, target itself excluded.
 *
 * The selection when `target` is part of a multi-selection, plus whatever any
 * group in that set is holding — because a group that moved alone was a
 * rectangle you could slide off its own contents.
 *
 * PURE AND HERE rather than inline in the view, and that placement is the whole
 * lesson of the revision that added it: the first cut lived in CanvasView and
 * was "tested" by a regex asserting the lines existed. They did exist. It still
 * did not work, and a source-shaped test cannot tell you that. This one can be
 * run against a real board.
 */
export function dragSet(
  target: CanvasNode,
  selection: ReadonlySet<string>,
  nodes: CanvasNode[],
): CanvasNode[] {
  const inSelection = selection.has(target.id) && selection.size > 1
  const movers = new Set<CanvasNode>(
    inSelection ? nodes.filter((n) => selection.has(n.id)) : [target],
  )
  for (const n of [...movers]) {
    if (n.type === 'group') for (const m of groupMembers(n, nodes)) movers.add(m)
  }
  movers.delete(target)
  return [...movers]
}

/**
 * The box a group has to be to hold `members` with `pad` around them.
 *
 * `null` when it holds nothing, and that is the useful half of the contract:
 * an EMPTY GROUP IS LEFT ALONE. Fitting one would collapse it to a point, and a
 * group you have drawn but not filled yet is the normal way to lay out a
 * pipeline before the pages for it exist — a box that vanished the moment you
 * finished drawing it would make that impossible.
 *
 * Grows AND shrinks. A fit that only ever grew would leave a group carrying the
 * shape of a page that has since been dragged out of it, which is the same
 * untidiness the fit exists to remove, just slower to notice.
 *
 * `pad` is passed in rather than owned here for the reason `guides.ts` gives
 * about grid and range: CanvasView owns GROUP_PAD, it is the same measurement a
 * new group is built from and the same one the snap insets a group's interior
 * by, and a second copy of it here is how those three quietly stop agreeing.
 */
export function groupFit(members: CanvasBox[], pad: number): CanvasBox | null {
  if (members.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const m of members) {
    minX = Math.min(minX, m.x)
    minY = Math.min(minY, m.y)
    maxX = Math.max(maxX, m.x + m.width)
    maxY = Math.max(maxY, m.y + m.height)
  }
  // Rounded because the spec declares x/y/width/height integer, and a group is
  // the one node the user never types a size into — every value it ever gets
  // comes from arithmetic like this.
  return {
    x: Math.round(minX - pad),
    y: Math.round(minY - pad),
    width: Math.round(maxX - minX + pad * 2),
    height: Math.round(maxY - minY + pad * 2),
  }
}

/**
 * The drag payload a canvas accepts: one vault-relative note path.
 *
 * A CUSTOM TYPE RATHER THAN `text/plain`, and that is the whole point of naming
 * it. The board must accept a note dragged out of this app's own tree and
 * refuse a paragraph dragged out of a browser, a file dragged off the desktop,
 * or a selection dragged from the editor next door — all of which arrive as
 * `text/plain` and none of which are a vault path. `dragover` can then answer
 * honestly: the cursor shows a drop target only where dropping will work.
 *
 * Vendor-prefixed and lowercase because the drag-and-drop API lowercases every
 * type it is given, so a mixed-case constant would never match what comes back
 * out of `getData`.
 */
export const CANVAS_DROP_MIME = 'application/x-agent-workspace-note'

/**
 * The board every other board hangs from.
 *
 * Convention rather than configuration: the board called `Home.canvas` is the
 * root, and the pipelines it links to nest under it. Nothing to set up and
 * obvious from the vault alone, which is the point — the hierarchy has to be
 * legible to someone reading the folder without this app.
 *
 * It was `Main.canvas` until 2026-08-24, and the rename is the whole reason to
 * write this down. THREE OTHER PLACES ALREADY SAID HOME: the board sitting at
 * the vault root, the roadmap entry describing this feature, and the
 * `run-a-board` skill, which tells every agent on the machine to start at
 * `Home.canvas`. Only this constant said Main, so the app headed the user's
 * real index board "No Main.canvas yet" while an agent following the skill
 * opened it and found the pipeline. Two names for one convention is precisely
 * the second thing to keep in sync that a board-as-index exists to avoid, and
 * the one with a single dissenter is the one that moves.
 *
 * It also lines up with `Home.md`, which is already the note the vault hangs
 * from — `pickRoot` in main/vault.ts measures reachability from it, and
 * INDEX_NAMES elects it as a folder's hub. Same word for the same idea in both
 * halves of the vault.
 */
export const ROOT_BOARD = 'Home.canvas'

export type BoardRef = { path: string; name: string }
export type BoardRow = BoardRef & { depth: number; reachable: boolean }

/**
 * Arranges the boards into the tree the sidebar draws.
 *
 * THE HIERARCHY IS THE BOARDS THEMSELVES. A board is a child of another when
 * the parent holds a page pointing at it, so the tree is derived from what is
 * actually on the boards rather than from a folder layout that can disagree
 * with them. Link a pipeline into the main board and it appears nested; unlink
 * it and it stops being nested. There is no second place to keep in sync.
 *
 * `links` maps a board's path to the `.canvas` paths its pages point at.
 *
 * A board reached twice is listed ONCE, at the first place it is reached.
 * Boards legitimately share sub-pipelines, and drawing one under every parent
 * would turn a shared step into several entries that are really one file — you
 * would not know which to open, and editing "both" would edit the same board.
 *
 * `seen` is also the CYCLE GUARD. Two boards linking each other is an ordinary
 * thing to author by accident and would otherwise recurse until the stack gave
 * out, taking the sidebar and the app with it.
 *
 * Boards the root cannot reach are still returned, flagged `reachable: false`,
 * so the sidebar can show them under their own heading. Dropping them would
 * make a board invisible the moment it was unlinked — the file would still be
 * there and the app would deny it existed.
 */
export function boardTree(
  boards: BoardRef[],
  links: Record<string, string[]>,
  root: string = ROOT_BOARD,
): BoardRow[] {
  // Compared case-insensitively throughout: this runs on Windows, where
  // `home.canvas` and `Home.canvas` are the same file.
  const byPath = new Map(boards.map((b) => [b.path.toLowerCase(), b]))
  const wanted = root.toLowerCase()
  const rootBoard =
    byPath.get(wanted) ??
    // Also matched by NAME, so a root that lives in a folder rather than at the
    // vault root is still found.
    boards.find((b) => b.name.toLowerCase() === wanted)

  const rows: BoardRow[] = []
  const seen = new Set<string>()

  const walk = (board: BoardRef, depth: number) => {
    const key = board.path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ ...board, depth, reachable: true })
    for (const child of links[board.path] ?? []) {
      const found = byPath.get(child.toLowerCase())
      // A page may point at a board that has been deleted or renamed. Skipped
      // rather than invented, for the same reason a dangling edge is skipped.
      if (found) walk(found, depth + 1)
    }
  }

  if (rootBoard) walk(rootBoard, 0)
  for (const board of boards) {
    if (!seen.has(board.path.toLowerCase())) rows.push({ ...board, depth: 0, reachable: false })
  }
  return rows
}

/** Whether a vault path names a board. */
export function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith('.canvas')
}

/** The title a `file` node shows: the filename, extension dropped. */
export function fileNodeTitle(file: string): string {
  return file.split('/').pop()!.replace(/\.md$/i, '')
}

/**
 * Where the edge between two nodes attaches, when the file does not say.
 *
 * `fromSide`/`toSide` are optional in the spec, and Obsidian omits them for
 * edges it routed automatically. Rendering those as centre-to-centre lines
 * would run them through the middle of both cards, so the nearest-sides pair
 * is derived from the geometry instead. Exported for the test.
 */
export function edgeAnchor(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y

  // Whichever axis separates them more decides which pair of sides is used.
  // Comparing the raw deltas would pick left/right for two wide cards stacked
  // vertically, so each is measured against the gap that axis actually has.
  const horizontal = Math.abs(dx) * (a.height + b.height) >= Math.abs(dy) * (a.width + b.width)

  if (horizontal) {
    return dx >= 0
      ? { from: { x: a.x + a.width, y: ac.y }, to: { x: b.x, y: bc.y } }
      : { from: { x: a.x, y: ac.y }, to: { x: b.x + b.width, y: bc.y } }
  }
  return dy >= 0
    ? { from: { x: ac.x, y: a.y + a.height }, to: { x: bc.x, y: b.y } }
    : { from: { x: ac.x, y: a.y }, to: { x: bc.x, y: b.y + b.height } }
}

/* ── edge geometry ──────────────────────────────────────────────
   Lives here rather than in CanvasView because it is pure arithmetic over
   numbers, and this module is the one `node --test` imports directly. While it
   sat in the view the only thing any test could do was grep the source for the
   text of an expression, which passes whether or not the maths is right. */

export type CanvasPoint = { x: number; y: number }

/** A box's four side midpoints, in world units. */
const SIDE_POINT = {
  top: (n: CanvasBox) => ({ x: n.x + n.width / 2, y: n.y }),
  right: (n: CanvasBox) => ({ x: n.x + n.width, y: n.y + n.height / 2 }),
  bottom: (n: CanvasBox) => ({ x: n.x + n.width / 2, y: n.y + n.height }),
  left: (n: CanvasBox) => ({ x: n.x, y: n.y + n.height / 2 }),
} as const

export type CanvasBox = { x: number; y: number; width: number; height: number }

/** The side midpoint named by `side`, or `derived` when it names none. */
export function sidePoint(
  node: CanvasBox,
  side: unknown,
  derived: CanvasPoint,
): CanvasPoint {
  const point = typeof side === 'string' ? SIDE_POINT[side as keyof typeof SIDE_POINT] : undefined
  return point ? point(node) : derived
}

/**
 * Which side of a card an anchor sits on, as an outward unit vector.
 *
 * Derived from the geometry rather than read off `fromSide`/`toSide`, because
 * those are OPTIONAL — most edges omit them and let `edgeAnchor` derive the
 * nearest pair. Measuring which of the four edges the point actually lies on
 * covers both cases with one rule.
 */
export function outward(node: CanvasBox, p: CanvasPoint): CanvasPoint {
  const toLeft = Math.abs(p.x - node.x)
  const toRight = Math.abs(p.x - (node.x + node.width))
  const toTop = Math.abs(p.y - node.y)
  const toBottom = Math.abs(p.y - (node.y + node.height))
  const nearest = Math.min(toLeft, toRight, toTop, toBottom)
  if (nearest === toLeft) return { x: -1, y: 0 }
  if (nearest === toRight) return { x: 1, y: 0 }
  if (nearest === toTop) return { x: 0, y: -1 }
  return { x: 0, y: 1 }
}

/**
 * How far an edge reaches straight out of a card before it starts to turn.
 *
 * DIRECTION-AWARE, which the old `dist * 0.4` was not. The distance between two
 * anchors says nothing about how hard the curve has to work: two cards facing
 * each other across a gap need almost no lead-out, and two cards whose chosen
 * sides face AWAY from each other need a long one or the curve doubles back
 * through the card it just left. The old rule gave both the same handle and the
 * second case kinked.
 *
 * `align` is the cosine between this side's outward normal and the straight
 * line to the other anchor: +1 pointing right at it, -1 pointing directly away.
 * The reach shrinks as the sides face each other and grows as they turn away.
 *
 * The floor collapses with the gap rather than sitting at a constant, or two
 * cards nearly touching would get a 24-unit bulge out of an 8-unit gap.
 */
function reach(normal: CanvasPoint, p: CanvasPoint, other: CanvasPoint): number {
  const gap = Math.hypot(other.x - p.x, other.y - p.y)
  if (gap === 0) return 0
  const align = (normal.x * (other.x - p.x) + normal.y * (other.y - p.y)) / gap
  const floor = Math.min(24, gap * 0.6)
  return Math.min(Math.max(gap * (0.45 - 0.22 * align), floor), 200)
}

/**
 * Where the inner control point sits along the flat run, as a fraction of it.
 *
 * TWO THIRDS IS APPLE'S NUMBER, lifted off the shape this whole quintic is an
 * argument about. A continuous (`.continuous`, squircle) corner on iOS is not a
 * superellipse despite the folklore; it is three cubic Béziers per corner with
 * hand-fitted coefficients, reverse engineered from `UIBezierPath` and published
 * by PaintCode. Measuring inward from the corner vertex in units of the corner
 * radius, the first of those three segments runs
 *
 *     P0 = (1.52866471, 0)   P1 = (1.08849323, 0)   P2 = (0.86840689, 0)
 *
 * All three sit on the straight edge, y = 0. That is the SAME TRICK as this
 * file's: collinear P0, P1, P2 forces k = 0 where the curve meets the flat, so
 * the corner leaves the edge with no curvature step. Apple solved the identical
 * problem and reached for the identical device.
 *
 * Their spacing is what is borrowed here:
 *
 *     |P0 P1| / |P0 P2| = 0.44017148 / 0.66025782 = 0.66666...
 *
 * which is 2/3 to within 1 part in a million — inside the quantisation noise
 * already visible in Apple's own figures, whose mirror pairs disagree in the
 * seventh decimal (1.52866471 against 1.52866483). The third segment of the same
 * corner gives 0.44017184 / 0.66025782, the same two thirds again.
 *
 * MEASURED HERE BEFORE IT WAS ADOPTED, because a constant that is right for a
 * 90-degree corner is not automatically right for an arrow between two boxes.
 * Sweeping the split from 0.40 to 0.90 over this file's own test cases and
 * integrating total curvature variation — the standard fairness measure, and the
 * thing an eye reads as "expensive" — the minimum for the diagonal case falls at
 * s = 0.635, where the variation is 9.14237. Two thirds scores 9.14875, four
 * tenths of a percent off an optimum found by brute force. The old 0.45 scored
 * 9.505, and on the long diagonal case its peak curvature was 103.7 against 65.7
 * for two thirds, over half as much again.
 *
 * So this is not cargo cult. Apple's ratio and the numerically fair ratio are
 * the same ratio, and the one with a source is the one worth writing down.
 */
export const FLAT_SPLIT = 2 / 3

/**
 * The six control points of the quintic an edge is drawn as.
 *
 * WHY A QUINTIC AND NOT THE CUBIC THIS REPLACED — the reason is curvature
 * continuity, and it is the same argument Apple makes about a rounded corner.
 *
 * A rectangle rounded with a circular arc is G1: position and tangent match
 * where the straight edge meets the arc, so there is no visible corner. But
 * CURVATURE jumps from 0 to 1/r at that point, instantaneously. The eye reads
 * that discontinuity as a pinch even though nothing is bent. A squircle — a
 * superellipse, which is what an iPhone's corner actually is — ramps curvature
 * up from zero instead, so there is no moment where it snaps. Same tangent,
 * different second derivative, and the second derivative is the part you feel.
 *
 * The old cubic here had exactly the circular-arc problem. Its control points
 * were `anchor + normal * pull`, which sets the TANGENT perpendicular to the
 * card but leaves curvature at the anchor free — and generally non-zero. So
 * every edge left its card already bending, and met the arrowhead (a straight
 * object) with a curvature step. On a board of connected pages that reads as
 * the lines being slightly wrong everywhere without it being obvious why.
 *
 * A cubic CANNOT fix this. Curvature at t=0 of a degree-n Bézier is
 *
 *     k(0) = (n-1)/n * |(P1-P0) x (P2-P1)| / |P1-P0|^3
 *
 * so k(0) = 0 requires P0, P1, P2 to be collinear. On a cubic that spends three
 * of the four control points on one end and leaves nothing to shape the middle
 * with — the curve degenerates to very nearly a straight line. Degree five is
 * the first degree with enough freedom: three points at each end, collinear
 * along that end's outward normal, which pins BOTH the tangent (perpendicular
 * to the side) and the curvature (zero) at each anchor, and still leaves the
 * two interior spans to carry the turn.
 *
 * So every edge now leaves its card perfectly straight, bends through the
 * middle, and straightens again before it reaches the arrowhead. Curvature
 * starts at zero, peaks once, returns to zero.
 *
 * FLAT_SPLIT splits the collinear run so P1 sits inside P2 rather than on top of
 * it. Any value in (0,1) gives zero curvature — collinearity is what matters,
 * not the spacing — so the value is free, and it was 0.45 by taste until the
 * constant below replaced it with Apple's.
 *
 * Exported so the test can assert the collinearity directly, as an exact cross
 * product on the control points, rather than differentiating the curve
 * numerically and comparing against a tolerance.
 */
export function edgeControlPoints(
  a: CanvasBox,
  from: CanvasPoint,
  b: CanvasBox,
  to: CanvasPoint,
): CanvasPoint[] {
  const da = outward(a, from)
  const db = outward(b, to)
  const ra = reach(da, from, to)
  const rb = reach(db, to, from)
  return [
    from,
    { x: from.x + da.x * ra * FLAT_SPLIT, y: from.y + da.y * ra * FLAT_SPLIT },
    { x: from.x + da.x * ra, y: from.y + da.y * ra },
    { x: to.x + db.x * rb, y: to.y + db.y * rb },
    { x: to.x + db.x * rb * FLAT_SPLIT, y: to.y + db.y * rb * FLAT_SPLIT },
    to,
  ]
}

/**
 * A quintic Bézier and its first derivative at `t`.
 *
 * The derivative is the hodograph: a degree-4 Bézier over the forward
 * differences of the control points, scaled by the degree. Written out rather
 * than looped with binomials because six terms is shorter than the machinery
 * that would generate them.
 */
function quinticAt(P: CanvasPoint[], t: number): { p: CanvasPoint; d: CanvasPoint } {
  const u = 1 - t
  const b = [
    u * u * u * u * u,
    5 * u * u * u * u * t,
    10 * u * u * u * t * t,
    10 * u * u * t * t * t,
    5 * u * t * t * t * t,
    t * t * t * t * t,
  ]
  const h = [u * u * u * u, 4 * u * u * u * t, 6 * u * u * t * t, 4 * u * t * t * t, t * t * t * t]
  let px = 0
  let py = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < 6; i++) {
    px += b[i] * P[i].x
    py += b[i] * P[i].y
  }
  for (let i = 0; i < 5; i++) {
    dx += h[i] * 5 * (P[i + 1].x - P[i].x)
    dy += h[i] * 5 * (P[i + 1].y - P[i].y)
  }
  return { p: { x: px, y: py }, d: { x: dx, y: dy } }
}

/**
 * How many cubic pieces the quintic is emitted as.
 *
 * SVG has no quintic command — `C` is the highest degree a path can state — so
 * the curve is split into spans and each span is written as the cubic that
 * matches its position AND tangent at both ends (a Hermite segment). That is an
 * approximation, and the honest numbers are these: the error falls off as the
 * fourth power of the span count, and `canvas-edge-curvature.test.mjs` measures
 * it directly rather than taking the asymptotics on trust.
 *
 * Measured worst case across every case in canvas-edge-curvature.test.mjs, as a
 * fraction of the edge's own length: 1.1e-3 at six spans, 3.8e-4 at eight,
 * 7.8e-5 at twelve, 2.5e-5 at sixteen. The worst case is always the U-turn,
 * where both anchors sit on sides facing away from the other card.
 *
 * SIXTEEN. This was six between 2026-08-21 and 2026-08-24, on an argument that
 * did not survive being re-measured. The comment standing here quoted "2.4e-4 at
 * six spans, 8.4e-5 at twelve, 2.7e-5 at sixteen" and called the U-turn the
 * worst case throughout. The twelve and sixteen figures ARE the U-turn. The six
 * figure is not: it is the facing-across-a-gap case, and the U-turn at six spans
 * is 1.1e-3, nearly five times worse. Mixing the best case at one span count
 * with the worst at the others is what made six look free, and every conclusion
 * drawn from it — including "there is no zoom at which the difference is on
 * screen" — was reasoning about a number that belonged to a different edge.
 *
 * The cost of being wrong in this direction is nothing: an edge is a path string
 * built a few dozen times per board, not the 653-edge force graph, which does
 * its own drawing and never calls this. Sixteen is the smallest count in the
 * table above that meets the test's 5e-5 bound, and that bound is itself derived
 * from K_MAX rather than tuned until it passed.
 *
 * The G2 property bought above is a property of the ENDPOINTS, where the
 * Hermite segments match the quintic exactly. The flat ends are therefore exact
 * rather than approximated, and no span count could erode them.
 */
const EDGE_SPANS = 16

/**
 * The `d` of the path an edge is drawn as, plus the point its label sits on.
 *
 * `origin` shifts every coordinate, because the SVG layer this is drawn into is
 * a fixed box centred on the world origin and world coordinates are routinely
 * negative.
 */
export function edgeCurve(
  a: CanvasBox,
  from: CanvasPoint,
  b: CanvasBox,
  to: CanvasPoint,
  origin: number,
): { d: string; mid: CanvasPoint } {
  const P = edgeControlPoints(a, from, b, to)
  const step = 1 / EDGE_SPANS
  let start = quinticAt(P, 0)
  let d = `M ${start.p.x + origin} ${start.p.y + origin}`
  for (let i = 1; i <= EDGE_SPANS; i++) {
    const end = quinticAt(P, i * step)
    const c1 = {
      x: start.p.x + (start.d.x * step) / 3,
      y: start.p.y + (start.d.y * step) / 3,
    }
    const c2 = { x: end.p.x - (end.d.x * step) / 3, y: end.p.y - (end.d.y * step) / 3 }
    d +=
      ` C ${c1.x + origin} ${c1.y + origin}, ${c2.x + origin} ${c2.y + origin},` +
      ` ${end.p.x + origin} ${end.p.y + origin}`
    start = end
  }
  // The label rides the curve at t=0.5. The straight midpoint of the two
  // anchors is not on a curved line, so a label placed there floats off the
  // edge it belongs to.
  const mid = quinticAt(P, 0.5).p
  return { d, mid: { x: mid.x + origin, y: mid.y + origin } }
}
