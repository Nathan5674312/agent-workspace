/**
 * The planner page: two features that share a place and nothing else.
 *
 * The daily notes read a date from a FILENAME in `Daily/`; the calendar reads
 * one from `updated:` frontmatter. An earlier cut merged them — each day's
 * daily note rendered inside that day's calendar cell — and that was wrong: it
 * made a view over the whole vault into a writing surface for one folder, and
 * sprouted a "create this day" button on every empty day in the vault's
 * history. These tests exist partly to keep the two apart.
 *
 * `shared/planner.ts` holds both groupings, so this is where they are tested —
 * a .tsx module cannot be imported by `node --test`, because type stripping
 * does not handle JSX. The wiring is pinned at the bottom by reading sources,
 * which is the split canvas-snap.test.mjs already uses.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { dailyNotes, hasDailyFolder, monthCells, calendarBuckets, stepMonth } = await import(
  '../src/shared/planner.ts'
)

const note = (path, updated, title = path) => ({
  path,
  title,
  updated,
  folder: '(root)',
  type: '',
  status: '',
})

const tree = (...names) => ({
  name: 'vault',
  path: '',
  kind: 'folder',
  children: [
    {
      name: 'Daily',
      path: 'Daily',
      kind: 'folder',
      children: names.map((n) => ({ name: n, path: `Daily/${n}`, kind: 'note' })),
    },
  ],
})

// ── daily notes, off the tree ─────────────────────────────────────

test('a daily note is found by the shape of its filename', () => {
  const map = dailyNotes(tree('2026-08-18.md'))
  assert.equal(map.get('2026-08-18'), 'Daily/2026-08-18.md')
})

test('the template and anything else in the folder are not days', () => {
  // Shape, not a list of exceptions: adding a file to Daily/ must never turn
  // it into a calendar entry by accident.
  const map = dailyNotes(tree('_Template.md', 'README.md', '2026-08-18.md'))
  assert.deepEqual([...map.keys()], ['2026-08-18'])
})

test('a vault with no Daily folder yields an empty map, not an error', () => {
  assert.equal(dailyNotes({ name: 'v', path: '', kind: 'folder', children: [] }).size, 0)
  assert.equal(dailyNotes(null).size, 0)
})

test('having the folder is separate from having any notes in it', () => {
  // The view offers to CREATE the folder, so "empty" and "absent" are
  // different answers and the map alone cannot tell them apart.
  assert.equal(hasDailyFolder(tree()), true)
  assert.equal(hasDailyFolder(null), false)
})

// ── the calendar, off frontmatter ─────────────────────────────────

test('notes are grouped on the day their frontmatter claims', () => {
  const { byDay } = calendarBuckets([note('a.md', '2026-08-18'), note('b.md', '2026-08-18')])
  assert.equal(byDay.get('2026-08-18').length, 2)
})

test('a note with no usable date is CARRIED, not dropped', () => {
  // Most of this vault has no `updated:`. A calendar that quietly rendered 12
  // of 258 notes would be the most confident lie in the app, so these are
  // listed under the grid rather than silently omitted.
  const { byDay, undated } = calendarBuckets([
    note('a.md', ''),
    note('b.md', 'sometime'),
    note('c.md', '2026-13-99'),
  ])
  assert.equal(byDay.size, 0)
  assert.equal(undated.length, 3, 'undated notes went missing instead of being listed')
})

test('a timestamp still lands on its own day', () => {
  const { byDay } = calendarBuckets([note('a.md', '2026-08-18T23:30:00Z')])
  assert.ok(byDay.has('2026-08-18'))
})

test('the months with anything in them come back sorted', () => {
  // The jump control offers these, so their order IS the control's order.
  const { months } = calendarBuckets([
    note('a.md', '2026-08-18'),
    note('b.md', '2025-01-02'),
    note('c.md', '2026-08-19'),
  ])
  assert.deepEqual(months, ['2025-01', '2026-08'])
})

// ── the grid ──────────────────────────────────────────────────────

test('a month starts on the right weekday, Monday first', () => {
  // 1 August 2026 is a Saturday, so five blanks precede it.
  const cells = monthCells(2026, 8)
  assert.deepEqual(cells.slice(0, 6), [null, null, null, null, null, 1])
})

test('February knows about leap years', () => {
  assert.equal(monthCells(2024, 2).filter((c) => c !== null).length, 29)
  assert.equal(monthCells(2026, 2).filter((c) => c !== null).length, 28)
})

test('a month that starts on Monday has no leading blanks', () => {
  // 1 June 2026 is a Monday.
  assert.equal(monthCells(2026, 6)[0], 1)
})

test('stepping past December rolls the year', () => {
  assert.deepEqual(stepMonth(2026, 12, 1), { y: 2027, m: 1 })
  assert.deepEqual(stepMonth(2026, 1, -1), { y: 2025, m: 12 })
})

// ── the two features stay apart ───────────────────────────────────

test('the calendar has no idea daily notes exist', () => {
  // THE REGRESSION THIS SECTION EXISTS FOR. A daily note has an `updated:` like
  // any other note, so it appears on the calendar as an ordinary note on its
  // day — and that is all. Nothing gives it a special place in a cell.
  const rows = [note('Daily/2026-08-18.md', '2026-08-18'), note('other.md', '2026-08-18')]
  const { byDay } = calendarBuckets(rows)
  assert.deepEqual(
    byDay.get('2026-08-18').map((n) => n.path),
    ['Daily/2026-08-18.md', 'other.md'],
    'the calendar is treating the daily note as something other than a row',
  )
})

test('the two groupings read from different sources', () => {
  // A daily note carrying no `updated:` is still a daily note, and is on no day
  // of the calendar — which is right, and is why these cannot be one thing.
  const daily = dailyNotes(tree('2026-08-18.md'))
  const { byDay, undated } = calendarBuckets([note('Daily/2026-08-18.md', '')])
  assert.equal(daily.get('2026-08-18'), 'Daily/2026-08-18.md')
  assert.equal(byDay.size, 0)
  assert.equal(undated.length, 1)
})

// ── the wiring ────────────────────────────────────────────────────

test('the calendar is gone from the database', () => {
  const db = readSource('DatabaseView.tsx')
  assert.doesNotMatch(db, /key: 'calendar'/, 'the database still offers a calendar mode')
  assert.doesNotMatch(db, /function CalendarView/, 'the database still carries CalendarView')
  assert.match(db, /type ViewMode = 'table' \| 'board' \| 'gallery'/, 'ViewMode was not narrowed')
})

test('planner is a main view, not a sidebar list', () => {
  const main = readSource('MainCanvas.tsx')
  assert.match(main, /\| 'planner'/, 'MainView has no planner')
  assert.match(main, /view === 'planner' \? \(/, 'nothing renders the planner')
})

test('the calendar ribbon icon opens the planner', () => {
  const pane = readSource('VaultPane.tsx')
  assert.match(pane, /if \(id === 'calendar'\) handleViewChange\('planner'\)/)
  assert.match(pane, /planner: 'Planner'/, 'the planner tab has no label')
})

test('the planner is the calendar and nothing else', () => {
  // THE MERGE REGRESSION, read off the source. The calendar is a view over the
  // whole vault; it must not create files, and it must not carry the daily
  // notes inside it — those render in the sidebar, from VaultPane.
  const view = readSource('PlannerView.tsx')
  assert.match(view, /function Calendar\(/, 'the planner no longer carries the calendar')
  assert.doesNotMatch(
    view,
    /noteFromTemplate|dailyPath|DAILY_TEMPLATE|vault\.save/,
    'the calendar creates daily notes again',
  )
  assert.doesNotMatch(
    view,
    /<DailyNotesView/,
    'the daily notes are mounted twice — here and in the sidebar',
  )
})

test('the sidebar still owns the daily notes', () => {
  // The other half of the same rule: clicking the ribbon icon has to put the
  // notes somewhere, and the somewhere is where they always were.
  const pane = readSource('VaultPane.tsx')
  assert.match(pane, /<DailyNotesView/, 'nothing renders the daily notes any more')
})

test('clicking a day in the grid never writes a file', () => {
  /*
   * THE DEFECT THIS PINS, measured rather than imagined. Every cell used to
   * call the create-or-open path, so reading a month authored in it: the
   * author's own vault collected eighteen identical 127-byte notes in two
   * bursts of clicking, four of them dated in the FUTURE, against four real
   * hand-written ones. Browsing a calendar is not consent to write in it.
   *
   * The rule: a day with a note opens; a day without is only CHOSEN, and the
   * one control that can write says which day it would write.
   */
  const view = readSource('DailyNotesView.tsx')
  const cell = view.slice(view.indexOf('role="gridcell"'), view.indexOf('{day}'))
  assert.ok(cell.length > 0, 'the grid cell no longer has the shape this test reads')
  assert.doesNotMatch(cell, /open\(date\)/, 'a grid cell can create a note again')
  assert.match(cell, /setPicked\(/, 'an empty day is no longer merely chosen')
})

test('exactly one control in the daily panel can write', () => {
  // `open()` is the create-or-open path. If more than the footer button reaches
  // it, some other click has become able to author a file.
  const view = readSource('DailyNotesView.tsx')
  const calls = view.match(/void open\(/g) ?? []
  assert.equal(calls.length, 2, `expected the footer's two arms only, found ${calls.length}`)
})

test('picking a day shows the note, it does not just load it', () => {
  // THE BUG THIS PINS, which the planner introduced: `openNote` loads a note
  // without showing it. That was survivable while the calendar icon left the
  // main area alone, but the icon now opens the planner — so picking a day
  // loaded the note BEHIND the calendar and the click read as doing nothing.
  const pane = readSource('VaultPane.tsx')
  const mount = pane.slice(pane.indexOf('<DailyNotesView'), pane.indexOf('onCreated={vault.reload}'))
  assert.match(
    mount,
    /if \(await openNote\(path\)\) handleViewChange\('editor'\)/,
    'the daily notes open a note without switching to it',
  )
  // Conditional, or a refused open — a declined discard, a conflict dialog —
  // would still drag the user off the month they were reading.
  assert.doesNotMatch(mount, /void openNote\(path\)/, 'the open is unconditional again')
})

test('the calendar kept everything it had in the database', () => {
  const view = readSource('PlannerView.tsx')
  for (const [re, what] of [
    [/undated\.length > 0/, 'the undated list'],
    [/Jump to a month with notes/, 'the jump-to-month control'],
    [/months\[months\.length - 1\]/, 'opening on the most recent month with notes'],
  ]) {
    assert.match(view, re, `the calendar lost ${what}`)
  }
})

test('both month grids derive their weeks from one function', () => {
  // They each had their own copy of the weekday arithmetic, which is two
  // chances to get a leap year or a Sunday-start wrong.
  for (const f of ['DailyNotesView.tsx', 'PlannerView.tsx']) {
    const code = readSource(f)
    assert.match(code, /monthCells\(/, `${f} no longer uses the shared grid`)
    assert.doesNotMatch(code, /getUTCDay\(\)/, `${f} derives its own weekday offset again`)
  }
})
