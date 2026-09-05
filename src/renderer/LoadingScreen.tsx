import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_LINE,
  boardSize,
  fieldSize,
  layout,
  noiseLike,
  sampleChar,
} from './bootBoard.js'
import './LoadingScreen.css'

/**
 * Boot screen — a split-flap departure board while the vault comes up.
 *
 * Ported from the React Bits SplitFlapText component parked in the vault at
 * `Projects/Agent Workspace - Loading Screen (SplitFlapText).md`. That note
 * flagged three things before anyone touched it, and all three are handled here:
 *
 *   1. The original's colours are cool slate (#111827 / #f8fafc) passed as
 *      literal hexes through an inline style object. This app is warm earthy
 *      monochrome, and `test/review-s2-vault-pane.test.mjs` bans hex colours,
 *      `rgb()` and inline style objects in pane sources. So the colour props are
 *      GONE rather than re-defaulted: the stylesheet owns the look and reads
 *      tokens.css. One usage does not need a theming API.
 *   2. `role="text"` is a Safari-only nonstandard value. The tiles are
 *      aria-hidden decoration and the phrase is announced from a polite live
 *      region instead.
 *   3. `color-mix()` is fine in Electron 33's Chromium.
 *
 * Also trimmed, per the same reasoning: tileRadius, gap, fontSize, charset,
 * padTo and className were props with exactly one caller. They are constants or
 * CSS now. What remains is the flap engine, which is the part worth having.
 *
 * The board is FULL SCREEN and MULTI-LINE, and ONLY THE CELLS THAT LAND ON A
 * LETTER EVER MOVE. All the geometry behind that lives in `bootBoard.ts`, which
 * is plain .ts so it can actually be run by a test; this file is the engine and
 * the copy.
 */

/**
 * Intermediate glyphs a tile tumbles through before it lands.
 *
 * The board scrambles and then lands AT ONCE, so this number is the only thing
 * setting how long the scramble reads for: 18 x 70ms = ~1.26s. At the original
 * 6 x 110ms it was over before you could focus on it.
 */
const FLIPS_PER_CHAR = 18
/** Seconds per flap. Must match the flap-front/flap-back durations in the CSS. */
const FLIP_DURATION = 0.07
/**
 * Minimum time the boot screen stays up.
 *
 * Sized to the animation, not guessed, and it is now the SUM OF THREE THINGS
 * that all live in LoadingScreen.css and must be changed together:
 *
 *   scramble   (FLIPS_PER_CHAR + 1) x FLIP_DURATION   ~1.33s
 *   crawl      `boot-crawl` 2.6s, delayed 1.4s        ends 4.00s
 *   fade       `boot-out` --duration-normal @ 3.65s   ends 4.00s
 *
 * Cut this and the crawl is truncated mid-move, which reads as the splash being
 * yanked away rather than finishing.
 */
const BOOT_MIN_MS = 4000

type Tile = { current: string; next: string; flipping: boolean; tick: number }

const createTiles = (phrase: string): Tile[] =>
  phrase.split('').map((c) => ({ current: c, next: c, flipping: false, tick: 0 }))

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * A run of blank cells.
 *
 * `memo` is load-bearing, not tidiness. There are up to a few thousand of these
 * and the tile state above updates on nearly every animation frame; without the
 * bailout, every frame of the scramble would reconcile the entire field to
 * produce a few dozen changed glyphs. Count is the only input, and it changes
 * only when the window is resized.
 */
const Blanks = memo(function Blanks({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span className="flap-tile" aria-hidden="true" key={i} />
      ))}
    </>
  )
})

/**
 * How many cells cover the window. The arithmetic is in `fieldSize`; this hook
 * is only the measuring and the plumbing.
 *
 * Geometry is read off the element's own computed style rather than duplicated
 * here — LoadingScreen.css owns `--cell-w/h/gap` as unitless numbers, and the
 * resolved `font-size` turns them into pixels. A copy of those numbers in this
 * file would drift silently and the field would stop lining up with its letters.
 *
 * Writes the column count back as `--cols` imperatively. It could be an inline
 * style prop instead, but that re-renders the whole field to change one integer
 * that the grid reads directly.
 */
function useField(
  ref: React.RefObject<HTMLDivElement | null>,
  width: number,
  blockRows: number,
): { cols: number; rows: number } {
  const [field, setField] = useState({ cols: 0, rows: 0 })

  // Layout, not effect: this measures and fills before paint, so the board is
  // never briefly a bare block of letters on an empty screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    const measure = () => {
      const cs = getComputedStyle(el)
      const em = parseFloat(cs.fontSize)
      const cell = {
        w: parseFloat(cs.getPropertyValue('--cell-w')) * em,
        h: parseFloat(cs.getPropertyValue('--cell-h')) * em,
        gap: parseFloat(cs.getPropertyValue('--cell-gap')) * em,
      }
      if (!(cell.w > 0) || !(cell.h > 0)) return

      const next = fieldSize(el.clientWidth, el.clientHeight, cell, width, blockRows)
      el.style.setProperty('--cols', String(next.cols))
      el.style.setProperty('--block-w', String(width))
      setField((p) => (p.cols === next.cols && p.rows === next.rows ? p : next))
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, width, blockRows])

  return field
}

function SplitFlapText({ phrases }: { phrases: string[] }) {
  const reduced = usePrefersReducedMotion()
  const raf = useRef<number | null>(null)
  const currentText = useRef('')
  const board = useRef<HTMLDivElement>(null)

  /** Wide enough for the longest LINE and tall enough for the most lines. */
  const { width, rows } = useMemo(() => boardSize(phrases, MAX_LINE), [phrases])
  const padded = useMemo(
    () => phrases.map((p) => layout(p, MAX_LINE, width, rows)),
    [phrases, width, rows],
  )
  /**
   * Opens BLANK, for one frame, and then on masked noise.
   *
   * It used to open on a full rectangle of random glyphs, because the phrase was
   * not chosen until the effect below ran. Now the effect paints the noise for
   * the phrase it picked, so the cells that will stay empty never carry a glyph
   * at any point.
   */
  const [tiles, setTiles] = useState<Tile[]>(() =>
    createTiles(' '.repeat(width * rows)),
  )

  const field = useField(board, width, rows)

  useEffect(() => {
    const stop = () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = null
    }
    stop()

    /**
     * START ANYWHERE. This was `0`, which meant the board always opened on
     * PHRASES[0] and, because of the timing below, never got off it.
     *
     * The scramble takes FLIPS_PER_CHAR x FLIP_DURATION (~1.26s) and the first
     * advance is scheduled HOLD_MS after that — ~2.76s — while BOOT_MIN_MS is
     * 3000 and the tree usually resolves sooner. So a boot shows ONE phrase in
     * practice. Cycling was never the feature; which one you get is.
     */
    let index = Math.floor(Math.random() * padded.length)
    let cancelled = false
    const flipMs = FLIP_DURATION * 1000

    const animateTo = (target: string): number => {
      if (reduced) {
        // Not "no feedback" — the board still changes phrase, it just does not
        // tumble to get there. apple-design 14: a gentler equivalent, not none.
        currentText.current = target
        setTiles(createTiles(target))
        return 0
      }

      // The laid-out block, used as-is. It used to be re-derived with
      // `padCentre(currentText.current.trim(), width)`, which cannot survive
      // multiple lines — trimming a block collapses the row structure.
      const from = currentText.current

      /**
       * A CELL THAT LANDS ON A SPACE IS NEVER PLANNED.
       *
       * Every tile used to tumble, spaces included, so the board opened as a
       * solid rectangle of static that resolved into a sentence — and on a
       * three-row block that is 54 cells of noise for a phrase that might be
       * ten letters. Planning only the letters means the SHAPE of the phrase is
       * there from the first frame, the empty cells stay indistinguishable from
       * the field behind them, and the work per frame drops to the cells that
       * are actually doing something.
       */
      type Plan = {
        i: number
        from: string
        target: string
        seq: string[]
        step: number
        done: boolean
        start: number
      }
      const plans: Plan[] = []
      const blanks: number[] = []
      const chars = target.split('')
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string
        if (ch === ' ') {
          blanks.push(i)
          continue
        }
        plans.push({
          i,
          from: from[i] ?? ' ',
          target: ch,
          seq: Array.from({ length: FLIPS_PER_CHAR }, sampleChar).concat(ch),
          step: -1,
          done: false,
          start: 0,
        })
      }

      // Straight to blank, with no flip. There is nothing to animate to an
      // empty cell, and a tile turning over to reveal nothing reads as a fault.
      setTiles((prev) => {
        if (!blanks.some((i) => prev[i] && (prev[i].current !== ' ' || prev[i].flipping))) {
          return prev
        }
        const next = [...prev]
        for (const i of blanks) {
          const t = next[i]
          if (t) next[i] = { current: ' ', next: ' ', flipping: false, tick: t.tick }
        }
        return next
      })

      const total = plans.reduce((m, p) => Math.max(m, p.start + p.seq.length * flipMs), 0)
      const startedAt = performance.now()

      const tick = (now: number) => {
        if (cancelled) return
        const elapsed = now - startedAt
        const updates: { i: number; current: string; next: string; done: boolean }[] = []
        let more = false

        for (const p of plans) {
          const local = elapsed - p.start
          if (local < 0) {
            more = true
            continue
          }
          const step = Math.floor(local / flipMs)
          if (step < p.seq.length) {
            more = true
            if (step !== p.step) {
              p.step = step
              updates.push({
                i: p.i,
                current: step === 0 ? p.from : (p.seq[step - 1] as string),
                next: p.seq[step] as string,
                done: false,
              })
            }
          } else if (!p.done) {
            p.done = true
            updates.push({ i: p.i, current: p.target, next: p.target, done: true })
          }
        }

        if (updates.length > 0) {
          setTiles((prev) => {
            const next = [...prev]
            for (const u of updates) {
              const t = next[u.i]
              if (!t) continue
              next[u.i] = { current: u.current, next: u.next, flipping: !u.done, tick: t.tick + 1 }
            }
            return next
          })
        }

        if (more) raf.current = requestAnimationFrame(tick)
        else {
          currentText.current = target
          raf.current = null
        }
      }

      raf.current = requestAnimationFrame(tick)
      return total
    }

    /**
     * ONE PHRASE PER BOOT, and now that is enforced rather than incidental.
     *
     * It used to schedule the next phrase HOLD_MS after the last one landed —
     * ~2.76s — which never fired in practice because the screen was gone by
     * then. It would fire now that the boot runs to 4s, and it would be wrong:
     * a scramble repaints well backgrounds onto the letter cells, and those
     * cells are mid-crawl, so the board would grow a set of sliding rectangles
     * for the length of the second scramble. The two layers exist precisely to
     * prevent that.
     *
     * The scramble runs IMMEDIATELY rather than after a delay: the board should
     * be resolving from the first frame it is on screen. The noise is MASKED to
     * the phrase, so only cells that will hold a letter ever show a glyph.
     */
    const first = padded[index] ?? ''
    currentText.current = noiseLike(first)
    setTiles(createTiles(currentText.current))
    animateTo(first)

    return () => {
      cancelled = true
      stop()
    }
  }, [padded, width, rows, reduced])

  /**
   * The announced text. Row-major, so the rows have to be split apart and
   * rejoined with spaces — otherwise 'HOW MANY FACES' and 'WILL BE IN YOUR'
   * run together as 'HOW MANY FACESWILL BE IN YOUR'.
   */
  const settled = Array.from({ length: rows }, (_, r) =>
    tiles
      .slice(r * width, (r + 1) * width)
      .map((t) => t.current)
      .join('')
      .trim(),
  )
    .filter(Boolean)
    .join(' ')

  return (
    <div className="boot" role="status" ref={board}>
      {/* The tiles are decoration; three halves per glyph would be read out as
          gibberish. The phrase is announced once, politely, from here. */}
      <span className="flap-live" aria-live="polite">{settled}</span>

      {/* The ground. Every cell the window can show, and it never moves. */}
      <div className="boot-field" aria-hidden="true">
        <Blanks count={field.cols * field.rows} />
      </div>

      {/* The phrase, and only the phrase. Centred rather than positioned, which
          is why there are no blanks around it — see the note in the CSS on how
          the two grids stay in register without sharing a coordinate. */}
      <div className="boot-letters" aria-hidden="true">
        {tiles.map((tile, i) =>
          /**
           * A LANDED cell is a bare glyph — no well, no halves, nothing that
           * paints. The well under it belongs to the field, so the crawl moves
           * a letter across a stationary board instead of dragging its box
           * along with it. An empty cell renders nothing at all.
           */
          !tile.flipping ? (
            <span className="flap-glyph" key={i}>
              {tile.current === ' ' ? '' : tile.current}
            </span>
          ) : (
            <span className="flap-tile" key={i}>
              <span className="flap-half flap-half--top">
                <span className="flap-char">{tile.current}</span>
              </span>
              <span className="flap-half flap-half--bottom">
                <span className="flap-char">{tile.next}</span>
              </span>
              {/* Keyed on `tick` so each flap is a NEW element and its CSS
                  animation restarts. Reusing the node would leave the animation
                  in its finished state and the tile would jump instead of turn. */}
              <span className="flap-leaf flap-leaf--front" key={`f${tile.tick}`}>
                <span className="flap-char">{tile.current}</span>
              </span>
              <span className="flap-leaf flap-leaf--back" key={`b${tile.tick}`}>
                <span className="flap-char">{tile.next}</span>
              </span>
            </span>
          ),
        )}
      </div>
    </div>
  )
}

/**
 * The board's copy. One is picked at random per boot — see the comment on
 * `index` above for why a boot shows exactly one.
 *
 * Kept to CHARSET and spaces: a glyph the tiles cannot tumble to would land
 * from nowhere. That means no apostrophes, which is why the contractions below
 * are spelled bare.
 */
const PHRASES = [
  // The board is a mechanism and the fun is not knowing which one you get, so
  // these are a grab bag rather than a sequence. Nothing here reports real
  // state — the tree either resolved or it did not, and a splash that claimed
  // 'NOTES INDEXED' while indexing had failed would be lying decoratively.
  'AGENT WORKSPACE',
  'SYSTEMS READY',
  'READING NOTES',
  'LINKS RESOLVED',
  'NOTES INDEXED',
  'VAULT ONLINE',
  'WELCOME BACK',
  'STANDING BY',
  'GOOD TO GO',
  'FINISHED',
  'MOUNTED',
  'ALL SET',
  'LOADED',
  'READY',
  'DONE',

  // Nathan's, and a different register on purpose: the machine ones say the app
  // is up, these ask you something. A boot screen is the one surface nobody is
  // trying to get work done on, so it is the one place a question is not an
  // interruption. They are also the reason the board wraps — several are
  // sentences, and a sentence does not fit on one row of a departure board.
  'HOWS THE PROJECTS?',
  'IS THE SUN OUT?',
  'GOOD TO SEE YOU',
  'ANYTHING NEW?',
  'WHENS THE LAST TIME YOU SAID I LOVE YOU',
  'IS IT TIME TO WORK',
  'CONTEXT > PROMPTING',
  'HOW MUCH COULD A WOOD CHUCK COULD CHUCK WOOD?',
  'TIME TO LOCK TF IN',
  'HOW MANY MOONS UNTIL YOU MAKE IT',
  'DONT GIVE UP',
  'HOW MANY FACES WILL BE IN YOUR LIFE',
  'SHOOT FOR THE MOON',
  'IF YOU MISS THE MOON YOULL LAND IN THE STARS',
  'MY FAVORITE MOVIE IS THE NOTEBOOK',
  'COUNT THE TIME IN DAYS NOT HOURS ANYMORE',

  // Nathan's again, 2026-09-05, and a third register: the ones above ask you
  // something, these tell you something. Kept in his words — the board is his
  // voice, not the app's, and an aphorism edited for grammar stops being the
  // thing he wrote.
  'THE ARROWS THAT TRAVEL THE FURTHEST DISTANCE ARE PULLED BACK THE FURTHEST',
  'TO BECOME A NEW YOU MUST LOSE YOUR OLD SELF',
  'LET YOURSELF BURN SO YOUR ASHES WILL MAKE SOMETHING RISE EVEN FURTHER',
  'HOLDING BACK TEARS ONLY FIND ANOTHER WAY OUT',
  'ITS OK TO CRY',
  'JUST SIX MONTHS',
  'MEN CAN NOT KNOW EACH OTHER UNTIL THEY HAVE EATEN SALT TOGETHER',
  'EVERYONE WANTS TO BE RICH BUT NO ONE WANTS TO WORK FOR IT',
  'PEN AND PAPER CREATES THAT LIFE YOU WANT',
  'ONE COMPLAINT IS THE PATH TO WALKING BACKWARDS',
  'SURROUND YOURSELF WITH SEVEN IDIOTS AND YOULL BE THE EIGHTH',
]

/**
 * Holds the boot screen over the app until the vault tree resolves.
 *
 * It asks for the tree itself rather than reaching into <VaultPane>'s hook.
 * That is one extra IPC round trip at boot and it buys total independence: this
 * component touches no file anyone else is editing.
 *
 * A MINIMUM on-screen time is deliberate. The tree usually resolves in well
 * under a second, and a splash that flashes for 200ms is worse than none — it
 * reads as a glitch. It waits for the slower of the two, never the faster.
 *
 * It also resolves on failure. A boot screen that stays up forever because the
 * note server is down hides the very error the user needs to see.
 */
export function LoadingScreen(): React.ReactElement | null {
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    const floor = new Promise<void>((r) => setTimeout(r, BOOT_MIN_MS))
    const ready = window.api.vault.tree().then(
      () => undefined,
      () => undefined,
    )
    void Promise.all([floor, ready]).then(() => {
      if (!cancelled) setDone(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (done) return null

  return <SplitFlapText phrases={PHRASES} />
}
