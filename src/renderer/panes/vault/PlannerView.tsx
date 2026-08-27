/**
 * The planner page — the calendar.
 *
 * TWO FEATURES, ONE SCREEN, AND NO MERGE. Clicking the calendar icon puts the
 * daily notes in the sidebar — the same picker that was always there — and this
 * calendar in the main area. Both are in front of you; neither is inside the
 * other.
 *
 * An earlier cut DID merge them, rendering each day's daily note inside that
 * day's calendar cell above its dated notes, and it was wrong twice over. The
 * calendar is a view over the WHOLE vault, placing notes on the day their
 * `updated:` claims; the daily notes are an authoring surface for ONE folder,
 * where the useful gesture on an empty day is to write it. Merging them made a
 * read-only view start creating files, and put a "+ Daily note" button on every
 * empty day in the vault's history. They read dates out of different places and
 * answer different questions.
 *
 * So this file is the calendar and only the calendar. `DailyNotesView` is
 * rendered by VaultPane in the sidebar and is not imported here — deliberately,
 * because mounting it in both would put the same picker on screen twice.
 *
 * The calendar below is the view that used to be the database's fourth mode,
 * restored as it was — the same strict date parse, the same undated list, the
 * same jump-to-a-month-with-notes. It left the database because "many views,
 * same rows" was a claim about table, board and gallery being one query three
 * ways, and a calendar over `updated:` was never a fourth rendering of that.
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { VaultNoteMeta } from '../../../shared/notemeta.js'
import { calendarBuckets, monthCells } from '../../../shared/planner.js'
import { SelectMenu } from './SelectMenu.js'
import './planner.css'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Calendar — every note, placed on the day its frontmatter claims.
 *
 * THE DATE PROBLEM, which is why this was the last of the database's views to
 * be built and why its switcher carried a "not built yet" note rather than a
 * rough version: `updated` is hand-written and `new Date()` on it lies in two
 * directions — it accepts things that are not dates, and it reads a bare
 * `YYYY-MM-DD` as UTC midnight, which renders as the previous day in any
 * negative-offset timezone. `parseYmd` reads the digits instead and refuses
 * everything else, so a note lands on the day it says or on no day at all.
 *
 * UNDATED NOTES ARE SHOWN, not dropped. Most of this vault has no `updated`,
 * and a calendar that quietly rendered 12 of 258 notes would be the most
 * confident lie in the app. They get a labelled list under the grid.
 *
 * Weeks start Monday, matching the ISO convention the vault's own date strings
 * follow.
 */
function Calendar({
  rows,
  onOpenNote,
}: {
  rows: VaultNoteMeta[]
  onOpenNote: (path: string) => void
}) {
  /** path -> day, computed once per row set. */
  const { byDay, undated, months } = useMemo(() => calendarBuckets(rows), [rows])

  /**
   * Opens on the most recent month that HAS notes, not on today. This vault is
   * mostly historical: landing on an empty current month would look like the
   * view failed, and the user would have to page backwards to find out it had
   * not.
   */
  const [cursor, setCursor] = useState<string | null>(null)
  const current = cursor ?? months[months.length - 1] ?? null

  if (!current) {
    return (
      <div className="planner-empty">
        <strong>No dated notes.</strong>
        <span>
          {rows.length} note{rows.length === 1 ? '' : 's'}, and none carries an ISO{' '}
          <code>updated:</code> date to place on a calendar.
        </span>
      </div>
    )
  }

  const [yStr, mStr] = current.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const cells = monthCells(y, m)

  const step = (delta: number): void => {
    const total = y * 12 + (m - 1) + delta
    setCursor(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`)
  }

  return (
    <div className="planner-calendar">
      <div className="planner-cal-head">
        <button
          type="button"
          className="planner-cal-nav"
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="planner-cal-month">
          {MONTH_NAMES[m - 1]} {y}
        </span>
        <button
          type="button"
          className="planner-cal-nav"
          onClick={() => step(1)}
          aria-label="Next month"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        {/* Jumping to a month that HAS something beats paging through empties. */}
        <SelectMenu
          id="planner-cal-jump-menu"
          label="Jump to a month with notes"
          className="planner-cal-jump"
          value={current}
          options={[
            ...(months.includes(current) ? [] : [{ value: current, label: `${current} (empty)` }]),
            ...months.map((mo) => ({
              value: mo,
              label: `${mo} · ${[...byDay.entries()].filter(([k]) => k.startsWith(mo)).reduce((a, [, v]) => a + v.length, 0)}`,
            })),
          ]}
          onChange={setCursor}
        />
      </div>

      <div className="planner-cal-grid" role="grid" aria-label={`${MONTH_NAMES[m - 1]} ${y}`}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="planner-cal-weekday" role="columnheader">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) {
            return <div key={`blank-${i}`} className="planner-cal-cell planner-cal-cell--blank" />
          }
          const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const notes = byDay.get(key) ?? []
          return (
            <div key={key} className="planner-cal-cell" role="gridcell">
              <span className="planner-cal-day">{day}</span>
              {notes.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  className="planner-cal-note"
                  title={n.path}
                  onClick={() => onOpenNote(n.path)}
                >
                  {n.title}
                </button>
              ))}
            </div>
          )
        })}
      </div>

      {undated.length > 0 && (
        <div className="planner-cal-undated">
          <h3 className="planner-cal-undated-title">{undated.length} without a usable date</h3>
          <p className="planner-cal-undated-note">
            No <code>updated:</code> field, or one a calendar cannot place. They are not on
            the grid.
          </p>
          <div className="planner-cal-undated-list">
            {undated.map((n) => (
              <button
                key={n.path}
                type="button"
                className="planner-cal-note"
                title={n.path}
                onClick={() => onOpenNote(n.path)}
              >
                {n.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export interface PlannerViewProps {
  /**
   * Frontmatter for every note, for the calendar.
   *
   * FETCHED HERE rather than handed down. `getNotes()` is a fresh round trip by
   * design — MainCanvas's own comment says there is no cache behind it, because
   * frontmatter is exactly what these views exist to show and a stale
   * `updated:` would put a note on the wrong day. So a second caller costs one
   * request, and the planner can be reached from the ribbon without the
   * database ever having been opened.
   */
  getNotes: () => Promise<VaultNoteMeta[]>
  onOpenNote: (path: string) => void
}

export function PlannerView({ getNotes, onOpenNote }: PlannerViewProps) {
  const [notes, setNotes] = useState<VaultNoteMeta[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  /**
   * Loaded once per mount, which is "each time you come back to the planner" —
   * the view is unmounted while another tab is showing. Same always-re-fetch
   * contract the graph and database tabs hold themselves to.
   *
   * `live` guards the write: a planner closed while the request is in flight
   * would otherwise set state on an unmounted component.
   */
  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    getNotes()
      .then((rows) => {
        if (live) setNotes(rows)
      })
      .catch((e: unknown) => {
        if (live) setError(String(e))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [getNotes])

  if (error) {
    return (
      <div className="planner">
        <p className="planner-error" role="alert">
          Dated notes could not be loaded. {error}
        </p>
      </div>
    )
  }

  // Only on the FIRST load. A refetch on a later mount keeps the month you were
  // looking at on screen rather than blanking it, which is the difference
  // between a view that refreshes and one that reloads.
  if (loading && !notes) {
    return (
      <div className="planner">
        <p className="planner-notice">Loading dated notes…</p>
      </div>
    )
  }

  return (
    <div className="planner">
      <Calendar rows={notes ?? []} onOpenNote={onOpenNote} />
    </div>
  )
}
