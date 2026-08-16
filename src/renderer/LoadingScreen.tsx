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
/** Intermediate glyphs each changed tile flips through before it lands. */
const FLIPS_PER_CHAR = 6
/** Seconds per flap. */
const FLIP_DURATION = 0.11
/** Seconds between adjacent tiles starting their cascade. */
const STAGGER = 0.045
/** Fixed tile count, so the board does not resize between phrases. */
const WIDTH = 13

const sampleChar = () => CHARSET.charAt(Math.floor(Math.random() * CHARSET.length))

const pad = (phrase: string) => phrase.padEnd(WIDTH, ' ').slice(0, WIDTH)

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

  const padded = useMemo(() => phrases.map(pad), [phrases])
  const [tiles, setTiles] = useState<Tile[]>(() => createTiles(padded[0] ?? ''))

  useEffect(() => {
    const stop = () => {
      if (raf.current) cancelAnimationFrame(raf.current)
      if (timer.current) clearTimeout(timer.current)
      raf.current = null
      timer.current = null
    }
    stop()

    const first = padded[0] ?? ''
    currentText.current = first
    setTiles(createTiles(first))
    if (padded.length <= 1) return stop

    let index = 0
    let cancelled = false
    const flipMs = FLIP_DURATION * 1000
    const staggerMs = STAGGER * 1000

    const animateTo = (target: string): number => {
      if (reduced) {
        // Not "no feedback" — the board still changes phrase, it just does not
        // tumble to get there. apple-design 14: a gentler equivalent, not none.
        currentText.current = target
        setTiles(createTiles(target))
        return 0
      }

      const from = pad(currentText.current)
      const plans = target
        .split('')
        .map((ch, i) => {
          if (from[i] === ch) return null
          const seq = Array.from({ length: FLIPS_PER_CHAR }, sampleChar).concat(ch)
          return { i, from: from[i] ?? ' ', target: ch, seq, start: i * staggerMs, step: -1, done: false }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)

      if (plans.length === 0) {
        currentText.current = target
        setTiles(createTiles(target))
        return 0
      }

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
        schedule(1600 + animateTo(padded[index]))
      }, delay)
    }
    schedule(1100)

    return () => {
      cancelled = true
      stop()
    }
  }, [padded, reduced])

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

const PHRASES = ['VAULT ONLINE', 'READING NOTES', 'AGENT WORKSPACE']

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
    const floor = new Promise<void>((r) => setTimeout(r, 2600))
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
