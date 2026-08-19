import { useEffect, useMemo, useRef, useState } from 'react'
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
 */

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/**
 * Intermediate glyphs every tile tumbles through before it lands.
 *
 * The whole board scrambles and then lands AT ONCE, so this number is the only
 * thing setting how long the scramble reads for: 18 x 70ms = ~1.26s. At the
 * original 6 x 110ms it was over before you could focus on it.
 */
const FLIPS_PER_CHAR = 18
/** Seconds per flap. Must match the flap-front/flap-back durations in the CSS. */
const FLIP_DURATION = 0.07
/** Milliseconds a landed phrase is held before the board scrambles again. */
const HOLD_MS = 1500
/**
 * Minimum time the boot screen stays up.
 *
 * Sized to the animation, not guessed: the opening scramble is
 * (FLIPS_PER_CHAR + 1) x FLIP_DURATION = ~1.33s, and the phrase then needs to
 * be READABLE once it lands, which the first version never allowed for -- it
 * resolved and vanished inside a blink. Opening + a beat to read it + the fade.
 * Kept in sync with the boot-out delay in LoadingScreen.css.
 */
const BOOT_MIN_MS = 3000

const sampleChar = () => CHARSET.charAt(Math.floor(Math.random() * CHARSET.length))

const randomPhrase = (width: number) =>
  Array.from({ length: width }, sampleChar).join('')

/**
 * Centre the phrase in a fixed-width board.
 *
 * Was `padEnd`, which is two bugs. The obvious one: every phrase shorter than
 * the board carried its blank tiles on the right, so the text sat visibly left
 * of centre — 'VAULT ONLINE' in 13 tiles was off by half a tile.
 *
 * The quiet one: the width was a hardcoded 13 and the `.slice()` that enforced
 * it silently truncated 'AGENT WORKSPACE' to 'AGENT WORKSPA'. The width is now
 * derived from the longest phrase, so the slice can never cut a word again.
 */
const padCentre = (phrase: string, width: number) => {
  const left = Math.floor((width - phrase.length) / 2)
  return phrase.padStart(phrase.length + Math.max(0, left), ' ').padEnd(width, ' ')
}

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

function SplitFlapText({ phrases }: { phrases: string[] }) {
  const reduced = usePrefersReducedMotion()
  const raf = useRef<number | null>(null)
  const timer = useRef<number | null>(null)
  const currentText = useRef('')

  /** Wide enough for the longest phrase, so nothing is ever cut. */
  const width = useMemo(
    () => phrases.reduce((m, p) => Math.max(m, p.length), 1),
    [phrases],
  )
  const padded = useMemo(
    () => phrases.map((p) => padCentre(p, width)),
    [phrases, width],
  )
  // Opens on nonsense, deliberately. The board is a mechanism; watching it
  // resolve out of noise is the whole effect, and starting on the finished
  // phrase threw that away on the one appearance that matters most.
  const [tiles, setTiles] = useState<Tile[]>(() => createTiles(randomPhrase(width)))

  useEffect(() => {
    const stop = () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      if (timer.current) clearTimeout(timer.current)
      raf.current = null
      timer.current = null
    }
    stop()

    let index = 0
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

      const from = padCentre(currentText.current.trim(), width)
      /**
       * EVERY tile tumbles, and they all start and land on the same frame.
       *
       * The original skipped tiles whose letter was not changing and staggered
       * the rest left-to-right, which is what a real departure board does when
       * one flight changes. It is the wrong read for a boot screen: the board
       * dribbled into place a letter at a time and half the tiles never moved.
       * Scrambling the whole board and snapping it shut in one beat is the
       * effect worth having — noise, then a word.
       */
      const plans = target.split('').map((ch, i) => ({
        i,
        from: from[i] ?? ' ',
        target: ch,
        seq: Array.from({ length: FLIPS_PER_CHAR }, sampleChar).concat(ch),
        step: -1,
        done: false,
        start: 0,
      }))

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
                current: step === 0 ? p.from : p.seq[step - 1],
                next: p.seq[step],
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

    const schedule = (delay: number) => {
      timer.current = window.setTimeout(() => {
        if (cancelled) return
        index = (index + 1) % padded.length
        schedule(HOLD_MS + animateTo(padded[index]))
      }, delay)
    }

    // The opening scramble runs IMMEDIATELY rather than after a delay: the
    // board is already showing noise, and the first thing it should do is
    // resolve. Everything after that is on the hold cycle.
    currentText.current = randomPhrase(width)
    const opening = animateTo(padded[0] ?? '')
    if (padded.length > 1) schedule(HOLD_MS + opening)

    return () => {
      cancelled = true
      stop()
    }
  }, [padded, width, reduced])

  const settled = tiles.map((t) => t.current).join('').trimEnd()

  return (
    <div className="flap">
      {/* The tiles are decoration; three halves per glyph would be read out as
          gibberish. The phrase is announced once, politely, from here. */}
      <span className="flap-live" aria-live="polite">{settled}</span>
      {tiles.map((tile, i) => (
        <span className="flap-tile" aria-hidden="true" key={i}>
          <span className="flap-half flap-half--top">
            <span className="flap-char">{tile.current}</span>
          </span>
          <span className="flap-half flap-half--bottom">
            <span className="flap-char">{tile.flipping ? tile.next : tile.current}</span>
          </span>
          {tile.flipping && (
            <>
              {/* Keyed on `tick` so each flap is a NEW element and its CSS
                  animation restarts. Reusing the node would leave the animation
                  in its finished state and the tile would jump instead of turn. */}
              <span className="flap-leaf flap-leaf--front" key={`f${tile.tick}`}>
                <span className="flap-char">{tile.current}</span>
              </span>
              <span className="flap-leaf flap-leaf--back" key={`b${tile.tick}`}>
                <span className="flap-char">{tile.next}</span>
              </span>
            </>
          )}
        </span>
      ))}
    </div>
  )
}

/**
 * The board's copy. First one is what you actually read — the others only
 * appear if the vault is slow enough to still be loading.
 *
 * Kept to A–Z and spaces: CHARSET is the alphabet, so a digit or punctuation
 * would land on a tile that never tumbled to it and break the illusion.
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

  return (
    <div className="boot" role="status">
      <SplitFlapText phrases={PHRASES} />
    </div>
  )
}
