/**
 * WHAT THE AGENTS ARE DOING. TOP RIGHT, AMBIENT, NEVER ASKS ANYTHING.
 *
 * Deliberately NOT part of the agent corner, which is bottom right and is the
 * one consent surface. That corner's founding rule is "silence is the default —
 * if the common path is not 'nothing happened', it is wrong", because a surface
 * that speaks constantly is one people learn to click through, and the thing
 * they would be clicking through is permission to touch their files. An activity
 * feed is constant by nature. Putting the two together would spend the consent
 * corner's silence on status updates.
 *
 * So: two corners, two jobs. Bottom right interrupts and blocks and is rare. Top
 * right never blocks, never asks, and cannot be answered.
 *
 * IT DOES NOT EXIST WHEN NOTHING IS HAPPENING. No empty state, no idle chip, no
 * "0 agents". Someone using this as an ordinary notes app must never meet the
 * agent layer at all, and an empty panel is still meeting it.
 *
 * IT SHOWS SHAPE, NOT A FIREHOSE. An agent makes dozens of tool calls a minute;
 * a live list of all of them is noise wearing the costume of information. One
 * line per agent for what it is doing right now, a couple of lines of recent
 * history underneath, and a count. Nothing scrolls.
 *
 * Everything rendered here comes from `shared/transcript.ts`, which reads only
 * tool metadata and reduces shell commands to a program name. No message text,
 * no file contents, no command arguments reach this component — that boundary is
 * enforced where the parsing happens rather than trusted to the view.
 */
import { useEffect, useMemo, useState } from 'react'
import type { Activity } from '../../../shared/ipc.js'
import { sessions, describe, where } from '../../../shared/transcript.js'

/**
 * How long a session stays on screen after its last tool call.
 *
 * Long enough that the gap while a model is thinking does not make the panel
 * flicker out and back — which reads as a crash — and short enough that a
 * finished agent stops claiming to be working. A turn's thinking time sits well
 * inside this; a finished session falls off it quickly.
 */
const IDLE_MS = 90_000

/** Keep the panel bounded no matter how much arrives. */
const MAX_KEPT = 400

/**
 * How many agents get a card, and why there is a limit at all.
 *
 * Five concurrent agents produced a 1030px panel in a 1000px window — it ran off
 * the bottom, and because this surface is `pointer-events: none` by design there
 * is nothing to scroll it with. Overflow here is not a cosmetic problem, it is
 * content that cannot be reached by any means.
 *
 * Four is what fits. The rest are counted on one line rather than dropped
 * silently, because "3 more working" is information and a truncated list that
 * does not say it was truncated is a lie.
 */
const MAX_SHOWN = 4

/** A short, stable label for a session id, which is a UUID nobody can read. */
function shortId(id: string): string {
  return id.slice(0, 4) || 'agent'
}

/** The folder an agent is working in, which is how a person tells them apart. */
function place(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

/**
 * How many trailing segments of the working directory to show.
 *
 * The panel is 17rem wide and cannot hold `C:/Users/Nathan/Desktop/agent-workspace`
 * on one line at any font size worth reading. The head of that string is also
 * the part that distinguishes nothing — every agent on the machine shares it.
 * Three segments is what fits and what separates two checkouts of the same
 * repo, which is the case this exists to disambiguate.
 */
const CWD_SEGMENTS = 3

/**
 * The working directory, trimmed from the LEFT so the meaningful tail survives.
 *
 * `where` with no root and a wider segment count, rather than a second copy of
 * the same string arithmetic living in the view where no test can reach it.
 */
const cwdLabel = (cwd: string): string => where(cwd, undefined, CWD_SEGMENTS)

/**
 * The installation an agent belongs to, shortened for a badge.
 *
 * `.claude` is the default one and gets no badge at all — a label every agent
 * would carry is not a label, it is furniture. Only a NON-default config
 * directory is worth naming, which on this machine is the second account, and
 * that is exactly the case where "which of my two installations is that" is a
 * question somebody is actually asking.
 */
function installLabel(source: string | undefined): string | null {
  if (!source || source === '.claude') return null
  return source.replace(/^\.claude-?/, '') || source
}

export function AgentActivity(): React.JSX.Element | null {
  const [items, setItems] = useState<Activity[]>([])
  // Re-render on a timer as well as on new activity, so a session that has gone
  // quiet actually disappears. Without it the last agent to stop would stay on
  // screen until something else happened, which is exactly when nothing will.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    void window.api.agents.activity().then((initial) => {
      if (live) setItems(initial.slice(-MAX_KEPT))
    })
    const off = window.api.agents.onActivity((incoming) => {
      setItems((prev) => [...prev, ...incoming].slice(-MAX_KEPT))
      setNow(Date.now())
    })
    const tick = setInterval(() => setNow(Date.now()), 5_000)
    return () => {
      live = false
      off()
      clearInterval(tick)
    }
  }, [])

  const live = useMemo(
    () => sessions(items.filter((a) => now - a.at < IDLE_MS)),
    [items, now],
  )

  // The whole component, gone. Not an empty container, not a collapsed bar.
  if (live.length === 0) return null

  // Busiest-most-recent first, so the ones that fall off the end are the ones
  // that moved longest ago.
  const shown = live.slice(0, MAX_SHOWN)
  const hidden = live.length - shown.length

  return (
    <div className="activity" role="status" aria-live="polite" aria-label="Agent activity">
      {shown.map((s) => (
        <div className="activity-agent" key={s.session}>
          <div className="activity-head">
            <span className="activity-dot" aria-hidden="true" />
            {/* A subagent inherits its PARENT's slug, so every subagent of one
                session carries the same readable name — four of them showed as
                four identical labels. For those the short agent id is the only
                thing that actually distinguishes them, so it becomes the name
                and the slug is dropped. */}
            <span className="activity-who">
              {s.parent ? shortId(s.session) : (s.label ?? place(s.cwd))}
            </span>
            {/* The installation, when it is not the default one. See
                installLabel — a badge every agent carries says nothing. */}
            {installLabel(s.source) && (
              <span className="activity-install">{installLabel(s.source)}</span>
            )}
            <span className="activity-id">{s.parent ? 'sub' : shortId(s.session)}</span>
          </div>
          {/* WHERE, on its own line. This used to be the last folder segment
              tucked in the corner of the head, which is ambiguous the moment
              two agents work in folders that share a name — the common case on
              a machine with more than one checkout. */}
          <div className="activity-where" title={s.cwd}>
            {cwdLabel(s.cwd)}
          </div>
          {/* Paths are resolved against the agent's OWN cwd, so a file reads as
              `src/shared/guides.ts` rather than as a bare filename that could
              be any of four, or an absolute path that wraps three lines. */}
          <div className="activity-now">{describe(s.last, s.cwd)}</div>
          {s.recent.length > 1 && (
            <ol className="activity-trail">
              {s.recent.slice(1, 3).map((a, i) => (
                <li className="activity-trail-item" key={`${a.at}-${i}`}>
                  {describe(a, s.cwd)}
                </li>
              ))}
            </ol>
          )}
          <div className="activity-count">{s.count} steps</div>
        </div>
      ))}
      {hidden > 0 && (
        <div className="activity-more">
          {hidden} more agent{hidden === 1 ? '' : 's'} working
        </div>
      )}
    </div>
  )
}
