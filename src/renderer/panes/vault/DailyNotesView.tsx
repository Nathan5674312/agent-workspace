/**
 * Daily notes — the left ribbon's `calendar` icon.
 *
 * `docs/buttons/ribbon-calendar.md` filed this as the one ribbon item that
 * could not be scoped from code, because the answer lived in how the vault is
 * actually used: does a daily-notes practice exist, and what is the path
 * convention? Both are answerable by looking, and were:
 *
 *   Daily/YYYY-MM-DD.md, with Daily/_Template.md beside them.
 *
 * So nothing here guesses a format. The folder and the filename shape are read
 * off the vault tree, and a vault with no `Daily/` folder gets told that rather
 * than shown an empty grid of dead links — which is the failure the doc warned
 * about when it said guessing wrong makes every date a dead link.
 *
 * CREATING IS A REAL WRITE, and it follows the vault's own stated convention
 * rather than one invented here: `_Template.md` opens with an instruction line
 * and a `---`, and says to copy what follows as `YYYY-MM-DD.md`. That is what
 * `noteFromTemplate` does, `{{date}}` included. A vault whose template changes
 * shape gets the new shape for free; a vault with no template gets a heading.
 *
 * Dates are LOCAL here, not UTC. `toISOString()` would name yesterday for
 * anyone working after their timezone's UTC midnight — which is exactly the
 * hour a daily note gets written.
 */
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { VaultTreeNode } from '../../../shared/ipc.js'
import {
  DAILY_DIR,
  DAILY_TEMPLATE,
  dailyPath,
  noteFromTemplate,
  todayLocal,
} from '../../../shared/daily.js'
import {
  dailyNotes,
  hasDailyFolder,
  monthCells,
  stepMonth,
} from '../../../shared/planner.js'
import './daily.css'

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const pad = (n: number): string => String(n).padStart(2, '0')
const key = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

export interface DailyNotesViewProps {
  tree: VaultTreeNode | null
  onOpenNote: (path: string) => void
  /** Re-read the tree after a create, so the new day stops reading as empty. */
  onCreated: () => void
}

export function DailyNotesView({ tree, onOpenNote, onCreated }: DailyNotesViewProps) {
  const todayKey = todayLocal()
  const [ty, tm] = todayKey.split('-').map(Number)
  const [cursor, setCursor] = useState<{ y: number; m: number }>({ y: ty, m: tm })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The day the footer button will act on, or null for today.
   *
   * ONLY EVER AN EMPTY DAY. A day that already has a note opens on click, which
   * is safe and instant; a day that does not gets selected instead, and the
   * footer says what creating it would do. See the click handler for why.
   */
  const [picked, setPicked] = useState<string | null>(null)

  /**
   * date string -> vault path, for every note in Daily/ named like a date.
   *
   * The walk lives in `shared/planner.ts` rather than inline here, so a test can
   * assert what it actually returns — that `_Template.md` and a stray README are
   * not days, and that a vault with no `Daily/` folder is an empty map rather
   * than an error. This view is its only caller; the planner's calendar reads
   * dates out of frontmatter instead and never looks at this folder.
   */
  const notes = useMemo(
    () => ({ map: dailyNotes(tree), hasFolder: hasDailyFolder(tree) }),
    [tree],
  )

  const step = (delta: number): void => {
    setCursor(stepMonth(cursor.y, cursor.m, delta))
    // A selection in a month you have paged away from leaves the footer naming
    // a day that is not on screen, and the button would write it unseen.
    setPicked(null)
  }

  /**
   * Opens the day's note, WRITING IT FIRST IF IT DOES NOT EXIST.
   *
   * Reached from the footer button only. It used to be the click handler for
   * every cell in the grid, and that was the defect: looking at a month wrote a
   * file for every day you touched. A vault picked up eighteen identical empty
   * notes that way, four of them for days that had not happened yet, which is
   * the opposite of what a daily-notes practice is worth having.
   *
   * Creating is still one click — it is just a click on a control that SAYS it
   * creates, rather than on a number in a grid.
   */
  const open = async (date: string): Promise<void> => {
    const existing = notes.map.get(date)
    if (existing) {
      onOpenNote(existing)
      return
    }
    setBusy(true)
    setError(null)
    try {
      let template: string | null = null
      try {
        template = (await window.api.vault.read(DAILY_TEMPLATE)).text
      } catch {
        // No template is normal in another vault; a heading is the fallback.
      }
      // `save` stages its temp file in the target's parent, so the folder has
      // to exist first. Creating it when it does not is what lets this work in
      // a vault that has never had a daily note.
      if (!notes.hasFolder) {
        await window.api.vault.mkdir(DAILY_DIR)
      }
      const path = dailyPath(date)
      await window.api.vault.save(path, noteFromTemplate(template, date), 0)
      onCreated()
      onOpenNote(path)
    } catch (e) {
      setError(`Could not create ${date}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // One copy of the weekday arithmetic, in shared/planner.ts, so the sidebar
  // picker and the planner month can never lay a month out differently.
  const cells = monthCells(cursor.y, cursor.m)

  return (
    <div className="daily-view">
      <div className="daily-head">
        <button
          type="button"
          className="daily-nav"
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="daily-month">
          {MONTH_NAMES[cursor.m - 1]} {cursor.y}
        </span>
        <button
          type="button"
          className="daily-nav"
          onClick={() => step(1)}
          aria-label="Next month"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="daily-grid" role="grid" aria-label={`${MONTH_NAMES[cursor.m - 1]} ${cursor.y}`}>
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="daily-weekday" role="columnheader">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`b-${i}`} className="daily-cell daily-cell--blank" />
          const date = key(cursor.y, cursor.m, day)
          const has = notes.map.has(date)
          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              className={`daily-cell daily-day ${has ? 'daily-day--has' : ''} ${
                date === picked ? 'daily-day--picked' : ''
              } ${date === todayKey ? 'daily-day--today' : ''}`}
              /**
               * A CLICK NEVER WRITES A FILE. This is the whole fix.
               *
               * Every cell used to call the create-or-open path, so reading a
               * month wrote a note for each day you clicked — a vault collected
               * eighteen identical empty notes that way, four of them dated in
               * the future. Browsing a calendar is not consent to author in it.
               *
               * A day that HAS a note still opens on one click: that is safe,
               * reversible and the common case. A day that does not is merely
               * SELECTED, and the button below then offers to write it, saying
               * the date it would write. Same one click to create; it just has
               * to land on a control that admits what it does.
               */
              onClick={() => {
                if (has) onOpenNote(notes.map.get(date)!)
                else setPicked(date === picked ? null : date)
              }}
              disabled={busy}
              title={has ? `Open ${date}` : `Choose ${date}`}
              aria-label={
                has ? `Open note for ${date}` : `Choose ${date}, then use the button below to create it`
              }
              aria-pressed={has ? undefined : date === picked}
            >
              {day}
            </button>
          )
        })}
      </div>

      {/* THE ONLY CONTROL THAT CAN WRITE, and it says which day it would write.
          With nothing chosen it is about today, which is what this panel is
          opened for nine times in ten; choosing an empty day in the grid points
          it at that day instead. */}
      <button
        type="button"
        className={`daily-today ${picked ? 'daily-today--create' : ''}`}
        onClick={() => {
          if (picked) {
            void open(picked)
            setPicked(null)
            return
          }
          setCursor({ y: ty, m: tm })
          void open(todayKey)
        }}
        disabled={busy}
      >
        {picked
          ? `Create ${Number(picked.slice(8))} ${MONTH_NAMES[Number(picked.slice(5, 7)) - 1]}`
          : notes.map.has(todayKey)
            ? "Open today's note"
            : "Start today's note"}
      </button>

      {!notes.hasFolder && (
        <p className="daily-hint">
          No <code>{DAILY_DIR}/</code> folder yet. The first note you create makes it.
        </p>
      )}

      {error && (
        <p className="daily-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
