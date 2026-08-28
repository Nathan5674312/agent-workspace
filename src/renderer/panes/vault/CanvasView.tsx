import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FileText, Frame, Link2 } from 'lucide-react'
import {
  parseCanvas,
  serializeCanvas,
  emptyCanvas,
  fileNodeTitle,
  edgeAnchor,
  edgeCurve,
  sidePoint,
  canvasId,
  CANVAS_DROP_MIME,
  boardTree,
  isCanvasPath,
  ROOT_BOARD,
  type BoardRow,
  PAGE_SIZE,
  MIN_CARD_SIZE,
  groupMembers,
  groupFit,
  type CanvasDoc,
  type CanvasNode,
  type CanvasEdge,
} from '../../../shared/canvas.js'
import { guideSnap, guideLine, type Guide, type GuideBox } from '../../../shared/guides.js'
import type { VaultTreeNode } from '../../../shared/ipc.js'
import { NameDialog } from './NameDialog.js'
import './canvas.css'

/**
 * Canvas — a spatial board of notes and text, stored as JSON Canvas.
 *
 * WHY DOM AND NOT A <canvas> ELEMENT, given GraphView next door is a canvas.
 *
 * GraphView earns its canvas: 280 nodes and 653 edges repainted at 60fps, where
 * 280 DOM nodes with live transforms would not hold the frame budget. A board
 * holds tens of cards, and every single thing this view needs is something the
 * canvas API makes hard and the DOM gives away: text that wraps, a card that
 * ellipsises, a focusable control, hit-testing, and text selection. Rendering
 * wrapped markdown into a 2D context means writing a line-breaker.
 *
 * So the whole world is one `<div>` under a single CSS transform, and pan and
 * zoom are that transform. Cards are absolutely positioned in world units and
 * never re-laid-out — the browser composites the transform on the GPU.
 *
 * THE PRESERVATION RULE. `doc` is the object `parseCanvas` returned, not a copy
 * and not a projection. Dragging mutates `x`/`y` on the very node object that
 * came out of the file, and saving stringifies the same object. That is what
 * lets a canvas authored in Obsidian keep its groups, colours, edge labels and
 * any field a later spec adds — none of it is ever taken apart. See
 * shared/canvas.ts.
 */

/** Zoom limits. Hard clamps, not the rubberband GraphView uses — a board has
 *  no momentum yet, so there is no gesture to decelerate into a boundary. */
const K_MIN = 0.1
const K_MAX = 3
/** Padding around the content when framing a board on open. */
const FIT_PAD = 64

/**
 * The breathing room a new group leaves around the pages it is meant to hold.
 * Matches the gap `Uniform size` leaves between two pages, so a pair dropped
 * into a fresh group sits centred rather than pressed against one wall.
 */
const GROUP_PAD = 48

/**
 * A group's INTERIOR: the region a page inside it is meant to occupy.
 *
 * This is the box a group contributes to the snap, and it is emphatically NOT
 * the group itself. The old rule dropped groups from the contest entirely, on
 * reasoning that was half right — a group's OUTER edge is wherever someone
 * dragged the handle to, and a page sitting flush against it would be touching
 * the outline, which is not a relationship anyone wants. But that left a group
 * offering nothing at all, so a page dropped into one landed wherever the
 * pointer let go and the board read as pages floating loose inside a rectangle.
 *
 * Inset by the same GROUP_PAD a new group is built from, the edges become the
 * lines pages ARE meant to sit on, and the centre line becomes "centred in this
 * group" — which is the thing a phase of a pipeline usually wants.
 */
const groupInterior = (g: { x: number; y: number; width: number; height: number }): GuideBox => ({
  x: g.x + GROUP_PAD,
  y: g.y + GROUP_PAD,
  // A group narrower than its own padding is degenerate rather than impossible;
  // clamping keeps its centre line meaningful instead of inverting the box.
  width: Math.max(0, g.width - GROUP_PAD * 2),
  height: Math.max(0, g.height - GROUP_PAD * 2),
})

/**
 * A link card's height. One line of URL plus the padding around it — a link is
 * not a document and giving it a page's height leaves an acre of empty card
 * under a single line of text.
 */
const LINK_HEIGHT = 72

/**
 * How far a duplicate lands from its original, in world units.
 *
 * Non-zero so an Alt+press that never moves still produces a visible second
 * card rather than one hidden exactly behind the first, which is
 * indistinguishable from the gesture having done nothing.
 */
const DUPLICATE_OFFSET = 24

/**
 * Half-size of the edge layer, in canvas units.
 *
 * The edges were first drawn in a `width="0" height="0"` SVG with
 * `overflow: visible`, on the theory that the lines could then live in raw
 * world coordinates with no viewBox to maintain. Chromium does not paint that:
 * a zero-extent outermost `<svg>` has a degenerate viewport and its children
 * never render, so the board reported "2 connections" and drew none.
 *
 * A fixed layer sized in CSS is the fix. Coordinates are offset by this so
 * negative world positions land inside it — JSON Canvas routinely has negative
 * x/y, since Obsidian centres a new board on the origin.
 *
 * ±5000 rather than something enormous, and that ceiling matters: a layer
 * bigger than Chromium's max texture size is never rasterised, so a first
 * attempt at ±20000 drew nothing — the same symptom as the zero-sized version,
 * reached from the opposite direction. `.canvas-world` also drops
 * `will-change: transform` for the same reason; it was promoting the parent to
 * a layer sized to this child. Boards beyond ±5000 units will clip their edges;
 * raise this and the CSS box together if that ever shows up.
 */
const EDGE_ORIGIN = 5000

/**
 * How many steps back an undo can go.
 *
 * Fifteen, at Nathan's ask. Each entry is a whole serialized board, so the
 * depth is what this costs in memory — and past a dozen steps you are no longer
 * undoing, you are looking for a state you remember, which is what the file's
 * own history is for.
 *
 * Every board change is in reach of it: a drag, a resize, adding or deleting a
 * page, duplicating, pasting, recolouring, locking, connecting, retexting, the
 * uniform-size sweep and bring-to-front all write through `persist`, which is
 * where the snapshot is taken. The one thing outside it is editing a FILE
 * page's text, because that writes to the note rather than to the board — see
 * commitFile.
 */
const UNDO_LIMIT = 15

/**
 * How close, in world units, Shift reaches to find something to line up with.
 *
 * Constant rather than a fraction of the zoom: a snap that got greedier as you
 * zoomed out would grab pages you were not aiming at from across the board.
 * Roughly a fifth of a page, so it catches a deliberate near-miss and ignores a
 * page that is simply somewhere else.
 */
const SNAP_RANGE = 120

/**
 * The dot grid's spacing, in world units.
 *
 * ONE definition, published to CSS as `--canvas-grid` by applyView(), because
 * the dots and the snap have to agree exactly. They did not at first: the dots
 * were a number in the stylesheet and Shift only aligned pages to each other,
 * so lining a page up with a neighbour that was itself off-grid left both of
 * them sitting between the dots — visibly wrong, and Nathan reported it as
 * Shift "breaking".
 */
const GRID = 24

/* `alignLines`, `gridLines` and the snap itself moved to `shared/guides.ts`.
   They are unchanged — same candidate lines, same tie-breaking, same range —
   but they now also report WHICH line was matched, which is what lets the view
   draw a guide for it. GRID and SNAP_RANGE stay here because this file owns
   them: GRID is published to CSS above so the dots and the snap cannot
   disagree, and a second copy of that number is exactly how they would. */

/**
 * Whether an edge end draws an arrowhead, per JSON Canvas 1.0.
 *
 * THE DEFAULTS ARE THE WHOLE POINT, and they are asymmetric: `toEnd` defaults
 * to `'arrow'` and `fromEnd` to `'none'`. Obsidian omits both for an ordinary
 * directed edge, so treating an absent `toEnd` as "no arrow" — the obvious
 * reading — silently strips the arrowhead from every edge anyone else authored.
 * That was this view's behaviour until now.
 *
 * `unknown` in, because the shared CanvasEdge type declares neither field. They
 * arrive through its index signature and survive a round trip regardless; this
 * only decides what gets drawn. Anything that is neither 'arrow' nor absent is
 * treated as no arrow rather than guessed at.
 */
const drawsArrow = (end: unknown, fallback: 'arrow' | 'none'): boolean =>
  (end === undefined ? fallback : end) === 'arrow'

/**
 * Where one end of an edge attaches: the side the FILE names, or the derived
 * fallback when it names none.
 *
 * `edgeAnchor()` picks the nearest pair from the geometry, which is right for
 * an edge Obsidian routed automatically and wrong for one the user routed by
 * hand. Both cases exist in the same file, so the choice has to be per END
 * rather than per edge — an edge may legally state `fromSide` and omit
 * `toSide`, and deriving both because one was missing would move an anchor the
 * user placed.
 *
 * `unknown` in, because nothing validates these on the way through
 * `parseCanvas`. A side that is not one of the four falls back rather than
 * throwing: a board that is slightly wrong should still draw.
 *
 * The geometry itself lives in `shared/canvas.ts` — see `sidePoint`, `outward`
 * and `edgeCurve` there, and the note at the top of that section on why.
 */
// (the geometry itself is `sidePoint` in shared/canvas.ts, called directly)

/**
 * A JSON Canvas `color` as a CSS value, or null when there is nothing to paint.
 *
 * The spec allows two forms and they resolve differently. A PRESET is `"1"` to
 * `"6"`, which is an index into a palette the reading app chooses — so it
 * resolves to a variable, and the six values live in canvas.css where the rest
 * of this app's colour decisions live. A HEX string is the user naming an exact
 * colour, so it passes through as itself; substituting a palette entry there
 * would be overriding a choice they made explicitly.
 *
 * Anything else returns null and the element keeps its default. Nothing
 * validates this field on the way through `parseCanvas`, and a board carrying
 * junk in one `color` should still draw.
 */
const canvasColorValue = (color: unknown): string | null => {
  if (typeof color !== 'string') return null
  if (/^[1-6]$/.test(color)) return `var(--canvas-color-${color})`
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color
  return null
}

/**
 * Push a node or edge colour onto an element as a custom property.
 *
 * `style.setProperty` rather than a `style` prop because
 * review-s2-vault-pane.test.mjs forbids inline style objects in this pane, and
 * a hex from the file cannot become a stylesheet rule — it is per-element data,
 * which is the case `appearance.ts` already handles this way.
 *
 * REMOVED, not set to empty, when there is no colour. An empty custom property
 * still counts as set, so `var(--canvas-color, fallback)` would resolve to
 * nothing instead of the fallback and the element would lose its default
 * border entirely.
 */
const applyColor = (el: HTMLElement | SVGElement | null, color: unknown): void => {
  if (!el) return
  const value = canvasColorValue(color)
  if (value === null) el.style.removeProperty('--canvas-color')
  else el.style.setProperty('--canvas-color', value)
}

export interface CanvasViewProps {
  /** Vault-relative `.canvas` path, or null when no board is open. */
  path: string | null
  /** Open a note in the editor. File cards are the only thing that calls it. */
  onOpenNote: (path: string) => void
}

export function CanvasView({ path, onOpenNote }: CanvasViewProps) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Bumped to force a repaint after a mutation that React cannot see, because
   *  the drag writes THROUGH `doc` rather than replacing it. Replacing it would
   *  mean copying nodes, which is exactly what the preservation rule forbids. */
  const [tick, setTick] = useState(0)
  const repaint = useCallback(() => setTick((t) => t + 1), [])

  /** Connect mode: a press picks edge endpoints instead of dragging a card. */
  const [connect, setConnect] = useState(false)
  /** The first endpoint picked, while the second is still being chosen. */
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  /** The text card currently open for editing, by id. */
  const [editing, setEditing] = useState<string | null>(null)
  /**
   * The open editor's textarea, so a press elsewhere can read what was typed.
   *
   * The control is UNCONTROLLED — it holds its own value via `defaultValue`, so
   * React state does not have the text and the element is the only place it
   * exists until it is committed.
   */
  const editRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * The open context menu: where it was summoned, in BOTH coordinate systems.
   *
   * Screen coords position the menu, which lives outside the world transform so
   * it does not scale with the board. World coords are where a Paste lands, so
   * a pasted page appears where you right-clicked rather than at some remembered
   * point on a board you have since panned away from.
   */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    wx: number
    wy: number
    /** The page right-clicked, or null for the board itself. */
    id: string | null
    /** The arrow right-clicked, if the menu was opened on one. */
    edgeId?: string
  } | null>(null)
  /**
   * The copied page, as SERIALIZED JSON rather than a live node.
   *
   * A reference would keep pointing at the original, so editing or deleting it
   * after a copy would change or empty the clipboard. Text is a snapshot, and
   * it carries every field including ones this app does not know about.
   */
  const clipboard = useRef<string | null>(null)

  /**
   * Escape leaves connect mode.
   *
   * Connect mode makes a press pick an endpoint instead of starting a drag, so
   * while it is on NO card can be moved — `onNodeDown` returns before it ever
   * sets `drag.current`. Until now the only way out was the Connect button, and
   * a user who did not remember pressing it reads the board as frozen rather
   * than as moded. The crosshair cursor says something changed but not what.
   *
   * Escape is what every other mode in this pane already answers to — the card
   * textarea above discards on it, and the dialogs do too — so this is the
   * pane's existing convention rather than a new key to learn.
   *
   * On `window` because the surface is not focusable: there is nothing to give
   * keyboard focus to, so a handler on the element would never fire. Bound only
   * while the mode is on, so this listener does not exist for the whole session
   * and cannot swallow an Escape that belongs to something else.
   */
  useEffect(() => {
    if (!connect) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Not stopped: leaving a mode is not a reason to deny the same Escape to
      // whatever else is listening, and the textarea's own handler already
      // stops the ones that belong to an open editor.
      setConnect(false)
      setLinkFrom(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connect])
  /**
   * The selected cards, by id. PURE UI — nothing here is ever written to the
   * file. JSON Canvas has no concept of selection, and inventing a key for it
   * would put this app's transient state into a document Obsidian also writes.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  /**
   * The selected ARROW, if any. Also pure UI, never written to the file.
   *
   * Its own state rather than a member of `selected`, and not because ids might
   * collide. An arrow and a card are not alternatives in a list — Delete has to
   * mean one specific thing, and a single set holding both kinds would leave
   * "delete the selection" ambiguous the moment a board had one of each. Only
   * one of the two can be selected at a time, which each setter enforces by
   * clearing the other.
   *
   * WHY THIS EXISTS AT ALL: `removeEdge` and its "Delete arrow" menu item have
   * been here for a while, reachable only by right-clicking a two-pixel line.
   * Nathan asked how to delete an arrow, which is the answer to whether that is
   * discoverable. Clicking a thing and pressing Delete is what everyone already
   * tries first; the menu stays for the people who look there.
   */
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)

  /**
   * Whether a middle-button pan is in flight, purely so the cursor can say so.
   *
   * State, unlike the pan offsets themselves, which live in a ref and are
   * written straight to the DOM. This one has to reach the stylesheet, and it
   * changes twice per gesture rather than once per frame.
   */
  const [panning, setPanning] = useState(false)

  /**
   * The save path's own state, in refs, because a save is asynchronous and
   * React state cannot be read back by a closure created in an earlier render.
   *
   * `mtimeRef` is the lost-update token for the board currently open. It has to
   * be a ref: two saves queued from the same render both read the same
   * closure-captured `mtime`, so the second one expects a value the first one
   * has already replaced and the write is refused as a conflict the user never
   * caused.
   *
   * `saveChain` serialises writes so two can never be in flight against one
   * file. `pathRef` lets a queued save tell whether the board it belongs to is
   * still the open one.
   */
  const mtimeRef = useRef(0)
  const pathRef = useRef<string | null>(path)
  /**
   * Undo state, in refs for the same reason as the save state: a snapshot is
   * taken inside `persist`, which a closure from an earlier render would read
   * stale.
   *
   * `baseline` is the board as of the last load or write. `undoStack` holds the
   * states before that, oldest first. Whole serialized documents rather than a
   * command log: a board is a few kilobytes of JSON, the mutations here are
   * varied (move, add, duplicate, recolour, retext, connect, delete), and a
   * per-operation inverse for each is a great deal of code to get subtly wrong
   * for something the file itself already represents exactly.
   */
  const baseline = useRef('')
  const undoStack = useRef<string[]>([])

  /**
   * The CONTENTS of every file card on the board, by vault-relative path.
   *
   * A file card used to render its filename and nothing else, so a board of
   * notes was a board of labels — the thing the card stands for was never on
   * screen. This holds the real text so the card can show it.
   *
   * Keyed by PATH rather than by node id: two cards may point at one note, and
   * they must show the same text and the same mtime or a save through one would
   * be refused as a conflict caused by the other.
   *
   * `mtime` travels with the text because it is the lost-update token this
   * file's own saves have to pass back — the same guard the editor uses.
   */
  const [files, setFiles] = useState<Record<string, { text: string; mtime: number; error?: string }>>(
    {},
  )
  /**
   * Paths already asked for, so a re-render does not re-read the same note.
   *
   * A ref rather than derived from `files`, because a read is in flight for a
   * while before its result lands and the effect runs again in that window.
   */
  const requested = useRef(new Set<string>())
  const saveChain = useRef<Promise<void>>(Promise.resolve())

  const wrapRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  /** Card id -> its element, so geometry can be written without a re-render. */
  const nodeEls = useRef(new Map<string, HTMLDivElement>())

  /**
   * The view transform lives in a REF, not in state, and geometry is written
   * to the DOM rather than through a `style` prop.
   *
   * Two reasons, and they agree. review-s2-vault-pane.test.mjs forbids inline
   * style objects in this pane, so that presentation stays in the stylesheet —
   * and pan/zoom is not presentation, it is per-frame data, which is exactly
   * the case `appearance.ts` already handles with `style.setProperty`.
   *
   * The performance argument lands the same way. A pan emits a pointer event
   * per frame; through state that is a full React render of every card, sixty
   * times a second, to change one transform. Written straight to the element it
   * is one composited property and React never runs.
   */
  const view = useRef({ tx: 0, ty: 0, k: 1 })
  /** Mirrors `view.k` for the readout only. Wheel events are not per-frame. */
  const [zoom, setZoom] = useState(1)

  const applyView = useCallback(() => {
    const w = worldRef.current
    if (!w) return
    const { tx, ty, k } = view.current
    w.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`
    /**
     * The zoom, published to CSS so a page's title can cancel it out.
     *
     * Everything in the world is inside one `scale(k)`, so a title sized in
     * world units shrinks with the board and is unreadable at the zoom you
     * actually survey a board from. Dividing by this variable in the
     * stylesheet holds the title at a constant SCREEN size instead, so you can
     * tell what a page is without zooming into it.
     *
     * A variable rather than a second transform on the title: a counter-scale
     * transform would need a matching origin and would fight the card's own
     * layout. This changes one number and the browser does the rest.
     */
    /**
     * Written on the SURFACE, not the world, because the surface is the element
     * that is not transformed — the dot grid is painted there and has to undo
     * the pan and zoom itself. The world is a child, so anything inside it
     * still inherits these; the title's counter-scale reads `--canvas-k` from
     * here.
     */
    const s = wrapRef.current
    if (s) {
      s.style.setProperty('--canvas-k', String(k))
      s.style.setProperty('--canvas-tx', String(tx))
      s.style.setProperty('--canvas-ty', String(ty))
      // The dots are drawn from the same constant Shift snaps to, so the two
      // cannot drift apart.
      s.style.setProperty('--canvas-grid', String(GRID))
    }
  }, [])

  const applyNode = (n: CanvasNode) => {
    const el = nodeEls.current.get(n.id)
    if (!el) return
    el.style.left = `${n.x}px`
    el.style.top = `${n.y}px`
    el.style.width = `${n.width}px`
    el.style.height = `${n.height}px`
    // Here rather than in the JSX for the same reason as the geometry: this
    // runs for every node after every render, so a colour cannot be missed by
    // whichever code path caused the re-render.
    applyColor(el, n.color)
  }

  /**
   * EVERY GROUP HUGS WHAT IT HOLDS, after a gesture that could have changed it.
   *
   * Called on release rather than per frame. A group re-fitting sixty times a
   * second while you drag would make the box breathe under the pointer, and the
   * only moment the answer matters is the one where you let go.
   *
   * `skip` is the load-bearing argument. A group the user just dragged or
   * resized THEMSELVES must be left exactly where they put it: fitting it would
   * pull it straight back onto its contents, and the box would read as refusing
   * to move. So direct manipulation of a group wins, and the fit only ever
   * answers for what happened to the pages.
   *
   * Mutates in place and reports whether anything moved, so the caller can
   * decide about the write — this runs on gestures that may not have changed a
   * group at all, and persisting regardless would take a backup copy of the
   * file for a drag that shifted one page inside a box it already fitted.
   */
  const fitGroups = (d: CanvasDoc, skip: ReadonlySet<CanvasNode>): boolean => {
    let changed = false
    for (const g of d.nodes) {
      if (g.type !== 'group' || skip.has(g)) continue
      const box = groupFit(groupMembers(g, d.nodes), GROUP_PAD)
      if (!box) continue
      if (box.x === g.x && box.y === g.y && box.width === g.width && box.height === g.height) {
        continue
      }
      g.x = box.x
      g.y = box.y
      g.width = box.width
      g.height = box.height
      applyNode(g)
      changed = true
    }
    return changed
  }

  /**
   * Positions every card after each render, with no dependency array on
   * purpose: it has to cover the load, a drag's `repaint()`, and any future
   * cause of a re-render alike. Tens of cards times four writes is nothing, and
   * a dependency list here would be a list of ways to forget.
   */
  /**
   * The board this view has already framed.
   *
   * Framing CANNOT happen in the load effect, which is where it started and
   * where it silently did nothing. At that moment `doc` is still null, so the
   * component has rendered the "Loading canvas…" branch and `wrapRef` is null —
   * `fit()` took its no-surface early return every single time and every board
   * opened at 1:1 regardless of where its cards were. It has to run after the
   * surface exists, which is here.
   */
  const framed = useRef<CanvasDoc | null>(null)

  useLayoutEffect(() => {
    if (!doc) return
    if (framed.current !== doc) {
      framed.current = doc
      fit(doc)
    }
    for (const n of doc.nodes) applyNode(n)
    applyView()
  })

  // ── load ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    /**
     * TEAR DOWN EVERYTHING BELONGING TO THE OLD BOARD FIRST, unconditionally.
     *
     * This view is not remounted when you pick a different board — only `path`
     * changes — so state held here belongs to the previous file until it is
     * cleared, and the read below is async. Clearing inside one arm of the
     * branch is too late: the common case, switching from one real board to
     * another, does not take that arm at all.
     *
     * What that window cost while it existed: the old board rendered under the
     * new board's name, and a drag in it called `persist(doc)` — sending the
     * OLD board's content to the NEW board's path, held off only by the mtime
     * guard, which two files produced by a checkout or a sync client can
     * easily share. And the error page's guard is `error && !doc`, so a board
     * that failed to parse was not reported at all; the previous board was
     * shown as if it were the broken one.
     *
     * A different board is also a different set of ids, so a selection or an
     * open editor carried across either matches nothing or, worse, collides
     * with an id on the new board.
     */
    pathRef.current = path
    setDoc(null)
    mtimeRef.current = 0
    setEditing(null)
    setSelected(new Set())
    // An edge id is only meaningful inside the board that holds it. Carried
    // across a board switch it would either match nothing or, worse, collide
    // with an unrelated edge and put a selection ring on a line the user never
    // touched — and Delete would then take that one.
    setSelectedEdge(null)
    // A pending endpoint is the sharpest case: picked on the old board, it
    // would pair with a click on the new one and write an edge whose source
    // does not exist in the file it lands in. Connect MODE is left alone —
    // that is a tool the user turned on, not state belonging to a file.
    setLinkFrom(null)
    // History belongs to a FILE. Carried across, a Ctrl+Z on the new board
    // would restore a snapshot of the old one and save it over the new path —
    // the same cross-board write the mtime guard above only narrowly prevents.
    undoStack.current = []
    baseline.current = ''
    // File contents belong to the board that referenced them. Kept across, a
    // card on the new board pointing at the same note would render text read
    // before the old board was closed, and save it back with a stale mtime.
    setFiles({})
    requested.current = new Set()

    if (!path) {
      setError(null)
      return
    }
    const load = async () => {
      try {
        setError(null)
        const body = await window.api.vault.read(path)
        if (cancelled) return
        const parsed = parseCanvas(body.text)
        setDoc(parsed)
        mtimeRef.current = body.mtime
        // The state the first undo returns to. Serialized rather than reusing
        // `body.text`, so it is normalised the same way every later snapshot
        // is and an undo cannot reformat the file as a side effect.
        baseline.current = serializeCanvas(parsed)
        // Framing happens in the layout effect below, once the surface is
        // actually mounted. See `framed`.
      } catch (e) {
        // Parse failures land here too, and they must: `doc` stays null, so
        // there is nothing for a drag to mutate and nothing for a save to
        // write. A corrupt board is shown as an error rather than as an empty
        // one that would overwrite itself on the first click.
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  /**
   * Frame the whole board on open.
   *
   * Same reason GraphView fits: a canvas whose cards sit at x=4000 opens on
   * empty space, and empty space is indistinguishable from a failed load. An
   * empty board is the one case with nothing to frame, so it keeps 1:1.
   */
  const fit = (d: CanvasDoc) => {
    const wrap = wrapRef.current
    if (!wrap || d.nodes.length === 0) {
      view.current = { tx: 0, ty: 0, k: 1 }
      setZoom(1)
      return
    }
    const r = wrap.getBoundingClientRect()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of d.nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const k = Math.min(
      K_MAX,
      Math.max(
        K_MIN,
        // The spans are floored at 1 because a board whose content has zero
        // width or height is legal — parseCanvas accepts width 0 — and 0/0 is
        // NaN, which passes through Math.max and Math.min unchanged. The world
        // would then get `transform: scale(NaN)`, the board would vanish, the
        // readout would say NaN%, and nothing would throw.
        Math.min(
          (r.width - FIT_PAD * 2) / Math.max(1, maxX - minX),
          (r.height - FIT_PAD * 2) / Math.max(1, maxY - minY),
        ),
      ),
    )
    view.current = {
      k,
      tx: r.width / 2 - ((minX + maxX) / 2) * k,
      ty: r.height / 2 - ((minY + maxY) / 2) * k,
    }
    setZoom(k)
    applyView()
  }

  // ── save ───────────────────────────────────────────────────────
  /**
   * Saves through the SAME `vault.save` the editor uses, which means a canvas
   * gets the lost-update guard, the pre-write backup and the atomic rename for
   * free. `.canvas` needed no new channel: `read`/`save` were never markdown,
   * they were always text plus an mtime.
   */
  const persist = (d: CanvasDoc, record = true) => {
    if (!path) return
    /**
     * Snapshot the state being REPLACED, not the one being written.
     *
     * `baseline` holds the board as it was after the last load or write, so at
     * the moment a mutation asks to be saved it is still the pre-mutation text
     * — exactly what an undo has to return to. Taken here rather than at each
     * call site because every mutation already funnels through this one
     * function, and a snapshot per call site is a snapshot someone will forget.
     *
     * Serialized EAGERLY. The write below runs inside the save chain, by which
     * time the user may have dragged again and mutated `d` further; reading it
     * then would record a state that was never the one being replaced.
     *
     * `record` is false only for the write an undo itself performs. Recording
     * that would push the undone state straight back onto the stack and turn
     * Ctrl+Z into a toggle between two boards.
     */
    if (record) {
      if (baseline.current) {
        undoStack.current.push(baseline.current)
        if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift()
      }
      baseline.current = serializeCanvas(d)
    }
    const target = path
    // The token this board had when the write was queued. Used only if the
    // board has moved on by the time it runs — see below.
    const queuedWith = mtimeRef.current

    saveChain.current = saveChain.current.then(async () => {
      /**
       * Still current => read the LIVE token, which the previous save in this
       * chain has already advanced. Moved on => the live token belongs to some
       * other board, so fall back to the one captured at queue time, which is
       * the right token for `target`.
       *
       * The write itself always goes to `target`. Dropping it because the user
       * changed board first would lose an edit they already made.
       */
      const expected = pathRef.current === target ? mtimeRef.current : queuedWith
      try {
        setSaving(true)
        const saved = await window.api.vault.save(target, serializeCanvas(d), expected)
        // Only write back if this is still the open board. Otherwise this would
        // stamp one board's mtime onto another and make its next save fail.
        if (pathRef.current === target) {
          mtimeRef.current = saved.mtime
          setError(null)
        }
      } catch (e) {
        // A SaveConflict here means the file changed under us, most likely
        // Obsidian. Surfaced rather than swallowed, because the alternative is a
        // board that silently stops persisting and looks like it is working.
        if (pathRef.current === target) setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving(false)
      }
    })
  }

  /**
   * Reads the note behind every file card that has not been read yet.
   *
   * Runs on `tick` as well as `doc`, so a card dropped onto the board loads
   * immediately rather than on the next unrelated render.
   *
   * A FAILED READ IS CACHED AS AN ERROR, not left absent. A missing or
   * unreadable note would otherwise be retried on every render forever, and the
   * card would sit on "Loading…" while the reason it is not loading — the file
   * was renamed in Obsidian, say — is never shown.
   */
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    for (const n of doc.nodes) {
      if (n.type !== 'file' || typeof n.file !== 'string') continue
      const target = n.file
      if (requested.current.has(target)) continue
      requested.current.add(target)
      void (async () => {
        try {
          const body = await window.api.vault.read(target)
          if (cancelled) return
          setFiles((f) => ({ ...f, [target]: { text: body.text, mtime: body.mtime } }))
        } catch (e) {
          if (cancelled) return
          setFiles((f) => ({
            ...f,
            [target]: { text: '', mtime: 0, error: e instanceof Error ? e.message : String(e) },
          }))
        }
      })()
    }
    return () => {
      cancelled = true
    }
  }, [doc, tick])

  /**
   * Writes a file card's edit back to the NOTE, not to the board.
   *
   * This is the difference between a file card and a text card, and it is the
   * whole point of the feature: the card is a window onto a real file, so
   * editing it changes that file everywhere — in the editor next door, in
   * Obsidian, on disk. The `.canvas` document is untouched; it only ever held
   * the path.
   *
   * Goes through the same `vault.save` with the same mtime token, so a note
   * changed underneath by another app is refused here exactly as it would be in
   * the editor rather than silently overwritten.
   */
  const commitFile = async (node: CanvasNode, value: string) => {
    setEditing(null)
    const target = typeof node.file === 'string' ? node.file : null
    if (!target) return
    const cached = files[target]
    // Unchanged is not a save: every write takes a backup first, so committing
    // an untouched card would fill .backups/ with identical copies.
    if (!cached || cached.error || cached.text === value) return
    try {
      const saved = await window.api.vault.save(target, value, cached.mtime)
      setFiles((f) => ({ ...f, [target]: { text: value, mtime: saved.mtime } }))
      setError(null)
    } catch (e) {
      // Surfaced rather than swallowed, for the same reason a board's save
      // conflict is: a card that silently stops persisting looks like it works.
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // ── the page menu ──────────────────────────────────────────────
  /**
   * Everything the right-click menu does, and every one of them goes through
   * `persist`, so every one of them is undoable with Ctrl+Z.
   */
  const menuNode = () =>
    menu?.id && doc ? (doc.nodes.find((n) => n.id === menu.id) ?? null) : null

  const removeNode = (node: CanvasNode) => {
    if (!doc) return
    const at = doc.nodes.indexOf(node)
    if (at >= 0) doc.nodes.splice(at, 1)
    // The edges that touched it go too — the dangling reference `addEdge`
    // refuses to create.
    for (let i = doc.edges.length - 1; i >= 0; i--) {
      const e = doc.edges[i]
      if (e.fromNode === node.id || e.toNode === node.id) doc.edges.splice(i, 1)
    }
    setSelected(new Set())
    repaint()
    void persist(doc)
  }

  const duplicateNode = (node: CanvasNode) => {
    if (!doc) return
    // The spread is the feature, same as Alt+drag: every own key crosses,
    // including fields from a spec version this app has never heard of.
    const copy: CanvasNode = {
      ...node,
      id: canvasId(),
      x: Math.round(node.x + DUPLICATE_OFFSET),
      y: Math.round(node.y + DUPLICATE_OFFSET),
    }
    doc.nodes.push(copy)
    selectNode(copy.id, false)
    repaint()
    void persist(doc)
  }

  const pasteNode = (wx: number, wy: number) => {
    if (!doc || !clipboard.current) return
    let copy: CanvasNode
    try {
      copy = JSON.parse(clipboard.current) as CanvasNode
    } catch {
      return
    }
    // A fresh id, or two pages would share one and every edge naming it would
    // be ambiguous. Centred on where the menu was opened.
    copy.id = canvasId()
    copy.x = Math.round(wx - copy.width / 2)
    copy.y = Math.round(wy - copy.height / 2)
    doc.nodes.push(copy)
    selectNode(copy.id, false)
    repaint()
    void persist(doc)
  }

  const setNodeColor = (node: CanvasNode, color: string | null) => {
    if (!doc) return
    // Deleted rather than set to '' for no colour: the spec's absent-means-
    // default is a real state, and an empty string is a value that means
    // nothing to any other reader of this file.
    if (color === null) delete node.color
    else node.color = color
    repaint()
    void persist(doc)
  }

  /** The arrow the menu was opened on, if it was opened on one. */
  const menuEdge = () =>
    menu?.edgeId && doc ? (doc.edges.find((e) => e.id === menu.edgeId) ?? null) : null

  /**
   * Writes an arrow's label — the condition, in the user's own words.
   *
   * The compiler reads this as the condition on that branch, so it is the one
   * piece of text on a board that changes what running it does. There was no
   * way to type one: labels authored in Obsidian rendered, but nothing here
   * could create or change one.
   */
  const setEdgeLabel = (edge: CanvasEdge, label: string) => {
    if (!doc) return
    const next = label.trim()
    // Cleared means REMOVED, not empty-string. An empty label is a key that
    // means nothing to any other reader of the file, and the renderer already
    // treats absent and blank the same — so the file should not carry both.
    if (next === '') delete edge.label
    else edge.label = next
    repaint()
    void persist(doc)
  }

  const removeEdge = (edge: CanvasEdge) => {
    if (!doc) return
    const at = doc.edges.indexOf(edge)
    if (at >= 0) doc.edges.splice(at, 1)
    repaint()
    void persist(doc)
  }

  const toggleLock = (node: CanvasNode) => {
    if (!doc) return
    // `locked` is not in JSON Canvas. It rides the spec's index signature, which
    // is what carries unknown fields through untouched — so Obsidian keeps it
    // rather than dropping it, and a future spec field of the same name would
    // mean the same thing anyway.
    if (node.locked) delete node.locked
    else node.locked = true
    repaint()
    void persist(doc)
  }

  // ── remove and undo ────────────────────────────────────────────
  /**
   * Deletes the selection, and every edge that touched it.
   *
   * Spliced IN PLACE, back to front, rather than reassigning `doc.nodes` to a
   * filtered copy. Same reason the drag writes through the document: the arrays
   * are the ones `parseCanvas` handed back, and replacing them is the first
   * step of the reconstruction the preservation rule forbids. Back to front so
   * removing one index does not shift the ones not yet examined.
   *
   * The edge pass is not optional. An edge naming a node that no longer exists
   * is the dangling reference `addEdge` refuses to create — the render skips
   * it, so nothing appears, while the file carries it and the info strip counts
   * it. Deleting a card must not produce the corruption adding one is guarded
   * against.
   */
  const deleteSelected = () => {
    if (!doc || selected.size === 0) return
    for (let i = doc.nodes.length - 1; i >= 0; i--)
      if (selected.has(doc.nodes[i].id)) doc.nodes.splice(i, 1)
    for (let i = doc.edges.length - 1; i >= 0; i--) {
      const e = doc.edges[i]
      if (selected.has(e.fromNode) || selected.has(e.toNode)) doc.edges.splice(i, 1)
    }
    // The ids are gone, so a selection holding them would highlight nothing and
    // arm a second Delete that removes nothing.
    setSelected(new Set())
    setEditing(null)
    // Nothing to skip: the deletion removed pages, and every group left is one
    // the user did not touch, so each should close over the gap. A group whose
    // last page was just deleted is empty and `groupFit` leaves it alone — an
    // emptied phase of a pipeline stays on the board to be refilled.
    fitGroups(doc, new Set())
    repaint()
    void persist(doc)
  }

  /**
   * Steps the board back one mutation.
   *
   * Restores by PARSING the stored text, which is the same path `load` takes,
   * so an undo carries groups, colours and unknown fields back exactly as the
   * file had them. Replacing `doc` is safe here for that reason and only that
   * reason: this object was never taken apart, so nothing can have been lost
   * from it.
   */
  const undo = () => {
    const prev = undoStack.current.pop()
    if (prev === undefined) return
    let restored: CanvasDoc
    try {
      restored = parseCanvas(prev)
    } catch {
      // A snapshot this view serialized cannot normally fail to parse. If it
      // does, dropping it is better than replacing a working board with
      // nothing, and the stack has already discarded the bad entry.
      return
    }
    baseline.current = prev
    setDoc(restored)
    setSelected(new Set())
    setEditing(null)
    repaint()
    // `false`: see the note in persist. This write is the undo, not a new
    // mutation to be undone.
    void persist(restored, false)
  }

  /**
   * Delete removes the selection, Ctrl/Cmd+Z steps back.
   *
   * On `window` because the board is not focusable — the same reason the
   * connect-mode Escape is. Bound only while a board is open.
   *
   * THE TEXT-ENTRY GUARD IS THE LOAD-BEARING PART. Backspace inside the card
   * editor is how you correct a typo; without this it would delete the card you
   * are typing into. `editing` alone is not enough — the rename and search
   * fields elsewhere in the pane are not this view's state and it cannot see
   * them, so the focused element is checked directly.
   */
  useEffect(() => {
    if (!doc) return
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null
      const typing =
        editing !== null ||
        (el !== null && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable))
      if (typing) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
        return
      }
      // Escape closes the page menu before anything else looks at the key.
      if (e.key === 'Escape' && menu) {
        e.preventDefault()
        setMenu(null)
        return
      }
      // Then it drops a selected arrow, on the same "never mind" reading that
      // a press on empty board already has.
      if (e.key === 'Escape' && selectedEdge) {
        e.preventDefault()
        setSelectedEdge(null)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        /**
         * An arrow first, because selecting one clears the card selection and
         * vice versa — only one of the two can be set, so the order is about
         * readability rather than precedence.
         */
        if (selectedEdge) {
          const edge = doc.edges.find((x) => x.id === selectedEdge)
          setSelectedEdge(null)
          if (edge) {
            e.preventDefault()
            removeEdge(edge)
          }
          return
        }
        // Only when something is selected, so a stray Backspace on an empty
        // board is not swallowed from whatever else might want it.
        if (selected.size === 0) return
        e.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, editing, selected, selectedEdge, menu])

  // ── interaction ────────────────────────────────────────────────
  /** Pointer position and view offset at the moment a background pan began. */
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  /** Open while the "+ Link" dialog is asking for a URL. */
  const [linkPrompt, setLinkPrompt] = useState(false)

  /**
   * The marquee, while one is being swept. World units, and the two corners are
   * kept as-pressed rather than normalised so a sweep up-and-left works — the
   * rectangle is normalised once, where it is used.
   */
  const marquee = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  /** The same rectangle, for painting it. Null when no sweep is in progress. */
  const [marqueeBox, setMarqueeBox] = useState<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)

  /**
   * The alignment and spacing lines shown during a shift-drag.
   *
   * State, because they are rendered elements rather than a transform that can
   * be written straight to the DOM the way a card's position is.
   *
   * GUARDED BY A KEY, and that guard is not premature. This runs on every
   * `mousemove` of a drag, and the guides are usually IDENTICAL between two
   * consecutive moves — you cross a snap line once and then stay locked to it
   * for as long as you keep dragging. Setting state unconditionally would
   * re-render the whole board on every mouse event, including the boards with
   * no edges, which today do not re-render during a drag at all. Comparing a
   * short string is cheaper than the render it avoids.
   */
  const [guides, setGuides] = useState<Guide[]>([])
  const guideKey = useRef('')
  const showGuides = useCallback((next: Guide[]) => {
    const key = next
      .map((g) => `${g.kind}${g.axis}${g.at}${g.from}${g.to}`)
      .join('|')
    if (key === guideKey.current) return
    guideKey.current = key
    setGuides(next)
  }, [])

  /** The card being dragged, and where inside it the grab landed, in world units. */
  const drag = useRef<{
    node: CanvasNode
    dx: number
    dy: number
    moved: boolean
    /** True when this gesture created the node it is dragging (Alt+drag). */
    created: boolean
    /**
     * The REST of the selection, each with its own grab offset.
     *
     * Selecting several pages and dragging one moved only the one you had hold
     * of, which makes a multi-selection something you can look at but not act
     * on. Every page carries its own offset from the pointer rather than a
     * shared delta, so the group keeps its shape exactly and each page lands on
     * integers independently — a shared delta rounded once would drift the
     * whole group off the grid together.
     */
    others: { node: CanvasNode; dx: number; dy: number }[]
  } | null>(null)

  /**
   * The card being resized, and the size and pointer position it started from.
   *
   * The ORIGIN is kept rather than the last position, so the size is always
   * `start + total travel`. Accumulating per-move deltas drifts: every move
   * rounds to an integer and the roundings add up over a gesture, so a card
   * dragged out and back does not come home to the size it left.
   */
  const resize = useRef<{
    node: CanvasNode
    x0: number
    y0: number
    w0: number
    h0: number
  } | null>(null)

  const onResizeDown = (e: React.PointerEvent, node: CanvasNode) => {
    if (e.button !== 0) return
    // Not a card drag and not a board pan. Without this the grip moves the card
    // it is supposed to be resizing.
    e.stopPropagation()
    const p = toWorld(e.clientX, e.clientY)
    resize.current = { node, x0: p.x, y0: p.y, w0: node.width, h0: node.height }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  /**
   * Sets every card to the house size.
   *
   * Groups are skipped. A group is a labelled REGION that contains cards, not a
   * card, and resizing one to a page would shrink it out from under whatever it
   * was drawn around.
   *
   * Position is left alone. Resizing from the top-left means a card grows down
   * and right, which can overlap a neighbour — but the alternative is moving
   * cards the user placed deliberately, and after this landed a drag brings the
   * covered card back to the front anyway.
   */
  const uniformSize = () => {
    if (!doc) return
    let changed = false
    for (const n of doc.nodes) {
      if (n.type === 'group') continue
      if (n.width === PAGE_SIZE.width && n.height === PAGE_SIZE.height) continue
      n.width = PAGE_SIZE.width
      n.height = PAGE_SIZE.height
      changed = true
    }
    // A no-op must not write the file: every save takes a backup first, so
    // pressing this twice would fill .backups/ with identical copies.
    if (!changed) return
    repaint()
    void persist(doc)
  }

  const toWorld = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    const { tx, ty, k } = view.current
    return { x: (clientX - r.left - tx) / k, y: (clientY - r.top - ty) / k }
  }

  // ── authoring ──────────────────────────────────────────────────
  /**
   * New cards and edges are PUSHED onto the doc `parseCanvas` returned. They are
   * never added by rebuilding the doc, for the same reason the drag writes
   * through it: a board carrying groups, colours, edge labels and fields from a
   * later spec version must come back out with all of them, and reconstructing
   * the document to add one card is exactly how that gets silently dropped.
   *
   * `canvasId()` and `NEW_TEXT_SIZE` come from shared/canvas.ts rather than
   * being invented here, so a card made in this app is shaped like one Obsidian
   * made — same id form, same default size.
   */
  /**
   * Makes a page centred on a point in WORLD coordinates.
   *
   * Split out so the toolbar and "New page here" share one creator: the only
   * difference between them is where the point comes from, and two copies of
   * the node shape is how the two drift apart.
   */
  const addCardAt = (wx: number, wy: number) => {
    if (!doc) return
    const p = { x: wx, y: wy }
    const node: CanvasNode = {
      id: canvasId(),
      type: 'text',
      text: '',
      // A card is page-shaped from the moment it exists, so a board does not
      // become a mix of two sizes the first time someone adds one.
      x: Math.round(p.x - PAGE_SIZE.width / 2),
      y: Math.round(p.y - PAGE_SIZE.height / 2),
      ...PAGE_SIZE,
    }
    doc.nodes.push(node)
    // Straight into editing: an empty page with no cursor in it gives the user
    // nothing to act on and reads as a page that failed to be created.
    setEditing(node.id)
    repaint()
    void persist(doc)
  }

  const addCard = () => {
    const p = viewportCentre()
    if (p) addCardAt(p.x, p.y)
  }

  /**
   * The centre of what the user is currently looking at, in world units.
   *
   * Pulled out of `addCard` because every creator needs it and each one
   * recomputing it is how they drift onto different origins.
   */
  const viewportCentre = () => {
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return null
    return toWorld(r.left + r.width / 2, r.top + r.height / 2)
  }

  /**
   * A GROUP, which is the fourth JSON Canvas node type and the one this app
   * could render but never make.
   *
   * A board that holds a whole business is a board that needs regions — this
   * area is clients, that one is Q3 — and until now the only way to draw one was
   * to author it in Obsidian and come back. That is the same defect as an edge
   * that renders but cannot be drawn, which `Connect` already fixed.
   *
   * Sized to hold something rather than to be a marker: a group you have to
   * resize before it contains anything is a group you resize every single time.
   * Two pages wide and one and a bit tall, so a pair of pages side by side drops
   * straight in.
   *
   * `label` is set here rather than left absent so the group is nameable the
   * moment it exists — an unnamed dashed rectangle gives the rename field in the
   * menu nothing to show, and reads as a stray box.
   */
  const addGroupAt = (wx: number, wy: number) => {
    if (!doc) return
    const width = PAGE_SIZE.width * 2 + GROUP_PAD * 3
    const height = PAGE_SIZE.height + GROUP_PAD * 2
    const node: CanvasNode = {
      id: canvasId(),
      type: 'group',
      label: 'New group',
      x: Math.round(wx - width / 2),
      y: Math.round(wy - height / 2),
      width,
      height,
    }
    /**
     * PUSHED, like every other thing this view creates.
     *
     * This was `unshift` for one revision, on the theory that a new group would
     * otherwise cover older ones. That reasoning was backwards and it shipped a
     * group you could not touch: two groups both sit at `z-index: 0`, so
     * document order decides hit testing, and first-in-document means painted
     * UNDERNEATH. Verified in the running app — a group created inside an
     * existing one came back selected, looked like it was yours, and handed
     * every click to the group behind it, including the right-click that
     * renames it.
     *
     * Cards are unaffected either way: they are `z-index: 1`, so a group can
     * never cover one.
     */
    doc.nodes.push(node)
    selectNode(node.id, false)
    repaint()
    void persist(doc)
  }

  /**
   * A LINK card — a URL on the board.
   *
   * `link` is the third of the four node types. It has rendered since the view
   * was written (see the `n.type === 'link'` arm below) and nothing has ever
   * been able to create one, so a board could show a URL only if Obsidian put it
   * there. For a board meant to hold a business that is a real gap: the supplier
   * portal, the Stripe dashboard and the shared drive are all URLs.
   *
   * The URL is asked for up front rather than created empty and edited in place.
   * A link card with no URL renders as nothing at all — the render arm requires
   * `n.url` — so an empty one would be an invisible node you cannot click to
   * fix.
   *
   * VIA NameDialog, NOT `window.prompt`. Prompt exists on `window` in Electron,
   * type-checks, greps clean, and throws `prompt() is not supported.` the moment
   * it is called. `no-window-prompt.test.mjs` pins that across this pane.
   */
  const addLink = (url: string) => {
    const p = viewportCentre()
    if (!doc || !p) return
    const node: CanvasNode = {
      id: canvasId(),
      type: 'link',
      url,
      x: Math.round(p.x - PAGE_SIZE.width / 2),
      y: Math.round(p.y - LINK_HEIGHT / 2),
      width: PAGE_SIZE.width,
      // A link is one line of text, not a document. Given a page's height it
      // would be an acre of empty card under a single URL.
      height: LINK_HEIGHT,
    }
    doc.nodes.push(node)
    selectNode(node.id, false)
    repaint()
    void persist(doc)
  }

  const addGroup = () => {
    const p = viewportCentre()
    if (p) addGroupAt(p.x, p.y)
  }

  /**
   * Writes a group's name.
   *
   * Clearing it REMOVES the key rather than storing an empty string, which is
   * the rule the arrow label already follows: the renderer treats absent and
   * blank the same, so a file carrying both is a file with two spellings of one
   * state.
   */
  const setGroupLabel = (node: CanvasNode, label: string) => {
    if (!doc) return
    const next = label.trim()
    if (next === (typeof node.label === 'string' ? node.label : '')) return
    if (next === '') delete node.label
    else node.label = next
    repaint()
    void persist(doc)
  }

  /**
   * A note dragged out of the tree becomes a file card where it was dropped.
   *
   * `dragover` has to preventDefault or no `drop` ever fires — the default
   * action for a dragged thing is "refuse it", and the refusal is silent, which
   * is the single commonest reason a drop target does nothing. It is guarded on
   * the custom type so the board only claims drags it can actually take.
   */
  const onDragOver = (e: React.DragEvent) => {
    if (!doc || !e.dataTransfer.types.includes(CANVAS_DROP_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onDrop = (e: React.DragEvent) => {
    if (!doc) return
    const file = e.dataTransfer.getData(CANVAS_DROP_MIME)
    // Empty means this was somebody else's drag that reached us anyway. Left
    // un-defaulted so the drop falls through to whatever would have had it.
    if (!file) return
    e.preventDefault()
    /**
     * Dropped where the CURSOR is, centred on it, which is where the user
     * pointed. `toWorld` already accounts for pan and zoom, so a card dropped
     * on a board scrolled far from the origin lands under the pointer rather
     * than at some remembered coordinate.
     */
    const p = toWorld(e.clientX, e.clientY)
    const node: CanvasNode = {
      id: canvasId(),
      type: 'file',
      file,
      x: Math.round(p.x - PAGE_SIZE.width / 2),
      y: Math.round(p.y - PAGE_SIZE.height / 2),
      ...PAGE_SIZE,
    }
    doc.nodes.push(node)
    // Selected on arrival: the card is the thing the user is now working with,
    // and it is what a following Delete or Ctrl+Z should act on.
    selectNode(node.id, false)
    repaint()
    void persist(doc)
  }

  const addEdge = (fromNode: string, toNode: string) => {
    if (!doc) return
    /**
     * Both endpoints must exist ON THIS BOARD.
     *
     * A dangling edge is the quietest corruption this view can produce: the
     * render skips an edge naming a missing node, so nothing appears, while
     * the file carries the reference and the info strip counts it. The board
     * reports a connection that is not there and gives no way to find out why.
     * Obsidian reads the same file and is under no obligation to be as
     * forgiving about it.
     */
    if (!doc.nodes.some((n) => n.id === fromNode)) return
    if (!doc.nodes.some((n) => n.id === toNode)) return
    // The same ordered pair twice is a no-op rather than a second identical line
    // stacked invisibly on the first.
    if (doc.edges.some((e) => e.fromNode === fromNode && e.toNode === toNode)) return
    // `fromSide`/`toSide` are deliberately omitted: the spec makes them optional
    // and edgeAnchor already derives the nearest sides from the geometry, so
    // writing them would freeze a routing decision that should follow the cards.
    doc.edges.push({ id: canvasId(), fromNode, toNode })
    repaint()
    void persist(doc)
  }

  /**
   * Select a card, or add and remove one from a multi-selection.
   *
   * `additive` is shift or ctrl/cmd. Toggling rather than only adding is what
   * lets a mis-click be undone without starting the whole selection again.
   *
   * A NEW Set every time, never a mutated one: React compares by identity, and
   * mutating the held Set would change the selection without re-rendering it,
   * so the highlight would lag one click behind the truth.
   */
  const selectNode = (id: string, additive: boolean) => {
    setSelected((prev) => {
      if (!additive) return new Set([id])
      const next = new Set(prev)
      // Set membership only. This removes nothing from the document — no card
      // and no edge — and there is a test pinning that.
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const commitText = (node: CanvasNode, value: string) => {
    setEditing(null)
    // A card opened and closed without a change must not write the file: save()
    // takes a backup before every overwrite, so a no-op commit would fill
    // .backups/ with identical copies.
    if (!doc || (node.text ?? '') === value) return
    node.text = value
    repaint()
    void persist(doc)
  }

  /**
   * Commits and closes the open editor, if the press that just happened was
   * somewhere else.
   *
   * THE TRAP THIS FIXES. `+ Card` opens the new card straight into editing, and
   * the textarea stops its own pointer events so selecting text does not drag
   * the card out from under the cursor. Nothing else closed the editor — commit
   * was Enter and discard was Escape, both requiring focus to still be IN the
   * textarea. So a new card could not be moved, could not be re-edited, and did
   * not respond to a click on any other card. Every `+ Card` left one behind,
   * and the newest was always the stuck one.
   *
   * This is NOT `onBlur`, which review-s2-vault-pane forbids across this pane,
   * and the distinction is the point rather than a way around the rule. That
   * rule exists because an edit reaching disk with nobody confirming it is how
   * work gets silently altered; a blur fires for reasons the user never chose —
   * a window losing focus, a re-render moving focus. This runs only on a
   * deliberate press on another card or on the board.
   *
   * It is still an implicit save, and that is a real change to "commit is
   * Enter". It is defensible now in a way it was not when the rule was written:
   * Ctrl+Z undoes it, so an edit committed by a misclick is one keystroke from
   * being gone. Escape still discards.
   */
  const closeEditor = () => {
    if (!editing || !doc) return
    const node = doc.nodes.find((n) => n.id === editing)
    const el = editRef.current
    // If either is missing there is nothing to commit, but the editor still has
    // to close or the card stays stuck — which is the whole bug.
    if (!node || !el) {
      setEditing(null)
      return
    }
    // A file card's edit belongs to the NOTE; a text card's belongs to the
    // board. Same gesture, two different destinations.
    if (node.type === 'file') void commitFile(node, el.value)
    else commitText(node, el.value)
  }

  const onBackgroundDown = (e: React.PointerEvent) => {
    /**
     * MIDDLE-DRAG PANS FROM ANYWHERE, INCLUDING FROM ON TOP OF A CARD.
     *
     * Left-drag already pans the board, but only from the background — a press
     * that lands on a card is that card's drag. On a dense board there is
     * frequently no background within reach, and the only way to move the view
     * was to find a gap or to reach for the scroll wheel. Middle-drag is the
     * gesture every other canvas answers to for exactly this, and it is
     * unambiguous: nothing else on this surface uses the middle button, so it
     * can pan regardless of what is underneath without stealing a meaning.
     *
     * It works over a card for free rather than by special-casing one:
     * `onNodeDown` returns on any non-left button BEFORE it stops propagation,
     * so a middle press on a card arrives here by bubbling.
     *
     * `preventDefault` because Chromium's middle-click autoscroll would
     * otherwise start its own competing scroll gesture on Windows.
     *
     * The selection is deliberately NOT cleared. Panning is looking, not
     * editing, and losing a multi-card selection because you moved the view to
     * see where you were dropping it would be its own small disaster.
     */
    if (e.button === 1) {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      pan.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty }
      setPanning(true)
      return
    }
    // Only a press on the board itself pans. A press that started on a card is
    // that card's drag, and it stops propagation below.
    if (e.button !== 0) return
    closeEditor()
    setSelectedEdge(null)
    // A press anywhere on the board dismisses the page menu, which is what
    // every menu on every platform does.
    setMenu(null)
    // A press on empty board clears the selection, which is the one gesture
    // everyone already expects to mean "never mind".
    setSelected(new Set())
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    /**
     * SHIFT SWEEPS A SELECTION; a plain drag still pans.
     *
     * The other way round is what Figma and Obsidian do — drag selects, space
     * or middle-drag pans — and it is the wrong change to make here. Drag-to-pan
     * is this board's established gesture, `canvas-cursor.test.mjs` pins the
     * grab cursor that advertises it, and silently swapping the meaning of the
     * one gesture every existing user already has in their hands would break
     * every board on the machine to match a convention from a different app.
     *
     * So the sweep goes on the modifier. Shift is already "and this one too" for
     * a click, which makes "and all of these" the same idea drawn out into a
     * rectangle rather than a second unrelated meaning for the key.
     */
    if (e.shiftKey) {
      const p = toWorld(e.clientX, e.clientY)
      marquee.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
      setMarqueeBox({ x: p.x, y: p.y, width: 0, height: 0 })
      return
    }
    pan.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty }
  }

  /**
   * The swept rectangle, normalised so it is valid whichever way it was drawn.
   * A sweep that ends above and left of where it started has a negative width,
   * and every intersection test below would silently match nothing.
   */
  const marqueeRect = (m: { x0: number; y0: number; x1: number; y1: number }) => ({
    x: Math.min(m.x0, m.x1),
    y: Math.min(m.y0, m.y1),
    width: Math.abs(m.x1 - m.x0),
    height: Math.abs(m.y1 - m.y0),
  })

  const onNodeDown = (e: React.PointerEvent, node: CanvasNode) => {
    // Any other button falls through to the surface, which is what lets a
    // middle-drag pan from on top of a card. Returning BEFORE stopping
    // propagation is load-bearing, not incidental.
    if (e.button !== 0) return
    // Without this the board pans at the same time as the card moves.
    e.stopPropagation()
    // A card and an arrow are alternative selections: taking one drops the
    // other, so Delete always has exactly one meaning.
    setSelectedEdge(null)
    /**
     * A LOCKED page does not move, and stopping here is what locks it: no
     * drag begins and no selection changes, so it cannot be nudged by a stray
     * press while you work around it. Propagation is already stopped above, so
     * the board does not pan out from under the click either.
     *
     * Right-click still reaches the menu, which is where Unlock lives — a lock
     * you cannot undo from the thing you locked is a trap.
     */
    if (node.locked) return
    // A press on a DIFFERENT card closes the open editor. Pressing the card
    // being edited is left alone: the textarea stops its own pointer events, so
    // reaching here at all means the press was on that card's border, which is
    // the user grabbing the card they are editing rather than leaving it.
    if (editing && editing !== node.id) closeEditor()
    /**
     * In connect mode a press picks an endpoint and never starts a drag.
     *
     * Handled on pointerdown rather than click so it shares the one path a card
     * press already takes — a click handler would run after this and have to
     * undo a drag that had already begun.
     */
    if (connect) {
      if (!linkFrom) {
        setLinkFrom(node.id)
        return
      }
      // A card connected to itself is a line with no meaning, so the second
      // press just cancels the pending pick.
      if (linkFrom !== node.id) addEdge(linkFrom, node.id)
      setLinkFrom(null)
      return
    }
    const p = toWorld(e.clientX, e.clientY)

    /**
     * Alt+drag duplicates, which is Obsidian's own gesture for this.
     *
     * THE SPREAD IS THE FEATURE. `{ ...node }` carries every own key across —
     * colour, `subpath`, a group's `background`, and any field from a spec
     * version this app has never heard of. Building the copy from the fields
     * this view knows about would quietly produce a card that is a downgraded
     * version of the one it was copied from, and the loss would save
     * immediately. This is the preservation rule applied to duplication.
     *
     * Only the three things that MUST differ are overridden: a fresh id,
     * because two nodes sharing one would make every edge ambiguous, and the
     * offset position.
     *
     * The original is never touched — the spread reads it and writes a new
     * object, and it is the COPY that gets dragged.
     */
    const target =
      e.altKey && doc
        ? (() => {
            const copy: CanvasNode = {
              ...node,
              id: canvasId(),
              // Rounded for the same reason as the drag: the offset is added to
              // the source's coordinate, so a copy of a card placed before that
              // fix would otherwise carry its fraction forward forever.
              x: Math.round(node.x + DUPLICATE_OFFSET),
              y: Math.round(node.y + DUPLICATE_OFFSET),
            }
            doc.nodes.push(copy)
            repaint()
            return copy
          })()
        : node

    /**
     * Selection follows the press, so a page is selected before any drag of it
     * begins. The duplicate becomes the selection when there is one — you are
     * now working on the copy, not the page you copied.
     *
     * EXCEPT when the press is a plain one on a page that is ALREADY part of a
     * multi-selection. `selectNode` with `additive` false replaces the
     * selection with just that page, which would collapse the group the instant
     * you reached for it and leave a group drag impossible to start. Keeping
     * the selection there is what every canvas app does, and it is what makes
     * grabbing any member of a group drag the whole group.
     */
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const inGroup = selected.has(target.id) && selected.size > 1
    if (additive || !inGroup) selectNode(target.id, additive)

    /**
     * EVERYTHING THIS GESTURE MOVES, target excluded — the selection, plus
     * whatever any group in it is holding.
     *
     * A group used to move alone, which made it a rectangle you could slide off
     * its own contents: the label and the box went one way and the pages it was
     * drawn around stayed put. Auto-fit could not save that either, because a
     * group is deliberately exempt from its own fit — fitting it would drag it
     * back onto the pages and it would read as refusing to move.
     *
     * MEMBERSHIP IS SNAPSHOT HERE, at press, and never recomputed during the
     * drag. Recomputing per frame would let a group adopt pages it happened to
     * sweep over and drop the ones it left behind, so what you released would
     * depend on the path you took rather than what you picked up.
     */
    const movers = new Set<CanvasNode>(
      inGroup && doc ? doc.nodes.filter((n) => selected.has(n.id)) : [target],
    )
    for (const n of [...movers]) {
      if (n.type === 'group' && doc) for (const m of groupMembers(n, doc.nodes)) movers.add(m)
    }
    movers.delete(target)

    // The grab offset is kept so the card does not jump its centre to the
    // cursor on the first move — the same correction GraphView documents.
    // Measured against the TARGET, so a duplicate keeps its offset from the
    // pointer rather than snapping back onto the original.
    drag.current = {
      node: target,
      dx: p.x - target.x,
      dy: p.y - target.y,
      moved: false,
      created: target !== node,
      /**
       * Read from the selection as it was BEFORE this press, which is the
       * selection the user made. `selectNode` above schedules a state update
       * that this render cannot see anyway, and that is the right value: a
       * plain press on an unselected page replaces the selection, so the group
       * is only the group when the page pressed was already in one.
       *
       * Empty for an Alt+drag. That gesture is dragging a fresh copy, and
       * duplicating a whole selection — or a whole group's contents — is a
       * different feature from moving one.
       */
      others:
        target === node
          ? [...movers].map((other) => ({ node: other, dx: p.x - other.x, dy: p.y - other.y }))
          : [],
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    /**
     * Raised for the duration of the gesture, so the card being dragged is not
     * painted UNDER the cards it travels across. Written straight to the
     * element for the same reason the geometry is: this changes 60 times a
     * gesture and none of it is state anything else reads.
     *
     * Only when the gesture is moving the card it started on. An Alt+drag is
     * dragging a COPY whose element does not exist yet — the copy was pushed to
     * the end of `doc.nodes`, so it already paints above everything, and
     * raising `currentTarget` here would raise the original it was copied from.
     */
    if (!drag.current.created) (e.currentTarget as HTMLElement).style.zIndex = '2'
  }

  /**
   * Moves a node to the END of `doc.nodes`, which is what puts it in front.
   *
   * PAINT ORDER IS DOCUMENT ORDER. Every card carries the same `z-index: 1`, so
   * two overlapping cards are resolved by their position in the file and
   * nothing else. A card dropped onto one that is later in the document is
   * painted underneath it, and from that moment the pointer cannot reach it:
   * every press lands on the card on top. With no delete and no undo that card
   * was unrecoverable without hand-editing the file.
   *
   * Reordering rather than raising `z-index` permanently, because order is
   * where JSON Canvas actually stores this. A z-index that lives in the DOM
   * would be forgotten on reload and would not survive the round trip to
   * Obsidian, which reads the same file and orders it the same way.
   *
   * Groups are unaffected: `.canvas-node--group` sits at `z-index: 0`, so a
   * group brought forward still paints behind the cards it contains.
   */
  const bringToFront = (node: CanvasNode) => {
    if (!doc) return
    const i = doc.nodes.indexOf(node)
    // Already last => already in front, and splicing would dirty the file for
    // nothing on every drag of the topmost card.
    if (i < 0 || i === doc.nodes.length - 1) return
    doc.nodes.splice(i, 1)
    doc.nodes.push(node)
    repaint()
  }

  const onMove = (e: React.PointerEvent) => {
    if (resize.current) {
      const p = toWorld(e.clientX, e.clientY)
      const r = resize.current
      // Rounded and floored for the same reasons as the drag: the spec declares
      // width and height INTEGER, and `toWorld` divides by a fractional scale.
      let w = Math.max(MIN_CARD_SIZE.width, Math.round(r.w0 + (p.x - r.x0)))
      let h = Math.max(MIN_CARD_SIZE.height, Math.round(r.h0 + (p.y - r.y0)))
      /**
       * SHIFT KEEPS THE PAGE A PAGE, and then lands it on a neighbour's size.
       *
       * Two steps in one modifier because they answer the same question — "make
       * this the right shape" — and either alone leaves the job half done.
       *
       * The ratio is taken from PAGE_SIZE rather than from the page's own
       * starting size, so Shift RESTORES the house proportion on a page that
       * has already been dragged out of shape rather than preserving the
       * mistake. Driven by whichever dimension you moved further, so the
       * gesture follows the direction you actually dragged.
       *
       * Then, if another page is within reach of that size, it takes that size
       * EXACTLY. Two pages that merely look the same size are the thing that
       * makes a board feel sloppy, and no amount of careful dragging lands on
       * the same integer twice.
       */
      if (e.shiftKey && doc) {
        const ratio = PAGE_SIZE.width / PAGE_SIZE.height
        if (Math.abs(w - r.w0) >= Math.abs(h - r.h0)) h = Math.round(w / ratio)
        else w = Math.round(h * ratio)
        let bestGap = SNAP_RANGE
        for (const other of doc.nodes) {
          if (other === r.node || other.type === 'group') continue
          const gap = Math.abs(other.width - w) + Math.abs(other.height - h)
          if (gap < bestGap) {
            bestGap = gap
            w = other.width
            h = other.height
          }
        }
      }
      r.node.width = w
      r.node.height = h
      applyNode(r.node)
      // Edges anchor to the card's SIDES, so a resize moves the ends of every
      // line touching it.
      if (doc && doc.edges.length > 0) repaint()
      return
    }
    if (drag.current) {
      const p = toWorld(e.clientX, e.clientY)
      // ROUNDED, because the spec declares x/y integer and `toWorld` divides by
      // the view scale — which is fractional after any wheel notch and after
      // `fit()` frames a board — so this wrote seventeen digits of noise into a
      // file the user diffs in git, and Obsidian rewrote it to an integer on
      // its next touch, so the two apps took turns rewriting the same card.
      const held = drag.current
      let x = Math.round(p.x - held.dx)
      let y = Math.round(p.y - held.dy)
      /**
       * PAGES LINE UP WITH THEIR NEIGHBOURS BY DEFAULT, per axis.
       *
       * This used to be held behind Shift, and the honest verdict on that is
       * that a snap nobody knows to ask for is a snap nobody gets: the board
       * read as pages floating loose, because in practice every drag was a free
       * drag. The alignment engine was already good — edges, centres, equal
       * spacing, the dot grid, all of it drawn while you drag — it was just
       * never running. So the modifier is INVERTED: aligning is what dragging
       * does, and Shift is the escape hatch for the deliberate off-grid
       * placement, which is the rarer intention and the one worth having to ask
       * for. Same gesture as every design tool that got here first.
       *
       * Each axis snaps independently, which is the point: a page can lock to
       * one page's left edge while sitting anywhere vertically. Locking both or
       * neither would make the common case — building a column — a fight.
       *
       * Deliberately NOT an axis-lock on the movement itself. Constraining a
       * drag to horizontal-only is a different feature that helps you move a
       * page without disturbing the other coordinate; this helps you place it
       * flush against something, which is what building a structure needs.
       *
       * Groups take part now, as their INTERIOR rather than their outline —
       * see `groupInterior`. Dropping them entirely was what left a page inside
       * a group with nothing to line up against, which is most of why a group
       * looked like a rectangle with its contents scattered in it.
       */
      if (doc && !e.shiftKey) {
        const others: GuideBox[] = doc.nodes
          .filter((n) => n !== held.node && !held.others.some((o) => o.node === n))
          .map((n) => (n.type === 'group' ? groupInterior(n) : n))
        /**
         * THE DOT GRID IS ALWAYS A CANDIDATE, alongside the other pages.
         *
         * Aligning only to pages meant that lining up with a neighbour which
         * was itself off-grid left both sitting between the dots — the board
         * looked wrong and the grid looked decorative. With the dots in the
         * running, whichever line is CLOSER wins: a page you are deliberately
         * butting against still takes it, and anywhere else you land on a dot.
         *
         * A grid line is never further than half a cell away, so this also
         * means Shift always does something, which is what makes it feel like a
         * snap rather than an occasional one.
         *
         * The arithmetic moved to `shared/guides.ts` unchanged — same lines,
         * same tie-breaking — because it now has to report WHICH line it
         * matched so the view can draw it, and because a test can import it
         * there instead of re-declaring it from the same constants.
         */
        /**
         * A GROUP ALIGNS BY ITS INTERIOR IN BOTH DIRECTIONS, and until now it
         * only did in one. A stationary group offers `groupInterior` as the
         * line others take, but a group being DRAGGED was matching on its own
         * outline — the very edge this file says nothing should be flush with,
         * because it is wherever someone left the resize handle. So a group
         * locked onto arbitrary positions, which is worse than not locking:
         * the board looked like it had snapped to something meaningful.
         *
         * Same inset both ways, so a group dragged up to a page lands with its
         * inner wall on that page's edge — exactly where the page would have
         * landed had it been dragged into the group instead.
         *
         * The offset is a constant inset, so the delta guideSnap returns for
         * the interior is the delta the group itself must move.
         */
        const box = { x, y, width: held.node.width, height: held.node.height }
        const snap = guideSnap(
          held.node.type === 'group' ? groupInterior(box) : box,
          others,
          { grid: GRID, range: SNAP_RANGE },
        )
        x += snap.dx
        y += snap.dy
        showGuides(snap.guides)
      } else if (guideKey.current !== '') {
        // Shift taken UP mid-drag, which now means alignment was switched off
        // rather than on. The lines have to go with it either way, or they sit
        // there claiming a relationship that is no longer being enforced.
        showGuides([])
      }
      /**
       * The snap is applied as a DELTA to the rest of the selection, not
       * recomputed per page. Snapping each member to its own nearest line would
       * pull the group apart; the whole selection moves as one object and the
       * page you grabbed is the one doing the aligning.
       */
      const snapX = x - Math.round(p.x - held.dx)
      const snapY = y - Math.round(p.y - held.dy)
      held.node.x = x
      held.node.y = y
      // The rest of the selection travels with it, each from its own offset so
      // the group keeps its shape.
      for (const other of held.others) {
        other.node.x = Math.round(p.x - other.dx) + snapX
        other.node.y = Math.round(p.y - other.dy) + snapY
        applyNode(other.node)
      }
      drag.current.moved = true
      // The card itself moves without React. The re-render is only for the
      // EDGES, which are JSX and read their endpoints from the node geometry —
      // without it a connected card would slide out from under its own line.
      applyNode(drag.current.node)
      if (doc && doc.edges.length > 0) repaint()
      return
    }
    if (marquee.current) {
      const p = toWorld(e.clientX, e.clientY)
      marquee.current.x1 = p.x
      marquee.current.y1 = p.y
      // State, unlike the pan above, because the rectangle is a rendered
      // element rather than a transform written straight to the DOM. One small
      // box per frame; the cards are untouched and do not re-layout.
      setMarqueeBox(marqueeRect(marquee.current))
      return
    }
    if (pan.current) {
      // Straight to the element. No state, so no render.
      view.current.tx = pan.current.tx + (e.clientX - pan.current.x)
      view.current.ty = pan.current.ty + (e.clientY - pan.current.y)
      applyView()
    }
  }

  /**
   * Whether the gesture that just ended actually moved a card.
   *
   * Survives past `onUp` on purpose. A pointerup is followed by a CLICK, and
   * the file card's onClick has to know whether it was a press or the end of a
   * drag. Reading `drag.current` there is too late — `onUp` has already nulled
   * it, so `drag.current?.moved` is `undefined`, `!undefined` is true, and
   * every card you dragged also opened its note. Which is precisely the bug the
   * check was written to prevent.
   */
  const draggedLast = useRef(false)

  const onUp = () => {
    // Unconditionally, and before any of the branches below return early. A
    // guide describes a snap that is being applied RIGHT NOW; once the pointer
    // is up nothing is being enforced, and a line left on the board would be
    // claiming a relationship that is no longer live.
    showGuides([])
    // Same reasoning for the pan cursor: the gesture is over whichever branch
    // below claims the event, and a grabbing hand left on screen is a lie.
    setPanning(false)
    /**
     * A finished sweep selects what it TOUCHED, not what it fully enclosed.
     *
     * Enclosure is the stricter rule and the wrong one on a board of
     * page-shaped cards: a page is 612x792, so selecting three of them by
     * enclosure means sweeping a rectangle bigger than all three put together,
     * which at any useful zoom is a sweep off the edge of the screen. Touching
     * is what a user means by dragging across a row of cards.
     *
     * Groups are excluded. A group is a region drawn AROUND cards, so any sweep
     * that touches its members touches it too, and every marquee would silently
     * pick up the box behind the things you were aiming at — then a drag would
     * move the region and its contents together.
     */
    if (marquee.current) {
      const r = marqueeRect(marquee.current)
      marquee.current = null
      setMarqueeBox(null)
      if (doc) {
        const hit = doc.nodes.filter(
          (n) =>
            n.type !== 'group' &&
            n.x < r.x + r.width &&
            n.x + n.width > r.x &&
            n.y < r.y + r.height &&
            n.y + n.height > r.y,
        )
        // A sweep that caught nothing leaves the selection cleared, which
        // `onBackgroundDown` already did. It must not be treated as a cancel.
        setSelected(new Set(hit.map((n) => n.id)))
      }
      return
    }
    // Saved on RELEASE, like the drag: a resize emits a pointer event per frame
    // and writing the file at that rate would take a backup copy each time.
    if (resize.current) {
      const r = resize.current
      resize.current = null
      // Only when the size actually changed. A press on the grip that never
      // travelled is not an edit and must not write the file.
      if (doc && (r.node.width !== r.w0 || r.node.height !== r.h0)) {
        // A page grown inside a group grows the group with it. The resized node
        // is skipped, which is what makes a GROUP still resizable by hand: fit
        // it here and the handle would spring back to the contents every time.
        fitGroups(doc, new Set([r.node]))
        void persist(doc)
      }
    }
    draggedLast.current = drag.current?.moved ?? false
    const held = drag.current
    if (held) {
      // The gesture raise comes off whatever the outcome. Removed by id rather
      // than from `currentTarget`, because a pointerup can land anywhere.
      nodeEls.current.get(held.node.id)?.style.removeProperty('z-index')
      // Ordered BEFORE the save below, so the write carries the new order
      // rather than needing a second one.
      if (held.moved) bringToFront(held.node)
    }
    // Saving on RELEASE, not on every move: a drag emits a pointer event per
    // frame, and writing the file 60 times a second would take a backup copy
    // each time (save() backs up before overwrite) and fill .backups/ with a
    // hundred snapshots of one gesture.
    // `created` as well as `moved`: an Alt+press that never moved still added a
    // card to the doc, and leaving it unsaved would show a duplicate on screen
    // that vanishes on reload.
    /**
     * The fit runs BEFORE the write, so the group's new box travels with the
     * same save — and, because `persist` snapshots the state it is replacing,
     * inside the same undo step as the drag that caused it. A fit that wrote
     * separately would take two backups of one gesture and cost two Ctrl+Z to
     * put back.
     *
     * Everything the gesture had hold of is skipped: dragging a group does not
     * carry its pages, so a group that fitted itself here would slide back onto
     * them the moment you released.
     */
    if ((drag.current?.moved || drag.current?.created) && doc) {
      if (held) fitGroups(doc, new Set([held.node, ...held.others.map((o) => o.node)]))
      void persist(doc)
    }
    drag.current = null
    pan.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect()
    const mx = e.clientX - r.left
    const my = e.clientY - r.top
    const v = view.current
    const before = { x: (mx - v.tx) / v.k, y: (my - v.ty) / v.k }
    // Multiplicative, so a notch feels the same at every zoom level.
    const k = Math.min(K_MAX, Math.max(K_MIN, v.k * Math.pow(0.999, e.deltaY)))
    // Keeps the point under the cursor fixed: zoom toward the pointer, or the
    // board runs away from whatever you aimed at.
    view.current = { k, tx: mx - before.x * k, ty: my - before.y * k }
    applyView()
    setZoom(k)
  }

  // ── render ─────────────────────────────────────────────────────
  if (!path) {
    return (
      <div className="canvas-empty">
        <Frame size={22} aria-hidden="true" />
        <strong>No canvas open.</strong>
        <span>Pick one from the Canvas icon in the left ribbon, or make a new one there.</span>
      </div>
    )
  }

  if (error && !doc) {
    return (
      <div className="canvas-empty canvas-empty--error">
        <strong>This canvas could not be opened.</strong>
        <span>{error}</span>
        <span className="canvas-empty-hint">
          Nothing has been written. The file is exactly as it was.
        </span>
      </div>
    )
  }

  if (!doc) return <div className="canvas-empty">Loading canvas…</div>

  const byId = new Map(doc.nodes.map((n) => [n.id, n]))

  return (
    <div className="canvas-view">
      <div className="canvas-toolbar">
        {/**
         * "Page", not "Card".
         *
         * A card is a sticky note — something small you jot on. These are
         * US Letter at 1:1, they hold a whole file, and you scroll and edit
         * inside them. The word was describing the old thing.
         *
         * The size button loses the name to avoid two controls both called
         * "Page"; what it does is make every page the same size, so it says so.
         */}
        <button type="button" className="canvas-tool" onClick={addCard}>
          + Page
        </button>
        {/* The other two node types the spec has and this board could only ever
            render. A group is a region you draw around work; a link is a URL.
            Both were authorable in Obsidian and nowhere here. */}
        <button
          type="button"
          className="canvas-tool"
          onClick={addGroup}
          title="Draw a labelled region around a part of the board"
        >
          + Box
        </button>
        <button
          type="button"
          className="canvas-tool"
          onClick={() => setLinkPrompt(true)}
          title="Put a URL on the board"
        >
          + Link
        </button>
        <button
          type="button"
          className="canvas-tool"
          onClick={uniformSize}
          title={`Set every page to ${PAGE_SIZE.width}x${PAGE_SIZE.height} (US Letter at 72dpi)`}
        >
          Uniform size
        </button>
        <button
          type="button"
          className="canvas-tool"
          aria-pressed={connect}
          onClick={() => {
            setConnect((c) => !c)
            // Leaving the mode drops a half-finished pick, or the next entry
            // would start with an endpoint the user has forgotten choosing.
            setLinkFrom(null)
          }}
        >
          Connect
        </button>
        {connect && (
          <span className="canvas-tool-hint">
            {linkFrom ? 'Click the card to connect to.' : 'Click the first card.'}
          </span>
        )}
      </div>

      <div
        className="canvas-surface"
        ref={wrapRef}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDragOver={onDragOver}
        onDrop={onDrop}
        /**
         * Right-click on the BOARD, which is a different menu from a page's:
         * paste, and add a page here. Without this, Paste was only reachable by
         * right-clicking some other page — which is precisely not where you
         * want the pasted one to land.
         */
        onContextMenu={(e) => {
          e.preventDefault()
          if (connect || !doc) return
          setSelected(new Set())
          const w = toWorld(e.clientX, e.clientY)
          setMenu({ x: e.clientX, y: e.clientY, wx: w.x, wy: w.y, id: null })
        }}
        onWheel={onWheel}
        data-tick={tick}
        data-connect={connect || undefined}
        data-marquee={marqueeBox ? '' : undefined}
        data-panning={panning || undefined}
      >
        {/* The transform is written by applyView(), never rendered. */}
        <div className="canvas-world" ref={worldRef}>
          {/* Edges are RENDERED but not yet authorable. A board made in
              Obsidian carries them, and drawing nothing where the file says
              there is a line would misreport the user's own work. The layer is
              sized in CSS and coordinates are shifted by EDGE_ORIGIN — see the
              constant for why the obvious zero-sized version paints nothing. */}
          <svg className="canvas-edges" aria-hidden="true">
            {/**
             * ONE marker serves both ends. `orient="auto-start-reverse"` is
             * what makes that work: used as `marker-start` it is rotated 180°,
             * so the head points back out of the source node, which is what a
             * `fromEnd` arrow means. Two mirrored definitions would be the
             * obvious version and would drift apart the first time the shape
             * changed.
             *
             * `markerUnits` is left at its default of `strokeWidth`, so the
             * head scales with the line rather than needing its own zoom maths.
             */}
            <defs>
              <marker
                id="canvas-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="canvas-arrow-head" />
              </marker>
            </defs>
            {doc.edges.map((edge) => {
              const a = byId.get(edge.fromNode)
              const b = byId.get(edge.toNode)
              // An edge naming a node that is not in the file is skipped rather
              // than crashing the board. Obsidian leaves these behind.
              if (!a || !b) return null
              // Derived first, then each end overridden only if the file names
              // a side for it. See anchorOn.
              const derived = edgeAnchor(a, b)
              const from = sidePoint(a, edge.fromSide, derived.from)
              const to = sidePoint(b, edge.toSide, derived.to)
              /**
               * A label is only drawn when there is one to draw.
               *
               * Checked for a non-empty STRING rather than truthiness: the
               * field is optional and unvalidated, and rendering `undefined`
               * or a number would put the word "undefined" on someone's board.
               * An empty label is a label the user cleared, so it draws
               * nothing rather than an empty halo.
               */
              const label = typeof edge.label === 'string' ? edge.label.trim() : ''
              const curve = edgeCurve(a, from, b, to, EDGE_ORIGIN)
              return (
                <g
                  key={edge.id}
                  className="canvas-edge-group"
                  /* The arrowhead fills with `context-stroke`, so marking the
                     GROUP is what lets a selected arrow and its head change
                     together without a second rule for the marker. */
                  data-selected={selectedEdge === edge.id || undefined}
                  /* Set on the GROUP so the line, its arrowheads (which fill
                     with context-stroke) and the label all inherit one value. */
                  ref={(el) => {
                    applyColor(el, edge.color)
                  }}
                >
                  <path
                    d={curve.d}
                    className="canvas-edge"
                    /* A path has an interior; an edge is a stroke. Without this
                       every curve is filled black between its ends. */
                    fill="none"
                    markerStart={
                      drawsArrow(edge.fromEnd, 'none') ? 'url(#canvas-arrow)' : undefined
                    }
                    markerEnd={drawsArrow(edge.toEnd, 'arrow') ? 'url(#canvas-arrow)' : undefined}
                  />
                  {/**
                   * A SECOND, INVISIBLE PATH along the same curve, purely to be
                   * hit. The drawn line is 2px and a 2px pointer target is one
                   * nobody can reliably hit; this one is fat and transparent.
                   *
                   * `pointer-events: stroke` in the stylesheet is doing the
                   * other half: the edge LAYER is `pointer-events: none` so it
                   * never steals a press meant for the board, and this element
                   * opts back in for its stroke alone — not its interior, which
                   * would make the area between two curves clickable.
                   *
                   * Drawn after the visible line so it is the topmost thing
                   * along that path and wins the hit test.
                   */}
                  <path
                    d={curve.d}
                    className="canvas-edge-hit"
                    fill="none"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return
                      if (connect) return
                      // Or the board beneath treats this as a press on empty
                      // space, clears the selection this is about to make, and
                      // starts panning under the arrow.
                      e.stopPropagation()
                      setSelectedEdge(edge.id)
                      setSelected(new Set())
                      setMenu(null)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      // Or the board's own menu opens behind this one.
                      e.stopPropagation()
                      if (connect) return
                      const w = toWorld(e.clientX, e.clientY)
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        wx: w.x,
                        wy: w.y,
                        id: null,
                        edgeId: edge.id,
                      })
                    }}
                  />
                  {label && (
                    // Midpoint of the CURVE, not of the two anchors — see
                    // edgeCurve. A hand-routed edge still carries its label
                    // along the route the user actually chose, because the
                    // curve is built from the anchors the file stated.
                    <text
                      x={curve.mid.x}
                      y={curve.mid.y}
                      className="canvas-edge-label"
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {label}
                    </text>
                  )}
                </g>
              )
            })}
            {/**
             * THE GUIDES, drawn last so they sit above the edges.
             *
             * In the edge layer rather than a layer of their own: it is already
             * an SVG in world coordinates with the same EDGE_ORIGIN shift, and
             * a second one would be a second thing to keep aligned with the
             * board's transform. Empty except during a shift-drag.
             *
             * `at`/`from`/`to` are perpendicular to each other — see the Guide
             * type. An `x` alignment is a shared x drawn as a VERTICAL line.
             */}
            {guides.map((g, i) => {
              const { x1, y1, x2, y2 } = guideLine(g)
              if (g.kind === 'align') {
                return (
                  <line
                    key={`align-${i}`}
                    className="canvas-guide"
                    x1={x1 + EDGE_ORIGIN}
                    y1={y1 + EDGE_ORIGIN}
                    x2={x2 + EDGE_ORIGIN}
                    y2={y2 + EDGE_ORIGIN}
                  />
                )
              }
              // A gap tick runs ALONG its axis, with a serif at each end so it
              // reads as a measurement rather than as another alignment line.
              const horizontal = g.axis === 'x'
              const cap = 5
              return (
                <g key={`gap-${i}`} className="canvas-guide-gap">
                  <line x1={x1 + EDGE_ORIGIN} y1={y1 + EDGE_ORIGIN} x2={x2 + EDGE_ORIGIN} y2={y2 + EDGE_ORIGIN} />
                  <line
                    x1={x1 + EDGE_ORIGIN - (horizontal ? 0 : cap)}
                    y1={y1 + EDGE_ORIGIN - (horizontal ? cap : 0)}
                    x2={x1 + EDGE_ORIGIN + (horizontal ? 0 : cap)}
                    y2={y1 + EDGE_ORIGIN + (horizontal ? cap : 0)}
                  />
                  <line
                    x1={x2 + EDGE_ORIGIN - (horizontal ? 0 : cap)}
                    y1={y2 + EDGE_ORIGIN - (horizontal ? cap : 0)}
                    x2={x2 + EDGE_ORIGIN + (horizontal ? 0 : cap)}
                    y2={y2 + EDGE_ORIGIN + (horizontal ? cap : 0)}
                  />
                  {/* The number, so "these two gaps are equal" is a claim the
                      user can check rather than take on trust. */}
                  <text
                    className="canvas-guide-size"
                    x={(x1 + x2) / 2 + EDGE_ORIGIN}
                    y={(y1 + y2) / 2 + EDGE_ORIGIN - (horizontal ? 8 : 0)}
                    textAnchor="middle"
                    dominantBaseline={horizontal ? 'auto' : 'middle'}
                  >
                    {g.size}
                  </text>
                </g>
              )
            })}
          </svg>

          {doc.nodes.map((n) => (
            <div
              key={n.id}
              className={`canvas-node canvas-node--${n.type}`}
              /* Geometry is written by applyNode() in the layout effect, so a
                 card is positioned before the browser paints it and never
                 flashes at the origin first. */
              ref={(el) => {
                if (el) nodeEls.current.set(n.id, el)
                else nodeEls.current.delete(n.id)
              }}
              onPointerDown={(e) => onNodeDown(e, n)}
              /* Right-click opens the page menu. Selecting the page first means
                 the menu is always acting on something visibly chosen, rather
                 than on a page the user has to remember they right-clicked. */
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (connect) return
                selectNode(n.id, false)
                const w = toWorld(e.clientX, e.clientY)
                setMenu({ x: e.clientX, y: e.clientY, wx: w.x, wy: w.y, id: n.id })
              }}
              data-locked={n.locked ? '' : undefined}
              /**
               * ON THE CARD, NOT ON THE TEXT INSIDE IT, and that is the fix
               * rather than a preference.
               *
               * `onNodeDown` calls `setPointerCapture` on this element, and a
               * captured pointer retargets the click AND the dblclick that
               * follow to the capture element. So the dblclick fires HERE, on
               * the card, no matter where inside it the press landed. It was
               * registered on the inner `.canvas-text` div, which is a child —
               * and events do not propagate downward, so it never fired at all
               * and double-click-to-edit simply did nothing. Measured:
               * `dblclick detail=2 target=canvas-node canvas-node--text`.
               *
               * That left `+ Card` as the only way to open an editor, which
               * meant text already on a card could never be changed.
               *
               * Connect mode is excluded because there a press picks an
               * endpoint, and two picks in quick succession are an ordinary way
               * to draw an edge — not a request to start typing.
               */
              /**
               * A page that names another BOARD opens it. The drill-down: the
               * main board holds a page per pipeline, and clicking one goes
               * into that pipeline.
               *
               * ON THE CARD for the same reason the double-click is: pointer
               * capture retargets the click here, so the handler on the inner
               * title button never fires. That is why clicking a file page did
               * nothing at all.
               *
               * Only boards. A page naming a NOTE is already showing that note
               * and is edited in place by double-click — and a single click
               * that opened the editor would fire on the way to every
               * double-click, unmounting the board mid-gesture.
               */
              onClick={(e) => {
                if (connect || n.type !== 'file' || typeof n.file !== 'string') return
                if (!isCanvasPath(n.file)) return
                // A drag that ends on the page also fires a click; without this
                // rearranging a board would navigate away from it.
                if (e.detail !== 0 && draggedLast.current) return
                // A modifier press was a selection or a duplicate, not an open.
                if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
                onOpenNote(n.file)
              }}
              onDoubleClick={() => {
                /**
                 * `text` edits the card, `file` edits the NOTE the card shows.
                 *
                 * Every other type is left alone. `link` and `group` have
                 * nothing to type into, and this is also the fallback for a node
                 * type from a later spec version — turning one of those into an
                 * edited text card would destroy exactly what the preservation
                 * rule protects.
                 *
                 * A file card whose note failed to read is not editable either:
                 * there is no text and no mtime, so a commit would either write
                 * an empty note over a real one or be refused.
                 */
                if (connect) return
                if (n.type === 'text') setEditing(n.id)
                else if (n.type === 'file' && typeof n.file === 'string') {
                  // A page naming a BOARD is opened, not edited. Editing one
                  // here would put its raw JSON in a textarea, which is not a
                  // thing anyone wants and is an excellent way to corrupt a
                  // board by hand.
                  if (isCanvasPath(n.file)) return
                  const body = files[n.file]
                  if (body && !body.error) setEditing(n.id)
                }
              }}
              data-linking={linkFrom === n.id || undefined}
              data-selected={selected.has(n.id) || undefined}
            >
              {/**
               * The resize grip. Last in the card so it paints over the
               * content, and `aria-hidden` because it is a pointer affordance
               * with a keyboard equivalent nowhere yet — announcing a control
               * that cannot be operated is worse than announcing nothing.
               *
               * Not rendered in connect mode: there a press means "pick this
               * endpoint", and a grip that swallowed it would make the corner
               * of every card a dead spot in the one mode where the whole card
               * is supposed to be a target.
               */}
              {/* No grip on a locked page: a lock that stopped the page moving
                  but let it be resized would only be half a lock. */}
              {!connect && !n.locked && (
                <div
                  className="canvas-resize"
                  aria-hidden="true"
                  onPointerDown={(e) => onResizeDown(e, n)}
                />
              )}
              {n.type === 'file' && typeof n.file === 'string' ? (
                <button
                  type="button"
                  className="canvas-file"
                  title={n.file}
                  onClick={(e) => {
                    // A drag that ends on the card also fires a click. Without
                    // this, rearranging a board opens every card you touched.
                    // Connect mode is excluded for the same reason: picking a
                    // file card as an endpoint must not also leave the board.
                    if (connect) return
                    /**
                     * The drag guard applies to POINTER clicks only.
                     *
                     * `draggedLast` is set in onUp and cleared only by the next
                     * pointerup. A keyboard Enter or Space on this button fires
                     * a click with no pointer events at all, so after any drag
                     * the button silently did nothing — forever, until the user
                     * happened to press and release the mouse somewhere on the
                     * board. A keyboard-synthesised click carries `detail: 0`.
                     */
                    if (e.detail !== 0 && draggedLast.current) return
                    /**
                     * A modifier press did something other than open. Read off
                     * the click event rather than remembered from the
                     * pointerdown, because the browser already carries it and a
                     * second ref would be a second thing to keep in sync.
                     *
                     * Shift/Ctrl/Cmd were a SELECTION — without this a file
                     * card could never join a multi-selection without
                     * navigating away from the board.
                     *
                     * Alt was a DUPLICATE, and leaving it out made one gesture
                     * do two things: the press cloned the card, `onUp`
                     * persisted the clone because `created` was true, and then
                     * this click opened the note and unmounted the board the
                     * user was working on. `draggedLast` does not catch it,
                     * because a press that never travels has `moved` false.
                     */
                    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
                    onOpenNote(n.file!)
                  }}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span className="canvas-file-title">{fileNodeTitle(n.file)}</span>
                </button>
              ) : null}
              {n.type === 'file' && typeof n.file === 'string' ? (
                /**
                 * THE CARD IS THE FILE. Its real text, under a title bar that
                 * still opens the note in the editor.
                 *
                 * Double-click swaps this for a textarea over the same text, so
                 * a note can be read and written without leaving the board —
                 * which is the point of a board made of files rather than of
                 * labels.
                 */
                editing === n.id ? (
                  <textarea
                    className="canvas-file-edit"
                    ref={editRef}
                    defaultValue={files[n.file]?.text ?? ''}
                    autoFocus
                    aria-label={`Contents of ${n.file}`}
                    // Same reason as the text card's editor: selecting text
                    // must not drag the card out from under the cursor.
                    onPointerDown={(e) => e.stopPropagation()}
                    // A note is many lines and Enter is a NEWLINE in one, not a
                    // commit — the opposite of the text card, where a card is a
                    // caption and Enter submits. Committing is pressing away
                    // from the card, and Escape still discards.
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setEditing(null)
                      }
                    }}
                    // The board zooms on wheel. Inside a scrolling note that
                    // would zoom the board instead of moving through the text.
                    onWheel={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="canvas-file-body"
                    /**
                     * Wheel is claimed only when this body can actually scroll
                     * in the direction asked for. A card whose note fits has
                     * nothing to scroll, so the wheel belongs to the board's
                     * zoom — otherwise, with page-sized cards covering most of
                     * the board, zooming would stop working almost everywhere.
                     */
                    onWheel={(e) => {
                      const el = e.currentTarget
                      const room = el.scrollHeight - el.clientHeight
                      if (room <= 1) return
                      const atTop = el.scrollTop <= 0 && e.deltaY < 0
                      const atEnd = el.scrollTop >= room - 1 && e.deltaY > 0
                      if (!atTop && !atEnd) e.stopPropagation()
                    }}
                  >
                    {files[n.file]?.error ? (
                      <span className="canvas-file-problem">{files[n.file]!.error}</span>
                    ) : files[n.file] ? (
                      files[n.file]!.text
                    ) : (
                      <span className="canvas-file-problem">Loading…</span>
                    )}
                  </div>
                )
              ) : n.type === 'link' && n.url ? (
                // Rendered as its URL, deliberately not as a live link: this is
                // a renderer with node integration, and an <a> here would open
                // an arbitrary URL in the app's own window.
                <div className="canvas-link">
                  <Link2 size={13} aria-hidden="true" />
                  <span className="canvas-link-url">{String(n.url)}</span>
                </div>
              ) : n.type === 'group' ? (
                <span className="canvas-group-label">
                  {typeof n.label === 'string' ? n.label : ''}
                </span>
              ) : editing === n.id ? (
                /**
                 * Editing is a plain <textarea>, the same control the note
                 * Editor uses. It stops its own pointer events so selecting
                 * text does not drag the card out from under the cursor.
                 *
                 * COMMIT IS ENTER, NOT BLUR, and that is a rule rather than a
                 * preference: review-s2-vault-pane forbids `onBlur=` across
                 * this whole pane, because an implicit save is how an edit
                 * nobody confirmed reaches disk. Enter-to-submit is the gesture
                 * TerminalView already uses for its input, so this is the
                 * pane's existing convention rather than a new one. Shift+Enter
                 * stays the newline, so a multi-line card is still writable.
                 */
                <textarea
                  className="canvas-text-edit"
                  ref={editRef}
                  defaultValue={typeof n.text === 'string' ? n.text : ''}
                  autoFocus
                  aria-label="Card text"
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // `isComposing` guards the IME. When typing Japanese,
                    // Chinese or Korean, Enter ACCEPTS the candidate rather
                    // than submitting, so without this the card commits
                    // mid-composition and stores the un-converted romaji as
                    // its real text. This is the pane's first keyboard-commit,
                    // so it is the first place that trap exists.
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      commitText(n, e.currentTarget.value)
                    } else if (e.key === 'Escape') {
                      // Discards the edit. Stopped so nothing behind the board
                      // acts on the same Escape, as the dialogs here do.
                      e.stopPropagation()
                      setEditing(null)
                    }
                  }}
                />
              ) : (
                // Text cards show their markdown as written. Rendering it is
                // the Editor's job and it does not live here yet.
                <div className="canvas-text">
                  {typeof n.text === 'string' ? n.text : ''}
                </div>
              )}
            </div>
          ))}
          {/**
           * The marquee, INSIDE the world so it pans and zooms with the cards it
           * is being swept across. Drawn in screen space it would drift off the
           * cards the moment the board moved under it.
           *
           * Positioned through the REF, not a style prop. review-s2-vault-pane
           * bans inline style objects across this pane so that presentation
           * stays in the stylesheet, and this is the same imperative write
           * `applyNode()` already makes for every page's geometry — four numbers
           * that no stylesheet rule could express, because they are "wherever
           * the pointer has got to".
           *
           * `aria-hidden` because it is the visible half of a gesture the user
           * is making right now, not information.
           */}
          {marqueeBox && (
            <div
              className="canvas-marquee"
              aria-hidden="true"
              ref={(el) => {
                if (!el) return
                el.style.left = `${marqueeBox.x}px`
                el.style.top = `${marqueeBox.y}px`
                el.style.width = `${marqueeBox.width}px`
                el.style.height = `${marqueeBox.height}px`
              }}
            />
          )}
        </div>
      </div>

      {/**
       * The page menu.
       *
       * OUTSIDE the world div on purpose: in it, the menu would be scaled by
       * the board's zoom and would be unreadable at 25% and enormous at 300%.
       * Chrome belongs in screen coordinates.
       *
       * Positioned through the ref rather than a style prop — review-s2 bans
       * inline style objects across this pane, and this is the same imperative
       * write applyNode() already makes for every page's geometry.
       */}
      {menu && (
        <div
          className="canvas-menu"
          role="menu"
          ref={(el) => {
            if (!el) return
            el.style.left = `${menu.x}px`
            el.style.top = `${menu.y}px`
          }}
        >
          {/**
           * Arrow menu. An arrow carries the CONDITION on a branch, which is
           * the one piece of text on a board that changes what running it does
           * — and until now nothing here could write one. Labels authored in
           * Obsidian rendered; there was no way to make or change one, and no
           * way to remove an arrow once drawn.
           *
           * The label is an input rather than a menu item opening a dialog: it
           * is one short string, and a dialog to type six words is a second
           * click and a second thing to dismiss. Enter commits, Escape leaves
           * it alone.
           */}
          {menuEdge() && (
            <>
              <input
                className="canvas-menu-input"
                defaultValue={typeof menuEdge()?.label === 'string' ? String(menuEdge()!.label) : ''}
                autoFocus
                aria-label="Arrow label"
                placeholder="Label this arrow"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const ed = menuEdge()
                    if (ed) setEdgeLabel(ed, e.currentTarget.value)
                    setMenu(null)
                  } else if (e.key === 'Escape') {
                    // Stopped, or the board's own Escape handling also runs.
                    e.stopPropagation()
                    setMenu(null)
                  }
                }}
              />
              <button
                type="button"
                className="canvas-menu-item canvas-menu-item--danger"
                role="menuitem"
                onClick={() => {
                  const ed = menuEdge()
                  if (ed) removeEdge(ed)
                  setMenu(null)
                }}
              >
                Delete arrow
              </button>
            </>
          )}

          {/**
           * A GROUP'S NAME, on the same reasoning as the arrow label above: it
           * is one short string, and the label is the entire point of a group —
           * an unnamed dashed rectangle says nothing about the region it draws.
           * Until now it could only be written in Obsidian.
           *
           * Shown only for a group. Every other node type has its own text
           * already, edited on the card rather than in a menu.
           */}
          {menuNode()?.type === 'group' && (
            <input
              className="canvas-menu-input"
              defaultValue={
                typeof menuNode()?.label === 'string' ? String(menuNode()!.label) : ''
              }
              autoFocus
              aria-label="Group name"
              placeholder="Name this group"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const n = menuNode()
                  if (n) setGroupLabel(n, e.currentTarget.value)
                  setMenu(null)
                } else if (e.key === 'Escape') {
                  // Stopped, or the board's own Escape handling also runs.
                  e.stopPropagation()
                  setMenu(null)
                }
              }}
            />
          )}

          {/* Board menu: the one item that only makes sense on empty space. */}
          {!menuNode() && !menuEdge() && (
            <button
              type="button"
              className="canvas-menu-item"
              role="menuitem"
              onClick={() => {
                addCardAt(menu.wx, menu.wy)
                setMenu(null)
              }}
            >
              New page here
            </button>
          )}
          {menuNode() && (
            <>
          <button
            type="button"
            className="canvas-menu-item"
            role="menuitem"
            onClick={() => {
              const n = menuNode()
              if (n) duplicateNode(n)
              setMenu(null)
            }}
          >
            Duplicate
          </button>
          <button
            type="button"
            className="canvas-menu-item"
            role="menuitem"
            onClick={() => {
              const n = menuNode()
              if (n) clipboard.current = JSON.stringify(n)
              setMenu(null)
            }}
          >
            Copy
          </button>
            </>
          )}
          {/* Not on an arrow: there is nothing to paste onto a line. */}
          {!menuEdge() && (
            <button
              type="button"
              className="canvas-menu-item"
              role="menuitem"
              // Disabled rather than hidden: a menu whose shape changes between
              // openings is one you have to read every time.
              disabled={clipboard.current === null}
              onClick={() => {
                pasteNode(menu.wx, menu.wy)
                setMenu(null)
              }}
            >
              Paste
            </button>
          )}
          {menuNode() && (
            <button
              type="button"
              className="canvas-menu-item"
              role="menuitem"
              onClick={() => {
                const n = menuNode()
                if (n) toggleLock(n)
                setMenu(null)
              }}
            >
              {menuNode()?.locked ? 'Unlock' : 'Lock'}
            </button>
          )}

          {menuNode() && (
          <>
          {/* Swatches rather than a submenu: six colours fit on one row, and a
              submenu would be a second click for the shortest list in the app.
              The values are the spec's presets 1-6; canvas.css owns what each
              one looks like, which is where every other colour decision lives. */}
          <div className="canvas-menu-colours" role="group" aria-label="Page colour">
            <button
              type="button"
              className="canvas-menu-swatch canvas-menu-swatch--none"
              aria-label="No colour"
              title="No colour"
              onClick={() => {
                const n = menuNode()
                if (n) setNodeColor(n, null)
                setMenu(null)
              }}
            />
            {['1', '2', '3', '4', '5', '6'].map((c) => (
              <button
                key={c}
                type="button"
                className="canvas-menu-swatch"
                data-colour={c}
                aria-label={`Colour ${c}`}
                title={`Colour ${c}`}
                onClick={() => {
                  const n = menuNode()
                  if (n) setNodeColor(n, c)
                  setMenu(null)
                }}
              />
            ))}
          </div>

          {/* Last, and separated, because it is the one that cannot be taken
              back by clicking the same item again. Ctrl+Z still covers it. */}
          <button
            type="button"
            className="canvas-menu-item canvas-menu-item--danger"
            role="menuitem"
            onClick={() => {
              const n = menuNode()
              if (n) removeNode(n)
              setMenu(null)
            }}
          >
            Delete
          </button>
          </>
          )}
        </div>
      )}

      {/* Announced, because "Saving…" and the save error live here and are
          otherwise silent — a failed save is invisible to anyone not watching
          this corner of the window. */}
      <div className="canvas-info" role="status">
        <span>{path.split('/').pop()}</span>
        <span className="canvas-info-sep">·</span>
        <span>
          {doc.nodes.length} page{doc.nodes.length === 1 ? '' : 's'}
        </span>
        {doc.edges.length > 0 && (
          <>
            <span className="canvas-info-sep">·</span>
            <span>{doc.edges.length} connections</span>
          </>
        )}
        {selected.size > 0 && (
          <>
            <span className="canvas-info-sep">·</span>
            <span>{selected.size} selected</span>
          </>
        )}
        <span className="canvas-info-sep">·</span>
        <span>{Math.round(zoom * 100)}%</span>
        {saving && <span className="canvas-info-saving">Saving…</span>}
        {error && doc && <span className="canvas-info-error">{error}</span>}
      </div>

      {/**
       * The URL field for "+ Link". A real <dialog> rather than window.prompt,
       * which is present on `window` in Electron, type-checks, and throws the
       * moment it is called — see NameDialog's own header, and
       * no-window-prompt.test.mjs, which pins it across this pane.
       */}
      <NameDialog
        isOpen={linkPrompt}
        title="Add a link"
        label="URL to put on the board"
        placeholder="https://"
        confirmLabel="Add link"
        /**
         * Validated BEFORE the card exists, because a link card renders only
         * when `n.url` is set — so a card created from junk would be an
         * invisible node that cannot be clicked to fix or delete.
         *
         * `new URL()` is the parser the platform already ships; a regex here
         * would be a worse one. The protocol allowlist is the real check: a
         * `javascript:` or `file:` URL is a live hazard in a renderer with node
         * integration, and this board is a document other people's files can
         * reach.
         */
        validate={(value) => {
          const raw = value.trim()
          if (raw === '') return 'Enter a URL.'
          let parsed: URL
          try {
            parsed = new URL(raw)
          } catch {
            return 'That is not a URL. Include the scheme, e.g. https://example.com'
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return 'Only http:// and https:// links can go on a board.'
          }
          return null
        }}
        onSubmit={(value) => {
          setLinkPrompt(false)
          addLink(value.trim())
        }}
        onCancel={() => setLinkPrompt(false)}
      />
    </div>
  )
}

/**
 * The Canvas panel in the left ribbon — the fourth icon to graduate from
 * SidebarPlaceholder, after Bookmarks, Daily Notes and Terminal.
 *
 * It reads the boards straight out of `vault.tree()` rather than asking the
 * disk again, which is the same choice DailyNotesView made and for the same
 * reason: the tree is already the app's answer to "what is in this vault", and
 * a second walk is a second answer waiting to disagree with the first. This is
 * what `kind: 'canvas'` on VaultTreeNode is for.
 */
export interface CanvasListProps {
  tree: VaultTreeNode | null
  /** The board currently open, so the list can mark it. */
  current: string | null
  onOpen: (path: string) => void
  /** Re-read the tree, so a new board appears in this list and the explorer. */
  onCreated: () => void
}

/** Every `.canvas` in the vault, depth-first, in tree order. */
function collectCanvases(node: VaultTreeNode | null): VaultTreeNode[] {
  if (!node) return []
  const out: VaultTreeNode[] = []
  const walk = (n: VaultTreeNode) => {
    if (n.kind === 'canvas') out.push(n)
    n.children?.forEach(walk)
  }
  walk(node)
  return out
}

/**
 * One board in the sidebar tree.
 *
 * DRAGGABLE, carrying the same payload a note from the file tree carries, so a
 * board can be dropped onto an open board and become a page pointing at it.
 * That page opens the board it names, which is the drill-down: the main board
 * holds a page per pipeline, and clicking one takes you into that pipeline.
 *
 * `data-depth` rather than an inline margin, matching how the folder tree
 * expresses nesting — the indent is a styling decision and belongs in CSS.
 */
function BoardRowButton({
  board,
  current,
  onOpen,
}: {
  board: BoardRow
  current: string | null
  onOpen: (path: string) => void
}) {
  return (
    <button
      type="button"
      className="canvas-list-item"
      data-depth={board.depth}
      aria-current={board.path === current}
      title={board.path}
      onClick={() => onOpen(board.path)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CANVAS_DROP_MIME, board.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <Frame size={13} aria-hidden="true" />
      <span className="canvas-list-item-name">{board.name.replace(/\.canvas$/i, '')}</span>
    </button>
  )
}

export function CanvasList({ tree, current, onOpen, onCreated }: CanvasListProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boards = collectCanvases(tree)

  /**
   * Which boards each board links to, read from the boards themselves.
   *
   * The tree cannot be built from the file listing alone: a board's children
   * are the `.canvas` pages sitting ON it, which means every board has to be
   * read. That is a handful of small JSON files, done once per listing change.
   *
   * Keyed on the joined paths rather than the array, which is rebuilt on every
   * render by `collectCanvases` and would re-read the whole vault each time.
   */
  const [links, setLinks] = useState<Record<string, string[]>>({})
  const listing = boards.map((b) => b.path).join('\n')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, string[]> = {}
      for (const path of listing ? listing.split('\n') : []) {
        try {
          const body = await window.api.vault.read(path)
          next[path] = parseCanvas(body.text)
            .nodes.filter(
              (n) => n.type === 'file' && typeof n.file === 'string' && isCanvasPath(n.file),
            )
            .map((n) => n.file as string)
        } catch {
          // A board that will not read has no children as far as the tree is
          // concerned. It still appears; it just cannot nest anything.
          next[path] = []
        }
      }
      if (!cancelled) setLinks(next)
    })()
    return () => {
      cancelled = true
    }
    // `current` as well as `listing`: dropping a board onto another changes
    // which board is a CHILD without changing which boards EXIST, so the
    // listing alone would leave the tree showing the old shape. Re-read on
    // navigation, which is when the tree is next looked at.
    //
    // Not live: the tree still lags a link made on the board you are standing
    // on until you move off it. Closing that needs a save signal plumbed from
    // the board up to this list, which is more than this change is.
  }, [listing, current])

  const rows = boardTree(boards, links)
  // Split so the sidebar can head them separately. Everything the root reaches
  // is the pipeline; the rest are boards nothing links to yet.
  const linked = rows.filter((r) => r.reachable)
  const loose = rows.filter((r) => !r.reachable)

  /**
   * A free name at the vault root: `Canvas.canvas`, then `Canvas 2.canvas`.
   *
   * Chosen against the TREE rather than by attempting a save and catching the
   * conflict. save() with mtime 0 does refuse an existing file, so the
   * exception-driven version would also be correct, but it would write a
   * backup and a temp file on the way to finding that out.
   */
  const freeName = (): string => {
    const taken = new Set(boards.map((b) => b.path.toLowerCase()))
    if (!taken.has('canvas.canvas')) return 'Canvas.canvas'
    for (let i = 2; ; i++) {
      const name = `Canvas ${i}.canvas`
      if (!taken.has(name.toLowerCase())) return name
    }
  }

  const create = async () => {
    try {
      setBusy(true)
      setError(null)
      const path = freeName()
      // mtime 0 is the CREATE stamp (see vault.ts save()): it matches no file
      // on disk, so this refuses rather than overwrites if the name was taken
      // between reading the tree and here.
      await window.api.vault.save(path, serializeCanvas(emptyCanvas()), 0)
      onCreated()
      onOpen(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="canvas-list">
      <div className="canvas-list-head">
        <span className="canvas-list-title">Canvas</span>
        <button type="button" className="canvas-list-new" onClick={() => void create()} disabled={busy}>
          {busy ? 'Making…' : '+ New'}
        </button>
      </div>

      {error && <p className="canvas-list-empty">{error}</p>}

      {boards.length === 0 ? (
        <p className="canvas-list-empty">
          No canvases yet. A canvas is a board you arrange notes and text on. New
          ones are saved as <code>.canvas</code>, the same format Obsidian uses.
        </p>
      ) : (
        <div className="canvas-list-items">
          {linked.map((b) => (
            <BoardRowButton key={b.path} board={b} current={current} onOpen={onOpen} />
          ))}
          {loose.length > 0 && (
            <>
              {/* Boards the root cannot reach. Shown rather than hidden: a board
                  that vanished the moment nothing linked to it would be a file
                  on disk the app denied having. Drag one onto the main board and
                  it moves up into the tree above. */}
              <div className="canvas-list-subhead">
                {linked.length === 0 ? `No ${ROOT_BOARD} yet` : 'Not linked'}
              </div>
              {loose.map((b) => (
                <BoardRowButton key={b.path} board={b} current={current} onOpen={onOpen} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
