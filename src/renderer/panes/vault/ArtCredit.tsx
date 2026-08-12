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

export function ArtCredit(): React.ReactElement | null {
  const { artist, instagram, title, claim } = ARTWORK
  if (!artist.trim()) return null

  const handle = instagram.trim().replace(/^@/, '')
  const url = handle ? `https://instagram.com/${handle}` : null

  return (
    <aside className="art-credit" aria-label="Artwork credit">
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
