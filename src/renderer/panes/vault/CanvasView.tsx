import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FileText, Frame, Link2 } from 'lucide-react'
import {
  parseCanvas,
  serializeCanvas,
  emptyCanvas,
  fileNodeTitle,
  edgeAnchor,
  canvasId,
  NEW_TEXT_SIZE,
  type CanvasDoc,
  type CanvasNode,
} from '../../../shared/canvas.js'
import type { VaultTreeNode } from '../../../shared/ipc.js'
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

/** The midpoint of each side of a node's box, in world units. */
const SIDE_POINT = {
  top: (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y }),
  right: (n: CanvasNode) => ({ x: n.x + n.width, y: n.y + n.height / 2 }),
  bottom: (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y + n.height }),
  left: (n: CanvasNode) => ({ x: n.x, y: n.y + n.height / 2 }),
} as const

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
 */
const anchorOn = (
  node: CanvasNode,
  side: unknown,
  derived: { x: number; y: number },
): { x: number; y: number } => {
  const point = typeof side === 'string' ? SIDE_POINT[side as keyof typeof SIDE_POINT] : undefined
  return point ? point(node) : derived
}

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
   * The selected cards, by id. PURE UI — nothing here is ever written to the
   * file. JSON Canvas has no concept of selection, and inventing a key for it
   * would put this app's transient state into a document Obsidian also writes.
   */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

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
    // A pending endpoint is the sharpest case: picked on the old board, it
    // would pair with a click on the new one and write an edge whose source
    // does not exist in the file it lands in. Connect MODE is left alone —
    // that is a tool the user turned on, not state belonging to a file.
    setLinkFrom(null)

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
        Math.min((r.width - FIT_PAD * 2) / (maxX - minX), (r.height - FIT_PAD * 2) / (maxY - minY)),
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
  const persist = (d: CanvasDoc) => {
    if (!path) return
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

  // ── interaction ────────────────────────────────────────────────
  /** Pointer position and view offset at the moment a background pan began. */
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  /** The card being dragged, and where inside it the grab landed, in world units. */
  const drag = useRef<{
    node: CanvasNode
    dx: number
    dy: number
    moved: boolean
    /** True when this gesture created the node it is dragging (Alt+drag). */
    created: boolean
  } | null>(null)

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
  const addCard = () => {
    if (!doc || !wrapRef.current) return
    // Centre of the viewport, so a new card lands where the user is looking
    // rather than at the world origin they may have panned far away from.
    const r = wrapRef.current.getBoundingClientRect()
    const p = toWorld(r.left + r.width / 2, r.top + r.height / 2)
    const node: CanvasNode = {
      id: canvasId(),
      type: 'text',
      text: '',
      x: Math.round(p.x - NEW_TEXT_SIZE.width / 2),
      y: Math.round(p.y - NEW_TEXT_SIZE.height / 2),
      ...NEW_TEXT_SIZE,
    }
    doc.nodes.push(node)
    // Straight into editing: an empty card with no cursor in it gives the user
    // nothing to act on and reads as a card that failed to be created.
    setEditing(node.id)
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

  const onBackgroundDown = (e: React.PointerEvent) => {
    // Only a press on the board itself pans. A press that started on a card is
    // that card's drag, and it stops propagation below.
    if (e.button !== 0) return
    // A press on empty board clears the selection, which is the one gesture
    // everyone already expects to mean "never mind".
    setSelected(new Set())
    pan.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onNodeDown = (e: React.PointerEvent, node: CanvasNode) => {
    if (e.button !== 0) return
    // Without this the board pans at the same time as the card moves.
    e.stopPropagation()
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
              x: node.x + DUPLICATE_OFFSET,
              y: node.y + DUPLICATE_OFFSET,
            }
            doc.nodes.push(copy)
            repaint()
            return copy
          })()
        : node

    // Selection follows the press, so a card is selected before any drag of it
    // begins. The duplicate becomes the selection when there is one — you are
    // now working on the copy, not the card you copied.
    selectNode(target.id, e.shiftKey || e.ctrlKey || e.metaKey)

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
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const p = toWorld(e.clientX, e.clientY)
      drag.current.node.x = p.x - drag.current.dx
      drag.current.node.y = p.y - drag.current.dy
      drag.current.moved = true
      // The card itself moves without React. The re-render is only for the
      // EDGES, which are JSX and read their endpoints from the node geometry —
      // without it a connected card would slide out from under its own line.
      applyNode(drag.current.node)
      if (doc && doc.edges.length > 0) repaint()
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
    draggedLast.current = drag.current?.moved ?? false
    // Saving on RELEASE, not on every move: a drag emits a pointer event per
    // frame, and writing the file 60 times a second would take a backup copy
    // each time (save() backs up before overwrite) and fill .backups/ with a
    // hundred snapshots of one gesture.
    // `created` as well as `moved`: an Alt+press that never moved still added a
    // card to the doc, and leaving it unsaved would show a duplicate on screen
    // that vanishes on reload.
    if ((drag.current?.moved || drag.current?.created) && doc) void persist(doc)
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
        <button type="button" className="canvas-tool" onClick={addCard}>
          + Card
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
        onWheel={onWheel}
        data-tick={tick}
        data-connect={connect || undefined}
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
              const from = anchorOn(a, edge.fromSide, derived.from)
              const to = anchorOn(b, edge.toSide, derived.to)
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
              return (
                <g
                  key={edge.id}
                  /* Set on the GROUP so the line, its arrowheads (which fill
                     with context-stroke) and the label all inherit one value. */
                  ref={(el) => {
                    applyColor(el, edge.color)
                  }}
                >
                  <line
                    x1={from.x + EDGE_ORIGIN}
                    y1={from.y + EDGE_ORIGIN}
                    x2={to.x + EDGE_ORIGIN}
                    y2={to.y + EDGE_ORIGIN}
                    className="canvas-edge"
                    markerStart={
                      drawsArrow(edge.fromEnd, 'none') ? 'url(#canvas-arrow)' : undefined
                    }
                    markerEnd={drawsArrow(edge.toEnd, 'arrow') ? 'url(#canvas-arrow)' : undefined}
                  />
                  {label && (
                    // Midpoint of the drawn line, which is the stated anchors
                    // when the file gave them — so a hand-routed edge carries
                    // its label along the route the user actually chose.
                    <text
                      x={(from.x + to.x) / 2 + EDGE_ORIGIN}
                      y={(from.y + to.y) / 2 + EDGE_ORIGIN}
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
              data-linking={linkFrom === n.id || undefined}
              data-selected={selected.has(n.id) || undefined}
            >
              {n.type === 'file' && n.file ? (
                <button
                  type="button"
                  className="canvas-file"
                  title={n.file}
                  onClick={(e) => {
                    // A drag that ends on the card also fires a click. Without
                    // this, rearranging a board opens every card you touched.
                    // Connect mode is excluded for the same reason: picking a
                    // file card as an endpoint must not also leave the board.
                    if (connect || draggedLast.current) return
                    // A modifier press was a selection, not an open. Read off
                    // the click event rather than remembered from the
                    // pointerdown, because the browser already carries it and a
                    // second ref would be a second thing to keep in sync.
                    // Without this a file card could never join a
                    // multi-selection without navigating away from the board.
                    if (e.shiftKey || e.ctrlKey || e.metaKey) return
                    onOpenNote(n.file!)
                  }}
                >
                  <FileText size={13} aria-hidden="true" />
                  <span className="canvas-file-title">{fileNodeTitle(n.file)}</span>
                </button>
              ) : n.type === 'link' && n.url ? (
                // Rendered as its URL, deliberately not as a live link: this is
                // a renderer with node integration, and an <a> here would open
                // an arbitrary URL in the app's own window.
                <div className="canvas-link">
                  <Link2 size={13} aria-hidden="true" />
                  <span className="canvas-link-url">{String(n.url)}</span>
                </div>
              ) : n.type === 'group' ? (
                <span className="canvas-group-label">{n.label ?? ''}</span>
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
                  defaultValue={n.text ?? ''}
                  autoFocus
                  aria-label="Card text"
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
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
                <div
                  className="canvas-text"
                  onDoubleClick={() => {
                    // Only `text` nodes are editable. This branch is also the
                    // fallback for a node type from a later spec version, and
                    // turning one of those into an edited text card would
                    // destroy exactly what the preservation rule protects.
                    if (n.type === 'text') setEditing(n.id)
                  }}
                >
                  {n.text ?? ''}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="canvas-info">
        <span>{path.split('/').pop()}</span>
        <span className="canvas-info-sep">·</span>
        <span>
          {doc.nodes.length} card{doc.nodes.length === 1 ? '' : 's'}
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

export function CanvasList({ tree, current, onOpen, onCreated }: CanvasListProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boards = collectCanvases(tree)

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
          {boards.map((b) => (
            <button
              key={b.path}
              type="button"
              className="canvas-list-item"
              aria-current={b.path === current}
              title={b.path}
              onClick={() => onOpen(b.path)}
            >
              <Frame size={13} aria-hidden="true" />
              <span className="canvas-list-item-name">{b.name.replace(/\.canvas$/i, '')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
