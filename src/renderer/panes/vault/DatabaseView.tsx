import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Calendar,
  ChevronDown,
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
  monthOf,
  statusTone,
  typeFamily,
  NONE,
  type TypeFamily,
  type VaultNoteMeta,
} from '../../../shared/notemeta.js'

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
 * relations, rollups, formulas. Every one needs a backend this app does not
 * have, or is a second way to say what [[wikilinks]] and the graph already say.
 *
 * Status is read-only here on purpose. Making a cell editable means writing
 * frontmatter back into the file, and the save path owns a lost-update guard
 * (`SaveConflict`) that a table cell has nowhere to show. That is a feature,
 * not a missing afternoon.
 */

/**
 * The four view shapes on the roadmap. Only `table` is built; the other three
 * are switchable and say so.
 *
 * They share one row set and one filter deliberately — that is the whole claim
 * of "many views, same rows". Building board/calendar/gallery is a rendering
 * job against `filtered` below, not a second query path, and keeping the
 * switcher here is what makes that obvious to whoever picks it up.
 */
type ViewMode = 'table' | 'board' | 'calendar' | 'gallery'

const VIEW_MODES: { key: ViewMode; label: string; Icon: LucideIcon; built: boolean }[] = [
  { key: 'table', label: 'Table', Icon: Table, built: true },
  { key: 'board', label: 'Board', Icon: Columns3, built: true },
  { key: 'gallery', label: 'Gallery', Icon: LayoutGrid, built: true },
  // Calendar stays unbuilt on purpose. Every other view is a re-rendering of
  // the same `groups`; a calendar is not — it needs `updated` as a real date,
  // and `monthOf` slices the string precisely because this vault's dates are
  // hand-written and `new Date()` on them silently shifts by timezone. Grouping
  // by Month is the honest version of it and already exists below.
  { key: 'calendar', label: 'Calendar', Icon: Calendar, built: false },
]

type SortKey = 'title' | 'area' | 'type' | 'status' | 'updated'
type GroupKey = 'area' | 'family' | 'type' | 'status' | 'tag' | 'folder' | 'month' | 'none'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'family', label: 'Category' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'tag', label: 'Tag' },
  { key: 'folder', label: 'Folder' },
  { key: 'month', label: 'Month' },
  { key: 'none', label: 'Nothing' },
]

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
  return n[key]
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

        <label className="db-control">
          Group by
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupKey)}
          >
            {GROUPS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>

        {/* Reachability is the one column Notion has no answer for, so it gets
            a control rather than being buried as a column you have to sort. */}
        <button
          type="button"
          className={`db-chip ${orphansOnly ? 'active' : ''}`}
          onClick={() => setOrphansOnly((v) => !v)}
          aria-pressed={orphansOnly}
          title="Notes not reachable from Home within 2 hops"
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
      ) : mode !== 'table' ? (
        <div className="db-empty db-empty--placeholder">
          <strong>{VIEW_MODES.find((v) => v.key === mode)?.label}</strong> is not built yet.
          <span>
            The rows, the filter and the grouping above are shared — this view is a
            rendering of the same {shown} notes, not a second query.
          </span>
        </div>
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
