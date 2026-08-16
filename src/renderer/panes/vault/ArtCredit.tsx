import { useEffect, useRef, useState } from 'react'

/**
 * Attribution for the canvas artwork.
 *
 * The artwork sits at 16% opacity under a scrim, which is the right treatment
 * for texture and a terrible one for a painting: it strips the colour, crushes
 * the detail, and leaves the piece anonymous. This is what stops it being
 * anonymous. The work has an author, she is named on the screen it lives on,
 * and the name is a link to where the rest of her work is.
 *
 * Quiet at rest, on purpose. It sits at --label-quaternary (Taupe), which the
 * palette rules allow ONLY for decorative use and never for body text — a
 * credit that is legible without being sought is a watermark, and a watermark
 * competes with the notes. Hover brings it up to Clay and reveals the handle.
 *
 * Renders NOTHING until `ARTWORK.artist` is filled in. A credit with no artist
 * is worse than no credit, and an empty string is the honest default while the
 * real values are still with the artist.
 */

/**
 * The one place to edit. Fill these in and the credit appears; blank the artist
 * and it disappears, along with the artwork it describes.
 *
 * `instagram` is the handle WITHOUT the leading @ — the @ is added on render so
 * it cannot end up doubled in the URL.
 */
export const ARTWORK = {
  /**
   * How she wants to be credited. Blank = the credit does not render.
   *
   * INFERRED from the Instagram handle, not supplied — correct it if she wants
   * a surname, a different spelling, or just the signature and no name at all.
   */
  artist: 'Valentina',
  /**
   * Instagram handle, no @ and no query string. The share link came with
   * `?igsh=…`, which is a tracking parameter identifying who shared it; it is
   * dropped here rather than carried into the app.
   */
  instagram: 'valentinas.artgallery',
  /** Optional. The piece's title, shown in italics before the artist. */
  title: '',
  /**
   * The claim. Written as what the work IS rather than what it is not —
   * asserting reads more certain than defending. Change it if you disagree.
   */
  claim: 'Original artwork, drawn by hand',
}

/**
 * Tags that PAINT something. A hit on one of these means the credit is sitting
 * on top of content; a hit on a layout container means the space is free.
 *
 * Deliberately tag-based rather than a list of this app's class names. The
 * credit should not need editing every time a view is added — DIV, UL, TABLE,
 * TBODY and SECTION are boxes, and the things inside them are what you can see.
 */
const INK = new Set([
  'TD', 'TH', 'LI', 'P', 'A', 'SPAN', 'EM', 'STRONG', 'BUTTON', 'INPUT',
  'TEXTAREA', 'CANVAS', 'IMG', 'SVG', 'PATH', 'CODE', 'PRE', 'H1', 'H2', 'H3',
])

/**
 * Whether anything is currently drawn underneath the credit.
 *
 * Hit-tests three points across the credit's own box rather than one: the mark
 * is wider than it is tall, and a single centre probe called it clear while the
 * left half sat over a table cell.
 *
 * `elementsFromPoint` returns the stack topmost-first, so the credit and its own
 * children are skipped and the first thing below them is what is really there.
 */
function isOccluded(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const y = r.top + r.height / 2
  for (const x of [r.left + 2, r.left + r.width / 2, r.right - 2]) {
    for (const hit of document.elementsFromPoint(x, y)) {
      if (el.contains(hit)) continue // the credit itself
      if (INK.has(hit.tagName)) return true
      break // first thing under the credit decides this point
    }
  }
  return false
}

/**
 * Hides the credit while content is under it, and brings it back when the space
 * clears — scrolling past the end of a short table, an empty editor, switching
 * back to a view with room.
 *
 * Watched via scroll (capture, so inner scrollers count), resize, and a
 * MutationObserver for view switches and late-arriving data. All three funnel
 * into one rAF-debounced check, so a 258-row render costs one hit-test per
 * frame at most.
 */
function useOccluded(ref: React.RefObject<HTMLElement | null>): boolean {
  const [occluded, setOccluded] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const check = () => {
      frame = 0
      setOccluded(isOccluded(el))
    }
    /**
     * Double rAF, and it is not superstition. A MutationObserver fires during
     * React's commit, so a single rAF runs BEFORE the browser has laid the new
     * view out — the hit-test then reads the old geometry, and because nothing
     * schedules another pass the wrong answer sticks until the user happens to
     * scroll. Measured exactly that: switching to the table left the credit
     * showing, switching back to an empty editor left it hidden.
     *
     * The second frame runs after paint, when the layout is real.
     */
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => requestAnimationFrame(check))
    }

    schedule()
    // Capture phase: scroll does not bubble, and every view here scrolls inside
    // its own container rather than the window.
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const host = el.parentElement ?? document.body
    const mo = new MutationObserver(schedule)
    mo.observe(host, { childList: true, subtree: true })

    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      mo.disconnect()
    }
  }, [ref])

  return occluded
}

export function ArtCredit(): React.ReactElement | null {
  const { artist, instagram, title, claim } = ARTWORK
  const ref = useRef<HTMLElement | null>(null)
  // Called before the early return: a hook cannot run conditionally, and the
  // artist check below can flip between renders.
  const occluded = useOccluded(ref)
  if (!artist.trim()) return null

  const handle = instagram.trim().replace(/^@/, '')
  const url = handle ? `https://instagram.com/${handle}` : null

  return (
    <aside
      ref={ref}
      className="art-credit"
      data-occluded={occluded || undefined}
      aria-label="Artwork credit"
    >
      <span className="art-credit-claim">{claim}</span>
      {/*
       * Her actual signature, as a CSS mask rather than an <img>. A mask is
       * painted with `currentColor`, so the strokes inherit the credit's colour
       * and move with it through rest, hover and the high-contrast override —
       * an <img> would be a fixed-colour graphic drifting out of the palette
       * the moment anything else changed.
       *
       * `aria-hidden` because the name in the line below is the accessible
       * credit; a screen reader announcing both would say it twice.
       */}
      <span className="art-credit-signature" aria-hidden="true" />
      <span className="art-credit-line">
        {title.trim() && <em className="art-credit-title">{title} · </em>}
        {url ? (
          /*
           * `target="_blank"` is load-bearing, not a habit. A plain in-app
           * navigation is killed by the `will-navigate` handler in
           * src/main/index.ts; `target="_blank"` routes through
           * `setWindowOpenHandler`, which hands http(s) to the real browser and
           * denies everything else. `rel` is belt and braces — the opener is a
           * window holding the full `window.api` bridge.
           */
          <a
            className="art-credit-link"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title={`Open @${handle} on Instagram`}
          >
            {artist} <span className="art-credit-handle">@{handle}</span>
          </a>
        ) : (
          artist
        )}
      </span>
    </aside>
  )
}
