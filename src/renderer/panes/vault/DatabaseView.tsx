import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  LayoutGrid,
  // Aliased: a bare `Map` import shadows the global Map constructor, and the
  // grouping below builds one.
  Map as MapIcon,
  Repeat,
  Search,
  Table,
  Columns3,
  Target,
  Unlink,
  type LucideIcon,
} from 'lucide-react'
import {
  areaOf,
  parseYmd,
  monthOf,
  statusTone,
  typeFamily,
  NONE,
  type TypeFamily,
  type VaultNoteMeta,
} from '../../../shared/notemeta.js'
import { SelectMenu } from './SelectMenu.js'

/**
 * The database view — the Notion half of the app.
 *
 * The graph shows how notes CONNECT. This shows what they ARE. Both read the
 * same markdown; neither is authoritative over the files.
 *
 * It implements the four things Notion does that Obsidian lacks and that a
 * local app can actually deliver:
 *
 *   1. Query, don't search   -> filter + sort, over fields not full text
 *   2. Typed properties      -> frontmatter as columns, not a convention
 *   3. Folders as an Area    -> one axis of many, not the only one
 *   4. Many views, same rows -> group by any column, no duplication
 *
 * Deliberately NOT built: sharing, permissions, comments, mobile, forms,
 * rollups, formulas. Every one needs a backend this app does not have.
 *
 * RELATIONS ARE BUILT, and this comment used to say they never would be —
 * "a second way to say what [[wikilinks]] and the graph already say". That
 * argument was right about the mechanism and wrong about the conclusion. The
 * wikilink IS the relation, so the Links and Backlinks columns do not add a
 * second way to say it; they show the one that already exists in a place you
 * can sort and group on. Nothing new is stored and nothing is written.
 *
 * The Notion-style typed relation — a frontmatter property whose value points
 * at another note — stays unbuilt, and now for a measured reason rather than
 * an assumed one: a scan of the vault on 2026-08-19 found a [[link]] inside a
 * frontmatter VALUE in 1 note of 280, against 653 resolved body edges. There
 * is no data for that feature to display.
 *
 * Status is read-only here on purpose. Making a cell editable means writing
 * frontmatter back into the file, and the save path owns a lost-update guard
 * (`SaveConflict`) that a table cell has nowhere to show. That is a feature,
 * not a missing afternoon.
 */

/**
 * The four view shapes on the roadmap. All four are built now.
 *
 * They share one row set and one filter deliberately — that is the whole claim
 * of "many views, same rows": Board and Gallery are re-renderings of the same
 * `groups` the table draws, and Calendar is the same rows placed by day. None
 * of them is a second query path.
 */
type ViewMode = 'table' | 'board' | 'calendar' | 'gallery'

const VIEW_MODES: { key: ViewMode; label: string; Icon: LucideIcon; built: boolean }[] = [
  { key: 'table', label: 'Table', Icon: Table, built: true },
  { key: 'board', label: 'Board', Icon: Columns3, built: true },
  { key: 'gallery', label: 'Gallery', Icon: LayoutGrid, built: true },
  // Calendar was the last of the four, because it is the only one that is not
  // just a re-rendering of `groups`: it needs `updated` as a real day, and this
  // vault's dates are hand-written. `parseYmd` is what made it honest — see
  // CalendarView for why `new Date()` on that string is not an option.
  { key: 'calendar', label: 'Calendar', Icon: Calendar, built: true },
]

type SortKey = 'title' | 'area' | 'type' | 'status' | 'updated' | 'links' | 'backlinks'
type GroupKey =
  | 'area' | 'family' | 'type' | 'status' | 'tag' | 'folder' | 'month' | 'linked' | 'none'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'family', label: 'Category' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'tag', label: 'Tag' },
  { key: 'folder', label: 'Folder' },
  { key: 'month', label: 'Month' },
  { key: 'linked', label: 'How linked' },
  { key: 'none', label: 'Nothing' },
]

/**
 * Backlink count → a bucket.
 *
 * Grouping on the raw number would make 30-odd sections of one row each, which
 * is a sorted table with headings, not a grouping. Buckets are what turn it
 * into an axis.
 *
 * This is the Orphans toggle's missing middle, though NOT in the way it first
 * appears. Zero backlinks implies orphan by construction — nothing links to a
 * note, so nothing can reach it — and measuring the vault confirms the two sets
 * are identical: 64 unreferenced, 64 of them orphans, 0 reachable-but-
 * unreferenced. So this grouping does not find a hidden class of orphan.
 *
 * What it finds is the 150 notes of 280 sitting on exactly 1–2 backlinks. The
 * boolean toggle calls all of them "fine" alongside a hub with 25, which is the
 * distinction that actually matters when deciding what to link up next.
 *
 * The labels lead with digits so `localeCompare(numeric: true)` in the group
 * sort orders them 1–2, 3–5, 6–10, 11+ and drops "Unreferenced" last.
 */
function linkBucket(backlinks: number): string {
  if (backlinks === 0) return 'Unreferenced'
  if (backlinks <= 2) return '1–2 backlinks'
  if (backlinks <= 5) return '3–5 backlinks'
  if (backlinks <= 10) return '6–10 backlinks'
  return '11+ backlinks'
}

/**
 * `sort: false` is Tags only, and it is not an oversight. Sorting a
 * multi-valued property means picking one of its values to sort by, which
 * silently answers a question the user did not ask. Tags are for grouping and
 * filtering — both of which they do, above.
 */
const COLUMNS: { key: SortKey | 'tags'; label: string; className: string; sort: boolean }[] = [
  { key: 'title', label: 'Name', className: 'db-col-title', sort: true },
  { key: 'area', label: 'Area', className: 'db-col-area', sort: true },
  { key: 'type', label: 'Type', className: 'db-col-type', sort: true },
  { key: 'status', label: 'Status', className: 'db-col-status', sort: true },
  { key: 'tags', label: 'Tags', className: 'db-col-tags', sort: false },
  // The relation pair. Two columns rather than one signed number because the
  // two directions answer different questions — "what does this note draw on"
  // and "what depends on it" — and a hub is interesting for having a large
  // value in either.
  { key: 'links', label: 'Links', className: 'db-col-num', sort: true },
  { key: 'backlinks', label: 'Backlinks', className: 'db-col-num', sort: true },
  { key: 'updated', label: 'Updated', className: 'db-col-updated', sort: true },
]

/**
 * The four type families, their icon and their human label.
 *
 * Icon rather than colour is the whole point — see `typeFamily` in notemeta.ts
 * for why this palette cannot spend a hue on a category.
 */
const FAMILIES: Record<Exclude<TypeFamily, 'none'>, { label: string; Icon: LucideIcon }> = {
  structure: { label: 'Structure', Icon: MapIcon },
  work: { label: 'Work', Icon: Target },
  reference: { label: 'Reference', Icon: BookOpen },
  routine: { label: 'Routine', Icon: Repeat },
}

/** The value a row sorts by, for one column. */
function field(n: VaultNoteMeta, key: SortKey): string {
  if (key === 'area') return areaOf(n)
  if (key === 'title') return n.title
  const v = n[key]
  // The counts sort correctly as strings BECAUSE the comparator below passes
  // `numeric: true` — that collation reads "42" as forty-two, so 9 sorts before
  // 42 rather than after it. Returning a number here instead would need a
  // second comparator for two columns.
  return typeof v === 'number' ? String(v) : v
}

/**
 * The buckets one row belongs to, for the current grouping.
 *
 * Returns an ARRAY, not a string, because `tag` is multi-valued: a note tagged
 * `[design, ui]` belongs under both, exactly as a Notion multi-select does.
 * Every other axis returns one entry. This is also why the row count shown in
 * the toolbar comes from the filtered rows and not from summing the groups —
 * under Tag those two numbers legitimately differ.
 */
function groupValues(n: VaultNoteMeta, key: GroupKey): string[] {
  switch (key) {
    case 'area': return [areaOf(n)]
    case 'family': {
      const f = typeFamily(n.type)
      return [f === 'none' ? '' : FAMILIES[f].label]
    }
    case 'type': return [n.type]
    case 'status': return [n.status]
    case 'tag': return n.tags.length ? n.tags : ['']
    case 'folder': return [n.folder]
    case 'month': return [monthOf(n.updated)]
    case 'linked': return [linkBucket(n.backlinks)]
    default: return ['']
  }
}

/* statusTone lives in shared/notemeta.ts, not here: it is logic about
   frontmatter values, the same as areaOf, and a .tsx module cannot be imported
   by the node --test suite (type stripping does not handle JSX). */

/**
 * The type, carrying its family as an icon.
 *
 * The icon is the category and the text is the value, so a scan down the
 * column sorts 40-odd freeform types into four shapes without the palette
 * having to spend a hue on it. An unknown type keeps the plain chip it has
 * today rather than being assigned a family it did not ask for.
 */
function TypeChip({ type }: { type: string }) {
  const family = typeFamily(type)
  const meta = family === 'none' ? null : FAMILIES[family]
  return (
    <span
      className={`db-tag db-fam-${family}`}
      title={meta ? `${type} — ${meta.label}` : type}
    >
      {meta && <meta.Icon size={11} aria-hidden="true" />}
      {type}
    </span>
  )
}

/**
 * Tags, capped at two.
 *
 * Uncapped, one note with nine tags sets the row height for all 258 and the
 * table stops being scannable. Two rather than three because the column is
 * fixed-width: a third chip made all of them ellipsise to four letters, which
 * is less information than showing fewer of them honestly. The full list is in
 * the cell's title, and Group by → Tag is the real answer to "show me
 * everything tagged X".
 */
const TAG_CAP = 2

function TagList({ tags, blank = true }: { tags: string[]; blank?: boolean }) {
  if (!tags.length) return blank ? <span className="db-blank">{NONE}</span> : null
  const head = tags.slice(0, TAG_CAP)
  const rest = tags.length - head.length
  return (
    <span className="db-tags" title={tags.join(', ')}>
      {head.map((t) => (
        <span key={t} className="db-tag db-tag-muted">
          {t}
        </span>
      ))}
      {rest > 0 && <span className="db-tag-more">+{rest}</span>}
    </span>
  )
}

/**
 * One note as a card, shared by Board and Gallery.
 *
 * A real <button>, not a div with onClick: these views have no table row to
 * carry the semantics the way the table's cells do, so the card itself has to
 * be the control or the whole view falls out of the keyboard path.
 */
function NoteCard({
  n,
  onOpenNote,
}: {
  n: VaultNoteMeta
  onOpenNote: (path: string) => void
}) {
  return (
    <button
      type="button"
      className="db-card"
      title={n.path}
      onClick={() => onOpenNote(n.path)}
    >
      <span className="db-card-title">{n.title}</span>
      {(n.type || n.status) && (
        <span className="db-card-chips">
          {n.type && <TypeChip type={n.type} />}
          {n.status && (
            <span className={`db-tag db-tone-${statusTone(n.status)}`}>{n.status}</span>
          )}
        </span>
      )}
      <TagList tags={n.tags} blank={false} />
      <span className="db-card-foot">
        {areaOf(n)}
        {n.updated && ` · ${n.updated}`}
        {n.orphan && <Unlink size={10} aria-label="Orphan" />}
      </span>
    </button>
  )
}

type Group = { name: string; rows: VaultNoteMeta[] }

/**
 * Board — the same groups, laid on their side.
 *
 * This is the claim in the header comment made good: it renders `groups`, the
 * identical array the table renders, so the filter, the grouping and the sort
 * above it all keep working with no second query path.
 *
 * Ungrouped it would be one column of 258 cards, which is a worse table. The
 * control that fixes it is the one already in the toolbar, so it says so rather
 * than silently picking a grouping on the user's behalf.
 */
function BoardView({
  groups,
  grouped,
  onOpenNote,
}: {
  groups: Group[]
  grouped: boolean
  onOpenNote: (path: string) => void
}) {
  if (!grouped) {
    return (
      <div className="db-empty db-empty--placeholder">
        <strong>Board needs a grouping.</strong>
        <span>Pick anything other than “Nothing” in Group by, and each value becomes a column.</span>
      </div>
    )
  }
  return (
    <div className="db-board">
      {groups.map((g) => (
        <section key={g.name} className="db-board-col">
          <header className="db-board-head">
            <span className="db-group-name">{g.name}</span>
            <span className="db-group-count">{g.rows.length}</span>
          </header>
          <div className="db-board-cards">
            {g.rows.map((n) => (
              <NoteCard key={n.path} n={n} onOpenNote={onOpenNote} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * Calendar — the same rows, placed on the day their frontmatter claims.
 *
 * THE DATE PROBLEM, which is why this was the last view built and why the
 * switcher carried a "not built yet" note rather than a rough version:
 * `updated` is hand-written and `new Date()` on it lies in two directions — it
 * accepts things that are not dates, and it reads a bare `YYYY-MM-DD` as UTC
 * midnight, which renders as the previous day in any negative-offset timezone.
 * `parseYmd` reads the digits instead and refuses everything else, so a note
 * lands on the day it says or on no day at all.
 *
 * UNDATED NOTES ARE SHOWN, not dropped. Most of this vault has no `updated`,
 * and a calendar that quietly renders 12 of 258 notes would be the most
 * confident lie in the app. They get a labelled list under the grid.
 *
 * Weeks start Monday, matching the ISO convention the vault's own date strings
 * follow.
 */
function CalendarView({
  rows,
  onOpenNote,
}: {
  rows: VaultNoteMeta[]
  onOpenNote: (path: string) => void
}) {
  /** path -> day, computed once per row set. */
  const { byDay, undated, months } = useMemo(() => {
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
  }, [rows])

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
      <div className="db-empty db-empty--placeholder">
        <strong>No dated notes.</strong>
        <span>
          {rows.length} note{rows.length === 1 ? '' : 's'} match, and none carries an
          ISO <code>updated:</code> date to place on a calendar.
        </span>
      </div>
    )
  }

  const [yStr, mStr] = current.split('-')
  const y = Number(yStr)
  const m = Number(mStr)

  // Both UTC, so no local-timezone shift can creep into the layout.
  const firstWeekday = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7 // Mon=0
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()

  const step = (delta: number): void => {
    const total = y * 12 + (m - 1) + delta
    const ny = Math.floor(total / 12)
    const nm = (total % 12) + 1
    setCursor(`${ny}-${String(nm).padStart(2, '0')}`)
  }

  const cells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  return (
    <div className="db-calendar">
      <div className="db-cal-head">
        <button type="button" className="db-cal-nav" onClick={() => step(-1)} aria-label="Previous month">
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="db-cal-month">
          {MONTH_NAMES[m - 1]} {y}
        </span>
        <button type="button" className="db-cal-nav" onClick={() => step(1)} aria-label="Next month">
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        {/* Jumping to a month that HAS something beats paging through empties. */}
        <SelectMenu
          id="db-cal-jump-menu"
          label="Jump to a month with notes"
          className="db-cal-jump"
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

      <div className="db-cal-grid" role="grid" aria-label={`${MONTH_NAMES[m - 1]} ${y}`}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="db-cal-weekday" role="columnheader">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`blank-${i}`} className="db-cal-cell db-cal-cell--blank" />
          const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const notes = byDay.get(key) ?? []
          return (
            <div key={key} className="db-cal-cell" role="gridcell">
              <span className="db-cal-day">{day}</span>
              {notes.map((n) => (
                <button
                  key={n.path}
                  type="button"
                  className="db-cal-note"
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
        <div className="db-cal-undated">
          <h3 className="db-cal-undated-title">
            {undated.length} without a usable date
          </h3>
          <p className="db-cal-undated-note">
            No <code>updated:</code> field, or one a calendar cannot place. They are
            counted in the toolbar and are not on the grid.
          </p>
          <div className="db-cal-undated-list">
            {undated.map((n) => (
              <button
                key={n.path}
                type="button"
                className="db-cal-note"
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

/** Gallery — the same groups as a card grid, stacked rather than side by side. */
function GalleryView({
  groups,
  grouped,
  onOpenNote,
}: {
  groups: Group[]
  grouped: boolean
  onOpenNote: (path: string) => void
}) {
  return (
    <div className="db-gallery">
      {groups.map((g) => (
        <section key={g.name || '__all__'}>
          {grouped && (
            <header className="db-gallery-head">
              <span className="db-group-name">{g.name}</span>
              <span className="db-group-count">{g.rows.length}</span>
            </header>
          )}
          <div className="db-gallery-grid">
            {g.rows.map((n) => (
              <NoteCard key={n.path} n={n} onOpenNote={onOpenNote} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export interface DatabaseViewProps {
  notes: VaultNoteMeta[] | null
  loading: boolean
  error: string | null
  onOpenNote: (path: string) => void
}

export function DatabaseView({
  notes,
  loading,
  error,
  onOpenNote,
}: DatabaseViewProps) {
  const [query, setQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupKey>('area')
  const [sortBy, setSortBy] = useState<SortKey>('title')
  const [desc, setDesc] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [orphansOnly, setOrphansOnly] = useState(false)
  const [mode, setMode] = useState<ViewMode>('table')

  // Changing the grouping rebuilds every section, so collapse state from the
  // old grouping names nothing. Kept, it silently hides sections in the new one.
  useEffect(() => setCollapsed(new Set()), [groupBy])

  const { groups, shown } = useMemo(() => {
    if (!notes) return { groups: [], shown: 0 }
    const q = query.trim().toLowerCase()

    const rows = notes.filter((n) => {
      if (orphansOnly && !n.orphan) return false
      if (!q) return true
      // Path and tags are searched as well as title, so "business/claude" and
      // "#design" both work. This is the ONLY full-text-ish thing here;
      // everything else queries a field.
      return (
        n.title.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q))
      )
    })

    const dir = desc ? -1 : 1
    const cmp = (a: VaultNoteMeta, b: VaultNoteMeta) => {
      const av = field(a, sortBy)
      const bv = field(b, sortBy)
      // Empty always sorts last regardless of direction. 190 of 258 notes have
      // no type; letting blanks lead means the default view opens on a wall of
      // nothing, which reads as broken rather than as sorted.
      if (!av !== !bv) return av ? -1 : 1
      return av.localeCompare(bv, undefined, { numeric: true }) * dir
    }

    if (groupBy === 'none') {
      return { groups: [{ name: '', rows: [...rows].sort(cmp) }], shown: rows.length }
    }

    const by = new Map<string, VaultNoteMeta[]>()
    for (const n of rows) {
      for (const raw of groupValues(n, groupBy)) {
        const k = raw || NONE
        const bucket = by.get(k)
        if (bucket) bucket.push(n)
        else by.set(k, [n])
      }
    }
    const groups = [...by.entries()]
      .map(([name, rs]) => ({ name, rows: rs.sort(cmp) }))
      .sort((a, b) => {
        // The empty bucket sinks, for the same reason blanks sort last.
        if ((a.name === NONE) !== (b.name === NONE)) return a.name === NONE ? 1 : -1
        return a.name.localeCompare(b.name, undefined, { numeric: true })
      })
    return { groups, shown: rows.length }
  }, [notes, query, groupBy, sortBy, desc, orphansOnly])

  const toggleSort = (key: SortKey) => {
    if (key === sortBy) setDesc((d) => !d)
    else {
      setSortBy(key)
      setDesc(false)
    }
  }

  const toggleGroup = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(name)) next.add(name)
      return next
    })

  if (error) return <div className="vault-graph-error">Database failed: {error}</div>
  if (loading && !notes) return <div className="db-empty">Loading notes…</div>
  if (!notes) return <div className="db-empty">No notes.</div>

  return (
    <div className="db-view">
      <div className="db-modes" role="tablist" aria-label="Database view">
        {VIEW_MODES.map(({ key, label, Icon, built }) => (
          <button
            key={key}
            role="tab"
            type="button"
            className={`db-mode ${mode === key ? 'active' : ''}`}
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            title={built ? label : `${label} — not built yet`}
          >
            <Icon size={13} aria-hidden="true" />
            {label}
            {!built && <span className="db-mode-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="db-toolbar">
        <label className="db-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or path"
            aria-label="Filter notes"
          />
        </label>

        <span className="db-control">
          Group by
          <SelectMenu
            id="db-group-by-menu"
            label="Group by"
            value={groupBy}
            options={GROUPS.map((g) => ({ value: g.key, label: g.label }))}
            onChange={setGroupBy}
          />
        </span>

        {/* Reachability is the one column Notion has no answer for, so it gets
            a control rather than being buried as a column you have to sort.

            The tooltip names the root it actually measured from rather than
            asserting "Home". That claim was hardcoded, and when there was no
            Home.md at the vault root it was both wrong AND hiding that every
            note in the vault had just been flagged. */}
        <button
          type="button"
          className={`db-chip ${orphansOnly ? 'active' : ''}`}
          onClick={() => setOrphansOnly((v) => !v)}
          aria-pressed={orphansOnly}
          title={
            notes[0]?.reachRoot
              ? `Notes not reachable from ${notes[0].reachRoot} within 2 hops`
              : 'Nothing in this vault links to anything, so there is no root to measure from — every note counts as an orphan'
          }
        >
          <Unlink size={12} aria-hidden="true" />
          Orphans
        </button>

        <span className="db-count">
          {shown === notes.length
            ? `${notes.length} notes`
            : `${shown} of ${notes.length}`}
        </span>
      </div>

      {mode === 'board' ? (
        <BoardView
          groups={groups}
          grouped={groupBy !== 'none'}
          onOpenNote={onOpenNote}
        />
      ) : mode === 'gallery' ? (
        <GalleryView
          groups={groups}
          grouped={groupBy !== 'none'}
          onOpenNote={onOpenNote}
        />
      ) : mode === 'calendar' ? (
        /* The one view that ignores `groupBy`: a calendar IS a grouping, by day.
           It still honours the search and the orphans filter, which is what
           "same rows, many views" actually promises. Deduped by path because
           grouping by tag legitimately puts one note in several groups. */
        <CalendarView
          rows={[...new Map(groups.flatMap((g) => g.rows).map((n) => [n.path, n])).values()]}
          onOpenNote={onOpenNote}
        />
      ) : (
      <div className="db-scroll">
        <table className="db-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.className}
                  aria-sort={
                    c.sort && sortBy === c.key
                      ? desc
                        ? 'descending'
                        : 'ascending'
                      : 'none'
                  }
                >
                  {c.sort ? (
                    <button type="button" onClick={() => toggleSort(c.key as SortKey)}>
                      {c.label}
                      {sortBy === c.key && (
                        <span className="db-sort" aria-hidden="true">
                          {desc ? '↓' : '↑'}
                        </span>
                      )}
                    </button>
                  ) : (
                    // Not a button, because it does nothing when pressed. The
                    // whole point of docs/buttons/INDEX.md is that this app does
                    // not ship controls that only look like controls.
                    <span className="db-th-static">{c.label}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>

          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.name)
            return (
              <tbody key={g.name || '__all__'}>
                {groupBy !== 'none' && (
                  <tr className="db-group">
                    <th colSpan={COLUMNS.length}>
                      <button type="button" onClick={() => toggleGroup(g.name)}>
                        {isCollapsed ? (
                          <ChevronRight size={13} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={13} aria-hidden="true" />
                        )}
                        <span className="db-group-name">{g.name}</span>
                        <span className="db-group-count">{g.rows.length}</span>
                      </button>
                    </th>
                  </tr>
                )}
                {!isCollapsed &&
                  g.rows.map((n) => (
                    <tr
                      key={n.path}
                      className="db-row"
                      title={n.path}
                      // Mouse convenience only. The row carries NO role and no
                      // tabIndex: overriding a <tr>'s implicit `row` role with
                      // `button` leaves the rowgroup without valid row children
                      // and assistive tech loses the row/column-header
                      // association that using a real <table> bought in the
                      // first place. The keyboard path is the button below.
                      onClick={() => onOpenNote(n.path)}
                    >
                      <td className="db-col-title">
                        {/* An anchor for the eye at the start of every row. At
                            258 rows the title alone gives the scan nothing to
                            land on. */}
                        <FileText size={13} className="db-icon" aria-hidden="true" />
                        {/* The real control. A focusable element inside the
                            cell keeps the row a row, and gives keyboard users
                            the note's name as the accessible name rather than
                            a nameless "button". */}
                        <button type="button" className="db-title" onClick={(e) => {
                          // The row's own onClick would otherwise fire too and
                          // open the note twice.
                          e.stopPropagation()
                          onOpenNote(n.path)
                        }}>
                          {n.title}
                        </button>
                        {n.orphan && (
                          <Unlink
                            size={11}
                            className="db-orphan"
                            aria-label="Orphan"
                          />
                        )}
                      </td>
                      {/* Area is plain text, not a chip. Chips on all three
                          columns gave Area, Type and Status one visual weight,
                          so none of them read as more important than the
                          others. And when the table is grouped BY area, every
                          row repeats its own group heading -- 57 identical
                          chips inside "Business". It stays for sorting and for
                          the ungrouped view, dimmed to what it is worth. */}
                      <td className="db-col-area">{areaOf(n)}</td>
                      <td className="db-col-type">
                        {/* 190 of 258 notes have no type. A truly empty cell
                            reads as a rendering failure; an em-dash reads as an
                            answer. */}
                        {n.type ? (
                          <TypeChip type={n.type} />
                        ) : (
                          <span className="db-blank">{NONE}</span>
                        )}
                      </td>
                      <td className="db-col-status">
                        {n.status ? (
                          <span className={`db-tag db-tone-${statusTone(n.status)}`}>
                            {n.status}
                          </span>
                        ) : (
                          <span className="db-blank">{NONE}</span>
                        )}
                      </td>
                      <td className="db-col-tags">
                        <TagList tags={n.tags} />
                      </td>
                      {/* Zero renders as the em-dash every other empty cell
                          uses, not as "0". A note with no links has no
                          relations to show, which is the same statement the
                          blank Type and Status cells make. */}
                      <td className="db-col-num">
                        {n.links || <span className="db-blank">{NONE}</span>}
                      </td>
                      <td className="db-col-num">
                        {n.backlinks || <span className="db-blank">{NONE}</span>}
                      </td>
                      <td className="db-col-updated">
                        {n.updated || <span className="db-blank">{NONE}</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            )
          })}
        </table>

        {shown === 0 && <div className="db-empty">Nothing matches.</div>}
      </div>
      )}
    </div>
  )
}
