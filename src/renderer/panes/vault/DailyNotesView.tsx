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
  dailyDateFromFilename,
  dailyPath,
  noteFromTemplate,
  todayLocal,
} from '../../../shared/daily.js'
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

  /** date string -> vault path, for every note in Daily/ named like a date. */
  const notes = useMemo(() => {
    const found = new Map<string, string>()
    const dir = tree?.children?.find(
      (c) => c.kind === 'folder' && c.name === DAILY_DIR,
    )
    for (const child of dir?.children ?? []) {
      if (child.kind !== 'note') continue
      // The filename IS the date. `_Template.md` and anything else in the
      // folder are skipped by this shape check rather than by name, so a
      // `README.md` in there does not become a calendar entry.
      const date = dailyDateFromFilename(child.name)
      if (date) found.set(date, child.path)
    }
    return { map: found, hasFolder: !!dir }
  }, [tree])

  const step = (delta: number): void => {
    const total = cursor.y * 12 + (cursor.m - 1) + delta
    setCursor({ y: Math.floor(total / 12), m: (total % 12) + 1 })
  }

  const open = async (date: string): Promise<void> => {
    const existing = notes.map.get(date)
    if (existing) {
      onOpenNote(existing)
      return
    }
    // Creating is the whole point of daily notes, and it is user-originated —
    // the person clicked the day. Same path "+ Note" uses.
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

  // Both UTC, so the grid's shape cannot shift with the local timezone even
  // though the DAYS it names are local.
  const firstWeekday = (new Date(Date.UTC(cursor.y, cursor.m - 1, 1)).getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(cursor.y, cursor.m, 0)).getUTCDate()
  const cells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

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
                date === todayKey ? 'daily-day--today' : ''
              }`}
              onClick={() => void open(date)}
              disabled={busy}
              // The title carries the whole affordance: a day with a note opens
              // it, a day without writes one. Those are different enough that
              // the control has to say which it will do before it is clicked.
              title={has ? `Open ${date}` : `Create ${DAILY_DIR}/${date}.md`}
              aria-label={has ? `Open note for ${date}` : `Create note for ${date}`}
            >
              {day}
            </button>
          )
        })}
      </div>

      <button
        type="button"
        className="daily-today"
        onClick={() => {
          setCursor({ y: ty, m: tm })
          void open(todayKey)
        }}
        disabled={busy}
      >
        {notes.map.has(todayKey) ? "Open today's note" : "Start today's note"}
      </button>

      {!notes.hasFolder && (
        <p className="daily-hint">
          No <code>{DAILY_DIR}/</code> folder yet. Picking a day creates it.
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
