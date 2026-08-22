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
 * Convention rather than configuration: the board called `Main.canvas` is the
 * root, and the pipelines it links to nest under it. Nothing to set up and
 * obvious from the vault alone, which is the point — the hierarchy has to be
 * legible to someone reading the folder without this app.
 */
export const ROOT_BOARD = 'Main.canvas'

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
  // `main.canvas` and `Main.canvas` are the same file.
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
