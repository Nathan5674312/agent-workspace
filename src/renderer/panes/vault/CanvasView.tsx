import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FileText, Frame, Link2 } from 'lucide-react'
import {
  parseCanvas,
  serializeCanvas,
  emptyCanvas,
  fileNodeTitle,
  edgeAnchor,
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

export interface CanvasViewProps {
  /** Vault-relative `.canvas` path, or null when no board is open. */
  path: string | null
  /** Open a note in the editor. File cards are the only thing that calls it. */
  onOpenNote: (path: string) => void
}

export function CanvasView({ path, onOpenNote }: CanvasViewProps) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null)
  const [mtime, setMtime] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** Bumped to force a repaint after a mutation that React cannot see, because
   *  the drag writes THROUGH `doc` rather than replacing it. Replacing it would
   *  mean copying nodes, which is exactly what the preservation rule forbids. */
  const [tick, setTick] = useState(0)
  const repaint = useCallback(() => setTick((t) => t + 1), [])

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
    if (!path) {
      setDoc(null)
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
        setMtime(body.mtime)
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
  const persist = async (d: CanvasDoc) => {
    if (!path) return
    try {
      setSaving(true)
      const saved = await window.api.vault.save(path, serializeCanvas(d), mtime)
      setMtime(saved.mtime)
      setError(null)
    } catch (e) {
      // A SaveConflict here means the file changed under us, most likely
      // Obsidian. Surfaced rather than swallowed, because the alternative is a
      // board that silently stops persisting and looks like it is working.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // ── interaction ────────────────────────────────────────────────
  /** Pointer position and view offset at the moment a background pan began. */
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  /** The card being dragged, and where inside it the grab landed, in world units. */
  const drag = useRef<{ node: CanvasNode; dx: number; dy: number; moved: boolean } | null>(null)

  const toWorld = (clientX: number, clientY: number) => {
    const r = wrapRef.current!.getBoundingClientRect()
    const { tx, ty, k } = view.current
    return { x: (clientX - r.left - tx) / k, y: (clientY - r.top - ty) / k }
  }

  const onBackgroundDown = (e: React.PointerEvent) => {
    // Only a press on the board itself pans. A press that started on a card is
    // that card's drag, and it stops propagation below.
    if (e.button !== 0) return
    pan.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onNodeDown = (e: React.PointerEvent, node: CanvasNode) => {
    if (e.button !== 0) return
    // Without this the board pans at the same time as the card moves.
    e.stopPropagation()
    const p = toWorld(e.clientX, e.clientY)
    // The grab offset is kept so the card does not jump its centre to the
    // cursor on the first move — the same correction GraphView documents.
    drag.current = { node, dx: p.x - node.x, dy: p.y - node.y, moved: false }
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
    if (drag.current?.moved && doc) void persist(doc)
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
      <div
        className="canvas-surface"
        ref={wrapRef}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
        data-tick={tick}
      >
        {/* The transform is written by applyView(), never rendered. */}
        <div className="canvas-world" ref={worldRef}>
          {/* Edges are RENDERED but not yet authorable. A board made in
              Obsidian carries them, and drawing nothing where the file says
              there is a line would misreport the user's own work. The layer is
              sized in CSS and coordinates are shifted by EDGE_ORIGIN — see the
              constant for why the obvious zero-sized version paints nothing. */}
          <svg className="canvas-edges" aria-hidden="true">
            {doc.edges.map((edge) => {
              const a = byId.get(edge.fromNode)
              const b = byId.get(edge.toNode)
              // An edge naming a node that is not in the file is skipped rather
              // than crashing the board. Obsidian leaves these behind.
              if (!a || !b) return null
              const { from, to } = edgeAnchor(a, b)
              return (
                <line
                  key={edge.id}
                  x1={from.x + EDGE_ORIGIN}
                  y1={from.y + EDGE_ORIGIN}
                  x2={to.x + EDGE_ORIGIN}
                  y2={to.y + EDGE_ORIGIN}
                  className="canvas-edge"
                />
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
            >
              {n.type === 'file' && n.file ? (
                <button
                  type="button"
                  className="canvas-file"
                  title={n.file}
                  onClick={() => {
                    // A drag that ends on the card also fires a click. Without
                    // this, rearranging a board opens every card you touched.
                    if (!draggedLast.current) onOpenNote(n.file!)
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
              ) : (
                // Text cards show their markdown as written. Rendering it is
                // the Editor's job and it does not live here yet.
                <div className="canvas-text">{n.text ?? ''}</div>
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
