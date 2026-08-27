/**
 * The planner page: two separate features that share a place.
 *
 * The daily notes and the calendar are NOT one feature and must not be built as
 * one. That was tried and it was wrong: putting each day's daily note inside
 * the calendar cell beside its dated notes made the calendar answer a question
 * it was never asking, and turned a view over the whole vault into a writing
 * surface for one folder. They answer different questions and they read dates
 * out of different places on purpose.
 *
 *   DAILY NOTES  read the date from a FILENAME in `Daily/`. A day is a note you
 *                write, and the useful gesture on an empty day is to create it.
 *
 *   CALENDAR     reads the date from `updated:` frontmatter. A day is every
 *                note you touched, and the useful gesture is to open one.
 *
 * They share a SCREEN, not a container: clicking the calendar icon puts the
 * daily notes in the sidebar and the calendar in the main area. Nothing below
 * merges them; the two groupings never meet.
 *
 * These are pure because a .tsx module cannot be imported by the `node --test`
 * suite — type stripping does not handle JSX — and the date arithmetic is the
 * part worth testing.
 */

import { DAILY_DIR, dailyDateFromFilename } from './daily.js'
import { parseYmd, type VaultNoteMeta } from './notemeta.js'
import type { VaultTreeNode } from './ipc.js'

/**
 * Every daily note in the vault, by its date.
 *
 * The FILENAME is the date, and the shape check is what keeps `_Template.md`
 * and a stray `README.md` in that folder from becoming calendar entries — the
 * same rule `dailyDateFromFilename` already enforces, applied to the tree the
 * explorer draws rather than to a second listing of the same folder.
 *
 * A vault with no `Daily/` folder yields an empty map, which is not an error:
 * it is a vault that has not started the practice, and the view offers to.
 */
export function dailyNotes(tree: VaultTreeNode | null): Map<string, string> {
  const found = new Map<string, string>()
  const dir = tree?.children?.find((c) => c.kind === 'folder' && c.name === DAILY_DIR)
  for (const child of dir?.children ?? []) {
    if (child.kind !== 'note') continue
    const date = dailyDateFromFilename(child.name)
    if (date) found.set(date, child.path)
  }
  return found
}

/** Is there a `Daily/` folder at all? Separate from the map, which is empty either way. */
export function hasDailyFolder(tree: VaultTreeNode | null): boolean {
  return !!tree?.children?.some((c) => c.kind === 'folder' && c.name === DAILY_DIR)
}

/**
 * The calendar's three buckets, exactly as the database view computed them.
 *
 * `parseYmd` rather than `new Date()`, and that is load-bearing rather than
 * fussy: `updated:` is hand-written, and `new Date()` on it lies in two
 * directions — it accepts strings that are not dates, and it reads a bare
 * `YYYY-MM-DD` as UTC midnight, which renders as the PREVIOUS day in any
 * negative-offset timezone. So a note lands on the day it says or on no day.
 *
 * UNDATED NOTES ARE CARRIED, not dropped. Most of this vault has no `updated:`,
 * and a calendar that quietly rendered 12 of 258 notes would be the most
 * confident lie in the app. The view lists them under the grid.
 *
 * `months` is every month that has anything, sorted, so the view can offer a
 * jump to one rather than making someone page through empties.
 */
export function calendarBuckets(rows: readonly VaultNoteMeta[]): {
  byDay: Map<string, VaultNoteMeta[]>
  undated: VaultNoteMeta[]
  months: string[]
} {
  const byDay = new Map<string, VaultNoteMeta[]>()
  const undated: VaultNoteMeta[] = []
  const months = new Set<string>()
  for (const n of rows) {
    const ymd = parseYmd(n.updated)
    if (!ymd) {
      undated.push(n)
      continue
    }
    const key = `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`
    months.add(key.slice(0, 7))
    const bucket = byDay.get(key)
    if (bucket) bucket.push(n)
    else byDay.set(key, [n])
  }
  return { byDay, undated, months: [...months].sort() }
}

/**
 * The cells of a month grid, Monday first, with leading blanks for the offset.
 *
 * ONE COPY. Both calendars derived this independently and identically, which is
 * two chances to get a leap year or a Sunday-start wrong and no way for a test
 * to catch either.
 *
 * UTC throughout, so the SHAPE of the grid cannot shift with the local
 * timezone even though the days it names are local. Monday-first matches the
 * ISO convention the vault's own date strings already follow.
 */
export function monthCells(y: number, m: number): (number | null)[] {
  const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
}

/** Step a `{y, m}` cursor by whole months, wrapping the year correctly. */
export function stepMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const total = y * 12 + (m - 1) + delta
  return { y: Math.floor(total / 12), m: (total % 12) + 1 }
}

