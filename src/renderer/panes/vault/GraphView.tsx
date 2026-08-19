import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3-force'
import type { VaultGraph } from '../../../shared/ipc.js'
import { resolvableLinks } from './helpers.js'
import { buildSimulation, radius, HOLD } from './graphPhysics.js'

/**
 * Does this node say its name at this zoom?
 *
 * Measured in APPARENT PIXELS, not in zoom level. A fixed `k` threshold cannot
 * work here: the view opens zoomed-to-fit, and what `k` that lands on depends
 * entirely on how big the vault is and how large the window is. Any constant
 * picked against one vault is wrong for the next.
 *
 * Screen radius is the honest signal, and it composes the way the eye does — a
 * hub is drawn larger, so it crosses the legibility threshold sooner and names
 * itself while the whole graph is still in frame. Leaves wait until you have
 * actually zoomed into their corner. That progressive reveal is what makes
 * Obsidian's graph read as a map instead of a decoration.
 *
 * 6px of radius is about where a dot stops being a speck and starts being a
 * thing worth naming.
 */
const LABEL_MIN_SCREEN_RADIUS = 9
import {
  Decay,
  Spring,
  VelocityTracker,
  project,
  rubberband,
  DRAG_THRESHOLD,
} from '../../motion.js'

/**
 * Graph view — force-directed map of the vault's wikilinks.
 *
 * Bugs this replaces, all of which made it look broken rather than sparse:
 *   - The canvas was measured ONCE on mount, before layout had settled, so it
 *     was sized to a stale box and the drawing was squashed into a corner.
 *     A ResizeObserver now owns sizing.
 *   - No devicePixelRatio scaling, so every line was soft on a HiDPI screen.
 *   - Canvas defaults to black fill/stroke. On a near-black ground the graph
 *     was drawing itself in a colour one step from the background.
 *   - Rendering only happened on simulation ticks, so once the layout cooled
 *     the canvas froze and could not respond to anything.
 *
 * Colours are read from the CSS custom properties rather than hardcoded, so
 * the graph themes with the rest of the app from one file.
 */
export interface GraphViewProps {
  graph: VaultGraph | null
  onOpenNote?: (path: string) => void
}

type Node = d3.SimulationNodeDatum & { id: string; label: string; degree: number }
type Link = { source: Node; target: Node }

const titleOf = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '')

export function GraphView({ graph, onOpenNote }: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hoverLabel, setHoverLabel] = useState<string | null>(null)

  /**
   * The open-note callback is held in a ref and kept OUT of the effect's
   * dependencies on purpose.
   *
   * The effect builds the entire force simulation. If `onOpenNote` were a
   * dependency, any caller passing an inline arrow — the natural way to write
   * it — would change its identity on every render, tear the simulation down
   * and rebuild it from scratch. The graph would visibly reset itself at
   * random. A ref makes the component correct regardless of how the parent
   * chooses to pass the callback, rather than relying on every caller to
   * remember to memoise.
   */
  const openRef = useRef(onOpenNote)
  openRef.current = onOpenNote

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!graph || !canvas || !wrap) return

    /**
     * Canvas cannot read CSS, so the tokens are resolved once here.
     *
     * The fallbacks are CSS SYSTEM COLOUR KEYWORDS, not literals. A hardcoded
     * hex here would be a second source of truth for the palette — exactly the
     * thing tokens.css exists to prevent — and it would silently paper over a
     * missing token instead of letting it show. `GrayText`/`CanvasText`/
     * `Highlight` come from the OS, so they stay theme-correct and they are
     * obviously not brand colours if one ever appears.
     */
    const css = getComputedStyle(canvas)
    const token = (name: string, fallback: string) =>
      css.getPropertyValue(name).trim() || fallback
    const COL = {
      link: token('--label-tertiary', 'GrayText'),
      node: token('--label-secondary', 'CanvasText'),
      near: token('--accent', 'CanvasText'),
      hot: token('--graph-focus', 'Highlight'),
      label: token('--label-secondary', 'CanvasText'),
      /** The window ground, for refilling the erased disc under each node. */
      ground: token('--bg-app', 'Canvas'),
    }

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

    /**
     * The halo sprite — one gradient disc, built once, blitted per node.
     *
     * The canvas is transparent and sits over the artwork layer
     * (`.vault-main::before`), so where a node lands on a busy part of the
     * drawing the two compete and the graph stops being readable. This paints
     * a soft pool of the window ground under each node: the artwork is pushed
     * back locally and stays fully visible between nodes.
     *
     * WHY A SPRITE. `createRadialGradient` per node per frame is the obvious
     * version and it is measurably worse — `bench/halo/` times it at 0.71ms a
     * frame against 0.37ms for this, for identical output, over 250 nodes and
     * 850 links in Electron's own Chromium. Neither threatens the 16.7ms
     * budget, so this is not a rescue; it is the same picture for half the
     * cost, and the cost scales with node count while the sprite does not.
     *
     * The stops carry no alpha values because they do not need to: `transparent`
     * is a keyword, so the falloff is expressed without an `rgba()` literal —
     * which this pane forbids (review-s2). Ink is near-black, so interpolating
     * its RGB toward zero as alpha falls is invisible.
     *
     * THE THREE NUMBERS BELOW WERE PICKED FROM RENDERED OUTPUT, not by feel.
     * `bench/halo/variants.cjs` composites the real stack — artwork at 16%
     * under the Ink scrim — and paints the same scene four ways over the
     * busiest part of the drawing, including a no-halo control. What that
     * showed:
     *
     *   - A flat opaque core (any value) is the sticker. It puts a plateau in
     *     the middle of the falloff, and on an isolated node that plateau
     *     reads as a distinct dark disc. There is no core now; the gradient
     *     runs from the centre out, and the node's own opaque disc covers the
     *     strongest part of it anyway.
     *   - At full alpha the pools are still blobby around isolated nodes.
     *   - Below ~0.65 the effect is nearly indistinguishable from no halo at
     *     all, which fails the legibility half of the task.
     */
    const HALO_SCALE = 3.2 // outer radius, in node radii
    const HALO_ALPHA = 0.8 // peak, at the centre
    const SPRITE_PX = 128
    const halo = document.createElement('canvas')
    halo.width = SPRITE_PX
    halo.height = SPRITE_PX
    {
      const hx = halo.getContext('2d')
      if (hx) {
        const c = SPRITE_PX / 2
        const g = hx.createRadialGradient(c, c, 0, c, c, c)
        const ink = token('--bg-app', 'Canvas')
        g.addColorStop(0, ink)
        g.addColorStop(1, 'transparent')
        hx.fillStyle = g
        hx.fillRect(0, 0, SPRITE_PX, SPRITE_PX)
      }
    }

    // Degree drives node size — the same signal Obsidian uses. A hub should
    // look like a hub without being clicked.
    const degree = new Map<string, number>()
    for (const l of graph.links) {
      degree.set(l.from, (degree.get(l.from) ?? 0) + 1)
      degree.set(l.to, (degree.get(l.to) ?? 0) + 1)
    }

    const nodes: Node[] = graph.nodes.map((id) => ({
      id,
      label: titleOf(id),
      degree: degree.get(id) ?? 0,
    }))
    // Dangling edges are dropped before d3 sees them: forceLink throws on an
    // unresolvable endpoint, synchronously, inside this effect.
    const links = resolvableLinks(graph.nodes, graph.links) as unknown as Link[]

    let w = 0
    let h = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    /**
     * These two are declared HERE, above `buildSimulation`, and it matters.
     *
     * `forceLink.distance()` and `.strength()` are not lazy: d3 evaluates the
     * accessor over every link the moment you set it, and caches the result.
     * So the getters handed to `buildSimulation` fire DURING that call, not on
     * the first tick — which means a `let dragging` declared after it is still
     * in its temporal dead zone and the whole pane dies with "Cannot access
     * 'dragging' before initialization".
     *
     * `adjacency` is created empty here and filled further down, after
     * forceLink has rewritten each link's source/target from id strings to node
     * references. Same Map object either way, so the getter stays correct.
     */
    let dragging: Node | null = null
    const adjacency = new Map<string, Node[]>()

    /**
     * The layout itself lives in `graphPhysics.ts`.
     *
     * It is a separate module for one reason: `bench/orbit.mjs` measures the
     * hold behaviour headlessly, and it has to measure THIS simulation rather
     * than a second copy written to match. The hold was tuned by eye twice and
     * shipped wrong twice; the third attempt was measured, and a measurement
     * against a re-implementation would have been worth nothing.
     *
     * `dragging` and `adjacency` are read through getters so the physics never
     * learns what a pointer is, and this file stays the only place that knows.
     */
    const { sim, setHolding } = buildSimulation(
      nodes,
      links,
      () => dragging,
      () => adjacency,
    )


    // View transform. Pan/zoom is hand-rolled rather than pulling in d3-zoom
    // for ~30 lines of wheel and pointer maths.
    let k = 1
    let tx = 0
    let ty = 0
    const toGraph = (px: number, py: number) => ({ x: (px - tx) / k, y: (py - ty) / k })

    let hover: Node | null = null
    let neighbours = new Set<string>()
    // Distinguishes a click from a drag that happened to end on a node.
    //
    // This is a HYSTERESIS, not a flag on any movement. It used to be set by a
    // single pixel of pointermove, so a press with the slightest tremor in it
    // was classified as a drag and `onClick` bailed — the note simply did not
    // open, with no feedback of any kind. A press that fails silently is worse
    // than one that fails loudly, and on a trackpad it happened constantly.
    let moved = false
    let downAt: { x: number; y: number } | null = null

    /**
     * The node under a live press.
     *
     * Feedback belongs on pointer-DOWN, not on release: the moment a press
     * produces nothing until you let go, directness "falls off a cliff". The
     * canvas had no press state at all — a node looked identical held and
     * untouched, so there was no way to tell whether the app had heard you.
     */
    let pressed: Node | null = null

    /** Where inside the node it was grabbed, in graph units. See `onMove`. */
    let grabOffset = { x: 0, y: 0 }

    // Momentum. The pan used to stop dead the instant the pointer lifted, so a
    // flick did nothing at all and the graph could only be moved by dragging it
    // the whole way — the exact seam between dragging and animating that
    // velocity handoff exists to remove.
    const panVelocity = new VelocityTracker()
    const glide = new Decay()
    const settleX = new Spring()
    const settleY = new Spring()
    const settleK = new Spring()

    /** Every animation the user can interrupt by touching the canvas. */
    const stopMotion = () => {
      glide.stop()
      settleX.stop()
      settleY.stop()
      settleK.stop()
    }

    /**
     * How far the view may be pushed before it is considered out of bounds.
     *
     * There were no pan bounds whatsoever: the graph could be thrown off screen
     * in any direction and nothing brought it back, so the only recovery was to
     * leave the tab and return. The rule is deliberately loose — the graph must
     * merely OVERLAP the viewport by a margin, not be centred — because
     * clamping tightly would fight someone deliberately inspecting one edge.
     */
    const MARGIN = 80
    /**
     * The correction that would bring a candidate pan back inside bounds.
     *
     * Takes the candidate rather than reading `tx`/`ty` so the drag can ask
     * "where would this put me" before committing to it — which is what lets
     * the resistance be computed from total displacement past the edge instead
     * of from a single frame's delta.
     */
    const overshootAt = (candTx: number, candTy: number) => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue
        minX = Math.min(minX, n.x)
        maxX = Math.max(maxX, n.x)
        minY = Math.min(minY, n.y)
        maxY = Math.max(maxY, n.y)
      }
      if (!Number.isFinite(minX)) return { x: 0, y: 0 }
      // Content box in screen space.
      const left = minX * k + candTx
      const right = maxX * k + candTx
      const top = minY * k + candTy
      const bottom = maxY * k + candTy
      return {
        x: right < MARGIN ? MARGIN - right : left > w - MARGIN ? w - MARGIN - left : 0,
        y: bottom < MARGIN ? MARGIN - bottom : top > h - MARGIN ? h - MARGIN - top : 0,
      }
    }
    const panOvershoot = () => overshootAt(tx, ty)

    /**
     * Adjacency, built once.
     *
     * Built AFTER the simulation, because forceLink rewrites each link's
     * `source`/`target` from id strings to node references when the force is
     * added — reading them before that point gives strings.
     *
     * It holds node references rather than ids because the drag force needs
     * the positions, and it replaces a full scan of `links` on every hover.
     */
    const connect = (from: Node, to: Node) => {
      const list = adjacency.get(from.id)
      if (list) list.push(to)
      else adjacency.set(from.id, [to])
    }
    for (const l of links) {
      connect(l.source, l.target)
      connect(l.target, l.source)
    }

    const recomputeNeighbours = () => {
      neighbours = new Set((hover ? (adjacency.get(hover.id) ?? []) : []).map((n) => n.id))
    }

    /**
     * Hold a node and its neighbourhood eases out to a ring around it.
     *
     * The mechanism and every tuning value now live in `graphPhysics.ts`, next
     * to the harness that measured them. `setHolding` re-sets the link
     * accessors (forceLink caches them, so re-setting IS the refresh) and
     * swaps velocity damping in one call. O(links), twice per gesture, never
     * per tick.
     */

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.translate(tx, ty)
      ctx.scale(k, k)

      const dim = hover !== null

      /**
       * A held node reads as LIFTED — it grows toward the finger.
       *
       * Intermediate states should point at the outcome, and the outcome of
       * holding a node is picking it up. A shrink would be right for a button,
       * which is a surface you push into; this is an object you take hold of,
       * and the two want opposite signs.
       */
      const drawRadius = (n: Node) => radius(n) * (pressed?.id === n.id ? 1.35 : 1)

      /**
       * The halos, FIRST — before the links, not after the erase.
       *
       * They were painted last, between the erase and the nodes, and that put
       * a 3.2x-radius pool of near-opaque ground on top of every link END. A
       * leaf node's halo reaches ~15.5 units against a 52-unit rest length, so
       * roughly 60% of a typical link sat under it; and `forceCollide` lets
       * node centres sit ~22 units apart, which is inside BOTH halos, so links
       * inside a dense cluster disappeared completely and connected notes read
       * as unconnected dots — exactly where the structure is worth seeing.
       *
       * Painting first fixes that: the halo quietens the ARTWORK, which is all
       * it was ever for, and the links then draw over it at full strength. The
       * hairline gap the erase leaves is refilled with ground below, so moving
       * this up costs nothing it was previously buying.
       *
       * Alpha is deliberately NOT modulated by hover, unlike the nodes and
       * links. Dimming halos with their nodes would let the artwork surge back
       * across the canvas the instant the pointer touched anything and recede
       * when it left — a flash of background on every hover. Quieting the
       * artwork is a property of where the nodes ARE, not of which one is
       * under the cursor, so it holds still.
       */
      ctx.globalAlpha = HALO_ALPHA
      for (const n of nodes) {
        const R = drawRadius(n) * HALO_SCALE
        ctx.drawImage(halo, n.x! - R, n.y! - R, R * 2, R * 2)
      }

      /**
       * Links are STRUCTURE, not decoration.
       *
       * They used to draw as `--label-quaternary` at 0.16 alpha — the dimmest
       * entry in the palette, which tokens.css marks "decorative ONLY", at a
       * sixth of its opacity. On Ink that is very nearly invisible, so the
       * graph read as scattered dots rather than a network: the nodes were at
       * full opacity and the edges between them were not there.
       *
       * One step up the ramp (Clay, 5.0:1) and a little over twice the alpha.
       * Emphasis in this palette comes from luminance rather than hue, so this
       * is the lever the design system actually provides. The hover states are
       * untouched — a lit edge is still `--accent` at 0.95, and it still reads
       * as clearly lit because the resting state is a contrast BELOW it rather
       * than a near-absence.
       */
      for (const l of links) {
        const lit = dim && (l.source.id === hover!.id || l.target.id === hover!.id)
        /**
         * Dimmed edges are DRAWN, faintly, not skipped.
         *
         * They used to `continue`, which is cheaper but means the graph does
         * not recede on hover so much as partly vanish: the structure you were
         * orienting by disappears the instant you point at something, and you
         * lose the sense of where in the vault the highlighted neighbourhood
         * actually sits. Obsidian keeps its unhighlighted web visible behind
         * the highlight, and that residue is what makes the focus read as a
         * spotlight rather than a deletion.
         *
         * 0.07 against a resting 0.4 — present enough to hold the shape, far
         * enough below the lit 0.95 that nothing competes with the answer.
         */
        ctx.strokeStyle = lit ? COL.hot : COL.link
        ctx.globalAlpha = lit ? 0.95 : dim ? 0.07 : 0.4
        // A lit edge is the thing being traced, so it also gets weight. At one
        // width the highlight relied on colour alone and thin Cream on Ink is
        // easy to lose against a dense cluster behind it.
        ctx.lineWidth = (lit ? 1.6 : 0.9) / k
        ctx.beginPath()
        ctx.moveTo(l.source.x!, l.source.y!)
        ctx.lineTo(l.target.x!, l.target.y!)
        ctx.stroke()
      }

      /**
       * Punch the link layer out from under every node BEFORE drawing them.
       *
       * `--label-secondary` is `rgba(235,235,245,0.6)` — Apple's label ramp is
       * opacity, not different greys — so a node disc is translucent, and
       * every link was visibly running straight through the circle it ends in.
       * Drawing links first was never enough; they have to be removed.
       *
       * `destination-out` erases instead of painting a background-coloured
       * disc over the top, which keeps this correct no matter what the pane
       * behind the canvas is filled with (it is a material, not a flat
       * colour). The extra 1.5px leaves the hairline gap between line and
       * circle that makes the graph read as Obsidian's does.
       *
       * The fill must be OPAQUE. `destination-out` removes the source's alpha,
       * not its colour, and the label pass at the end of the previous frame
       * leaves `fillStyle` on the translucent `--label-secondary` — so this
       * erased only 60% of each link and the rest went on showing through the
       * circle.
       *
       * `CanvasText` rather than a hex: only the alpha matters to an erase, and
       * a hex literal here is a palette entry as far as this pane's no-colours
       * rule is concerned (test/review-s2-vault-pane.test.mjs). The system
       * colour keywords are the same idiom the token fallbacks above use.
       */
      ctx.globalCompositeOperation = 'destination-out'
      ctx.fillStyle = 'CanvasText'
      ctx.globalAlpha = 1
      for (const n of nodes) {
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, drawRadius(n) + 1.5 / k, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      /**
       * Refill the erased disc with ground.
       *
       * The erase above removes everything within `radius + 1.5` — including
       * the halo — so without this the hairline gap between a link and the
       * circle it ends in shows bare artwork through it, which is the
       * hard-edged sticker look the halo exists to avoid. This is what the old
       * ordering bought by painting the halo last, kept here at the erase's own
       * radius so it fills the gap without reaching the links.
       */
      ctx.globalAlpha = HALO_ALPHA
      ctx.fillStyle = COL.ground
      for (const n of nodes) {
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, drawRadius(n) + 1.5 / k, 0, Math.PI * 2)
        ctx.fill()
      }

      /**
       * THREE tiers on hover, not two.
       *
       * This used to be lit-or-dim: the hovered node went to `--accent` and
       * everything else it touched stayed exactly the colour it already was. So
       * the neighbourhood you were asking about looked identical to the graph
       * you were ignoring, and the answer to "what is this connected to" was
       * carried entirely by what had FADED rather than by what had lit up.
       *
       *   focus       --accent  (Cream)  the node under the cursor
       *   neighbour   --label   (Sand)   one step down, still clearly present
       *   rest        --label-secondary at 0.09, effectively gone
       *
       * All three tiers are LUMINANCE, no hue anywhere — which is what §4b said
       * to do, and the reason the earlier accent-hue experiments were a detour.
       *
       * The problem was never that the ramp lacked range. It was that the ramp
       * stopped at Cream and the focus was already spending it, so neighbours
       * had nothing left above them and sat at the same tone as the graph you
       * were ignoring. Adding one rung ABOVE Cream fixes it without a hue:
       * white takes the focus, Cream drops to the neighbourhood, and the tiers
       * separate on brightness alone.
       */
      for (const n of nodes) {
        const focus = n.id === hover?.id || pressed?.id === n.id
        const near = dim && neighbours.has(n.id)
        const lit = !dim || focus || near
        ctx.globalAlpha = lit ? 1 : 0.09
        ctx.fillStyle = focus ? COL.hot : near ? COL.near : COL.node
        ctx.beginPath()
        ctx.arc(n.x!, n.y!, drawRadius(n), 0, Math.PI * 2)
        ctx.fill()
      }

      // Labels only appear once there is room for them. Drawing 252 of them at
      // low zoom is unreadable noise and costs a full text layout per frame.
      //
      // On hover this draws EXACTLY ONE label — the node under the cursor.
      // It previously also labelled every neighbour, so hovering a hub with
      // fifty links painted fifty overlapping names and buried the one you
      // were actually pointing at. The neighbours are already identified by
      // being lit while everything else dims; they do not also need naming.
      ctx.globalAlpha = 1
      ctx.textAlign = 'center'
      if (hover) {
        // The one name you asked for, so it is allowed to be the brightest
        // thing on the canvas. At `--label-secondary` and 11px it read as just
        // another label while the node under it had gone to `--accent`.
        ctx.fillStyle = COL.hot
        ctx.font = `${13 / k}px ${css.fontFamily}`
        ctx.fillText(hover.label, hover.x!, hover.y! - radius(hover) - 6 / k)
      } else {
        ctx.fillStyle = COL.label
        ctx.font = `${11 / k}px ${css.fontFamily}`
        // Progressive, by degree — see `labelZoom`. Hubs name themselves while
        // the whole graph is still in frame; leaves wait until you are actually
        // reading that corner of it.
        for (const n of nodes) {
          if (radius(n) * k < LABEL_MIN_SCREEN_RADIUS) continue
          ctx.fillText(n.label, n.x!, n.y! - radius(n) - 4 / k)
        }
      }
      ctx.globalAlpha = 1
    }

    /**
     * Zoom-to-fit, once, after the layout stops moving.
     *
     * With repulsion dominant the graph is physically larger than the canvas,
     * so without this you open the tab looking at the middle of a hairball at
     * 1:1 and have to scroll out to find the shape. Obsidian frames the whole
     * graph on open; so does this.
     *
     * `fitted` latches on the first user interaction — auto-framing a view the
     * user has just panned or zoomed would feel like the app fighting them.
     */
    let fitted = false
    const fit = () => {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue
        const r = radius(n)
        minX = Math.min(minX, n.x - r)
        maxX = Math.max(maxX, n.x + r)
        minY = Math.min(minY, n.y - r)
        maxY = Math.max(maxY, n.y + r)
      }
      if (!Number.isFinite(minX) || maxX === minX || maxY === minY) return
      const pad = 32
      k = Math.min(
        (w - pad * 2) / (maxX - minX),
        (h - pad * 2) / (maxY - minY),
      )
      k = Math.min(2, Math.max(0.08, k))
      tx = w / 2 - ((minX + maxX) / 2) * k
      ty = h / 2 - ((minY + maxY) / 2) * k
    }

    /**
     * One rAF loop, painting ON DEMAND.
     *
     * It used to call `draw()` unconditionally on every frame, forever. Once
     * the layout cools nothing on screen changes, but the canvas still stroked
     * 845 links, filled 252 arcs twice and flipped compositing mode 60 times a
     * second for as long as the tab was open — a fan spinning up for a still
     * image. The original reason for the unconditional loop was that painting
     * only on simulation ticks froze the canvas against hover and pan; the
     * answer to that is to paint on demand, not to paint always.
     *
     * `invalidate()` is the single entry point: every interaction that changes
     * what should be on screen calls it, and the simulation being warm counts
     * as continuously invalid.
     */
    let raf = 0
    let dirty = true
    const invalidate = () => {
      dirty = true
    }
    const loop = () => {
      if (!fitted && sim.alpha() < 0.06) {
        fit()
        fitted = true
        invalidate()
      }
      // Stands in for the wheel-release event the platform does not send.
      if (lastWheel && performance.now() - lastWheel > WHEEL_IDLE_MS) {
        lastWheel = 0
        settleZoom()
      }
      // A warm simulation moves nodes every tick, so it is always dirty. Under
      // reduced motion the simulation is stopped and its alpha is frozen at
      // whatever the manual ticks left it at, so it must not be consulted —
      // there, `dirty` is the only thing that may cause a repaint.
      if (dirty || (!reduced && sim.alpha() > sim.alphaMin())) {
        draw()
        dirty = false
      }
      raf = requestAnimationFrame(loop)
    }

    const resize = () => {
      const r = wrap.getBoundingClientRect()
      w = r.width
      h = r.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      // Forces pull toward the origin, so centring is a transform, not a force.
      tx = w / 2
      ty = h / 2
      // Resizing clears the backing store, so the canvas is blank until repaint.
      invalidate()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(wrap)
    resize()

    if (reduced) {
      // Motion here is incidental, not informational: run the layout to rest
      // synchronously and paint the settled result.
      sim.stop()
      for (let i = 0; i < 300; i++) sim.tick()
      fit()
      fitted = true
      invalidate()
    }
    // The loop runs in BOTH modes now that it paints on demand. Under reduced
    // motion it sits idle until an interaction invalidates — which is what makes
    // hover and pan work there at all; they used to call `draw()` directly.
    raf = requestAnimationFrame(loop)

    // ── interaction ────────────────────────────────────────────
    const pick = (e: PointerEvent): Node | null => {
      const r = canvas.getBoundingClientRect()
      const p = toGraph(e.clientX - r.left, e.clientY - r.top)
      let best: Node | null = null
      let bestD = Infinity
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y)
        if (d < radius(n) + 6 / k && d < bestD) {
          best = n
          bestD = d
        }
      }
      return best
    }

    const onMove = (e: PointerEvent) => {
      if (dragging) {
        const r = canvas.getBoundingClientRect()
        const p = toGraph(e.clientX - r.left, e.clientY - r.top)
        /**
         * The grab offset is preserved.
         *
         * Without it the node's centre jumped to the cursor on the first
         * move — grab a big hub near its edge and it visibly teleported before
         * it started following. Touch and content have to move together from
         * the first frame, which means tracking where the node was picked up
         * relative to the pointer, not re-centring it on the pointer.
         */
        // 1:1 with the pointer. NOTHING else happens here.
        //
        // This used to call `sim.alphaTarget(0.25).restart()` on every single
        // move, which held the whole simulation at high energy for the entire
        // drag — so the entire graph re-formed around the cursor instead of
        // one node following it. The reheat belongs on press, once.
        dragging.fx = p.x - grabOffset.x
        dragging.fy = p.y - grabOffset.y
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_THRESHOLD) {
          moved = true
        }
        return
      }
      const hit = pick(e)
      if (hit?.id !== hover?.id) {
        hover = hit
        recomputeNeighbours()
        setHoverLabel(hit ? hit.label : null)
        canvas.style.cursor = hit ? 'pointer' : 'grab'
        invalidate()
      }
    }

    const onDown = (e: PointerEvent) => {
      // Interruptibility. A press must take the view over from wherever it
      // visually IS this frame — never wait for a glide to finish first, and
      // never snap to where the glide was headed. Both read as the app
      // ignoring you for a moment.
      stopMotion()
      const hit = pick(e)
      moved = false
      downAt = { x: e.clientX, y: e.clientY }
      panVelocity.clear()
      panVelocity.add(e.clientX, e.clientY)
      // Felt before anything moves, and before the release decides anything.
      pressed = hit
      if (hit) invalidate()
      if (hit) {
        dragging = hit
        const r = canvas.getBoundingClientRect()
        const p = toGraph(e.clientX - r.left, e.clientY - r.top)
        grabOffset = { x: p.x - hit.x!, y: p.y - hit.y! }
        hit.fx = hit.x
        hit.fy = hit.y
        // Re-set the link accessors AND raise velocity damping for the hold.
        setHolding(true)
        // Reheat ONCE, and hold it warm for the duration of the drag. This is
        // `alphaTarget`, not `alpha` — it sets the energy the simulation is
        // driven toward, so neighbours keep responding while you pull without
        // the timer being reset every frame. That reset was the original bug.
        //
        // 0.45 rather than 0.2: at 0.2 the graph was technically live but the
        // response was too small to read as the cluster following your hand.
        // The reach is bounded by `orbit` touching only direct neighbours and
        // by charge's distanceMax, not by keeping the energy low, so the far
        // side of a 252-node graph still stays put at this alpha.
        fitted = true
        sim.alphaTarget(HOLD.alpha).restart()
        canvas.setPointerCapture(e.pointerId)
      } else {
        panning = { x: e.clientX, y: e.clientY }
        // Captured AFTER stopMotion(), so a pan that interrupts a glide
        // anchors to where the view actually is on screen rather than to
        // wherever the glide was headed.
        panAnchor = { x: e.clientX, y: e.clientY, tx, ty }
        fitted = true
        canvas.setPointerCapture(e.pointerId)
        canvas.style.cursor = 'grabbing'
      }
    }

    let panning: { x: number; y: number } | null = null
    /** Pointer position and view offset at the moment the pan began. */
    let panAnchor = { x: 0, y: 0, tx: 0, ty: 0 }
    const onPan = (e: PointerEvent) => {
      if (!panning) return
      panVelocity.add(e.clientX, e.clientY)

      /**
       * Resistance is computed from TOTAL displacement past the edge, not from
       * this frame's delta.
       *
       * Damping each increment separately compounds: the same gesture resists
       * differently depending on how many pointer events the OS happened to
       * deliver, so a fast drag and a slow drag over identical distance end up
       * in different places. Anchoring to where the gesture started makes the
       * curve a function of the hand's position and nothing else, which is
       * what `rubberband` is shaped for — the pointer stays glued to the
       * content in bounds and decouples smoothly and repeatably outside them.
       */
      const rawTx = panAnchor.tx + (e.clientX - panAnchor.x)
      const rawTy = panAnchor.ty + (e.clientY - panAnchor.y)
      const over = overshootAt(rawTx, rawTy)
      // The nearest position that is still legal, and how far past it the hand
      // has actually travelled.
      const excessX = -over.x
      const excessY = -over.y
      tx = rawTx + over.x + Math.sign(excessX) * rubberband(Math.abs(excessX), w)
      ty = rawTy + over.y + Math.sign(excessY) * rubberband(Math.abs(excessY), h)

      panning = { x: e.clientX, y: e.clientY }
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_THRESHOLD) {
        moved = true
      }
      invalidate()
    }

    const onUp = (e: PointerEvent) => {
      if (dragging) {
        // Release the pin so the forces reclaim the node. Keeping fx/fy here
        // left every dragged node permanently outside the simulation — you
        // could scatter the graph by hand and nothing ever pulled back, which
        // is the opposite of what a force layout is for. It settles into the
        // neighbourhood you dropped it in rather than snapping home, because
        // its neighbours have already moved to meet it during the drag.
        dragging.fx = null
        dragging.fy = null
        dragging = null
        setHolding(false) // ordinary rest lengths and damping again
        sim.alphaTarget(0) // stop driving; let it coast to rest
      }
      const wasPanning = panning !== null
      panning = null
      pressed = null
      downAt = null
      canvas.style.cursor = 'grab'
      canvas.releasePointerCapture?.(e.pointerId)
      invalidate() // the lift has to be released even if nothing else moves

      if (wasPanning && !reduced) {
        /**
         * The seam between dragging and animating.
         *
         * The glide continues at the finger's exact release velocity, so there
         * is no moment where the content stops and a separate animation
         * starts. `project()` is what tells us the flick is worth honouring at
         * all: below a few pixels of predicted travel this was a tap that
         * wobbled, and gliding on it would feel like drift.
         */
        const { vx, vy } = panVelocity.velocity()
        if (Math.hypot(project(vx), project(vy)) > 12) {
          glide.start(
            vx,
            vy,
            (dx, dy) => {
              // Past the edge the glide is damped hard rather than clamped, so
              // a throw decelerates into the boundary instead of hitting a wall.
              const over = panOvershoot()
              tx += over.x !== 0 && Math.sign(dx) === -Math.sign(over.x) ? dx * 0.25 : dx
              ty += over.y !== 0 && Math.sign(dy) === -Math.sign(over.y) ? dy * 0.25 : dy
              invalidate()
            },
            settleInBounds,
          )
          return
        }
      }
      settleInBounds()
    }

    /**
     * Return the view to a legal position after a gesture that left it outside
     * one, critically damped so it does not overshoot.
     *
     * A correction that bounces reads as a bug. Bounce is earned by momentum
     * the user supplied, and nobody threw this — the view is coming back from
     * somewhere it was never allowed to be.
     */
    function settleInBounds() {
      const over = panOvershoot()
      if (over.x === 0 && over.y === 0) return
      if (reduced) {
        tx += over.x
        ty += over.y
        invalidate()
        return
      }
      if (over.x !== 0) {
        settleX.start(tx, tx + over.x, (v) => {
          tx = v
          invalidate()
        })
      }
      if (over.y !== 0) {
        settleY.start(ty, ty + over.y, (v) => {
          ty = v
          invalidate()
        })
      }
    }

    const onClick = (e: MouseEvent) => {
      // A drag ends with a click event on the same element. Without this, every
      // node you repositioned also opened itself in the editor.
      if (moved) return
      const open = openRef.current
      if (!open) return
      const r = canvas.getBoundingClientRect()
      const p = toGraph(e.clientX - r.left, e.clientY - r.top)
      for (const n of nodes) {
        if (Math.hypot(n.x! - p.x, n.y! - p.y) < radius(n) + 6 / k) {
          open(n.id)
          return
        }
      }
    }

    // Soft limits. Past these the zoom still moves, just reluctantly, and
    // springs back on release — a hard clamp at the end of a pinch reads as the
    // app having frozen mid-gesture.
    const K_MIN = 0.05
    const K_MAX = 6
    /**
     * The wheel has no release event, so idleness stands in for one — measured
     * on the FRAME CLOCK, not a timer.
     *
     * This pane holds no timers by design (test/review-s2-vault-pane.test.mjs):
     * a `setTimeout` here outlives unmount, fires against a closure over a
     * canvas that has left the document, and is invisible to the one rAF loop
     * that already owns every repaint. The loop is running anyway and is
     * display-synced, so it is both the correct clock and the free one.
     */
    let lastWheel = 0
    const WHEEL_IDLE_MS = 90

    /** Ease the zoom back inside its limits once the wheel goes quiet. */
    function settleZoom() {
      const target = Math.min(K_MAX, Math.max(K_MIN, k))
      if (target === k) return
      if (reduced) {
        k = target
        invalidate()
        return
      }
      /**
       * Anchored to the viewport CENTRE, not the last cursor position.
       *
       * The pointer has moved on by the time this runs — possibly off the
       * canvas entirely — and zooming back around a stale cursor slides the
       * content sideways for a reason the user cannot see. The centre is the
       * one anchor that is still true when the gesture is over.
       */
      const cx = w / 2
      const cy = h / 2
      const anchor = toGraph(cx, cy)
      settleK.start(k, target, (v) => {
        k = v
        tx = cx - anchor.x * k
        ty = cy - anchor.y * k
        invalidate()
      })
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      stopMotion()
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const before = toGraph(mx, my)
      fitted = true

      let next = k * Math.pow(0.999, e.deltaY)
      /**
       * Resistance is applied in LOG space.
       *
       * Zoom is multiplicative — 0.5 and 2 are the same distance from 1 — so
       * damping the raw ratio makes the resistance lopsided, stiff zooming out
       * and loose zooming in. Damping the exponent keeps both edges feeling
       * identical.
       */
      if (next < K_MIN) {
        const over = Math.log(K_MIN / next)
        next = K_MIN / Math.exp(rubberband(over, 1.6))
      } else if (next > K_MAX) {
        const over = Math.log(next / K_MAX)
        next = K_MAX * Math.exp(rubberband(over, 1.6))
      }
      k = next

      lastWheel = performance.now()
      // Keep the point under the cursor fixed — zoom toward the pointer, not
      // toward the centre, or the view runs away from whatever you aimed at.
      tx = mx - before.x * k
      ty = my - before.y * k
      invalidate()
    }

    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointermove', onPan)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.style.cursor = 'grab'

    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      // A glide or a settle outlives the component otherwise: both hold a rAF
      // and a closure over `tx`/`ty`, so an unmount mid-flick leaks a frame
      // loop that writes to a canvas that is no longer in the document.
      stopMotion()
      sim.stop()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointermove', onPan)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [graph])

  if (!graph) return <div className="vault-graph-empty">No graph data</div>

  return (
    <div className="vault-graph-view" ref={wrapRef}>
      <canvas ref={canvasRef} className="vault-graph-canvas" />
      <div className="vault-graph-info">
        {hoverLabel ?? `${graph.nodes.length} notes, ${graph.links.length} links`}
      </div>
    </div>
  )
}
