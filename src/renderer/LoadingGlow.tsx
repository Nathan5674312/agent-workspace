/**
 * THE APP SAYING IT IS DOING SOMETHING — a glow along the top edge.
 *
 * Nathan's ask, 2026-09-07: "the top of the screen faintly but easily
 * noticeably glows like a bar, not too much to where it's blocking anything at
 * the top." So: light, not a widget. It has no box, no percentage and no
 * spinner, it sits in the two pixels above the tab bar where nothing is drawn,
 * and it never takes a click — `pointer-events: none`, because the window
 * controls and the tab strip are right underneath it.
 *
 * NOT A PROGRESS BAR, because the app does not know the progress. A vault read
 * has no total to divide by, and a bar that fills to 90% and waits is a lie
 * that people have learned to read as "stuck". A glow that travels says "still
 * working" without claiming to know how much is left.
 *
 * TWO TIMERS, AND BOTH EARN THEIR PLACE:
 *
 *   ENTER LATE (120ms). Most reads finish inside a frame or two, and an
 *   indicator that flashes on every keystroke-fast operation is worse than no
 *   indicator: the eye catches the flicker and learns to distrust the top of
 *   the window. Work that finishes before this fires shows nothing at all.
 *
 *   LEAVE SLOWLY (260ms). Once it IS up, snapping it off the instant the last
 *   promise resolves reads as a glitch — the same "it flashed at me" complaint
 *   from the other side. It fades, and the fade is CSS.
 *
 * This file is in `renderer/` and not in `panes/vault/`, so the pane's ban on
 * timers does not apply — that ban exists for the save path, and this is not
 * it. The numbers are here rather than in the stylesheet because they are
 * timing, not appearance, and the component owns them.
 */
import { useEffect, useState } from 'react'
import { subscribe } from './busy.js'
import './loadingglow.css'

/** How long work must run before the glow appears at all. */
const ENTER_AFTER = 120
/** How long the glow lingers once the work is done, so it fades rather than cuts. */
const LEAVE_AFTER = 260

export function LoadingGlow(): React.ReactElement | null {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let enter: ReturnType<typeof setTimeout> | null = null
    let leave: ReturnType<typeof setTimeout> | null = null

    const clear = (): void => {
      if (enter !== null) clearTimeout(enter)
      if (leave !== null) clearTimeout(leave)
      enter = null
      leave = null
    }

    /**
     * ONLY ON A CHANGE, and this is not a micro-optimisation — the first
     * version restarted the enter timer on every publish and the glow never
     * appeared at all.
     *
     * The counter publishes on every begin and every end, and real work
     * arrives in bursts: opening the database reads the note list and the
     * graph, a note open reads the file and the backlinks. Each of those
     * published `true` again while already busy, cleared the pending 120ms
     * timer and started a new one, so the countdown reset faster than it could
     * finish. MEASURED before the fix: a 183ms load, glow never rendered on a
     * single frame of it.
     *
     * Latching on the transition means the 120ms is counted from when the
     * window FIRST became busy, which is what it was always meant to measure.
     */
    let busyNow = false
    const stop = subscribe((busy) => {
      if (busy === busyNow) return
      busyNow = busy
      clear()
      if (busy) enter = setTimeout(() => setShown(true), ENTER_AFTER)
      else leave = setTimeout(() => setShown(false), LEAVE_AFTER)
    })

    return () => {
      clear()
      stop()
    }
  }, [])

  if (!shown) return null

  /**
   * `aria-hidden`, with no live region and no announcement.
   *
   * A screen reader user is told about the RESULT — the note that opened, the
   * results that arrived — by the thing that changed. Announcing "loading" on
   * every 200ms vault read would talk over that, repeatedly, for something a
   * sighted user is meant to notice only in passing.
   */
  return <div className="loading-glow" aria-hidden="true" />
}
