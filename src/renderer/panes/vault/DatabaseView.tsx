import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Search, Unlink } from 'lucide-react'
import {
  areaOf,
  statusTone,
  NONE,
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

type SortKey = 'title' | 'area' | 'type' | 'status' | 'updated'
type GroupKey = 'area' | 'type' | 'status' | 'none'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'none', label: 'Nothing' },
]

const COLUMNS: { key: SortKey; label: string; className: string }[] = [
  { key: 'title', label: 'Name', className: 'db-col-title' },
  { key: 'area', label: 'Area', className: 'db-col-area' },
  { key: 'type', label: 'Type', className: 'db-col-type' },
  { key: 'status', label: 'Status', className: 'db-col-status' },
  { key: 'updated', label: 'Updated', className: 'db-col-updated' },
]

/** The value a row sorts and groups by, for one column. */
function field(n: VaultNoteMeta, key: SortKey): string {
  if (key === 'area') return areaOf(n)
  if (key === 'title') return n.title
  return n[key]
}

/* statusTone lives in shared/notemeta.ts, not here: it is logic about
   frontmatter values, the same as areaOf, and a .tsx module cannot be imported
   by the node --test suite (type stripping does not handle JSX). */

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

  // Changing the grouping rebuilds every section, so collapse state from the
  // old grouping names nothing. Kept, it silently hides sections in the new one.
  useEffect(() => setCollapsed(new Set()), [groupBy])

  const groups = useMemo(() => {
    if (!notes) return []
    const q = query.trim().toLowerCase()

    const rows = notes.filter((n) => {
      if (orphansOnly && !n.orphan) return false
      if (!q) return true
      // Path is searched as well as title so "business/claude" works. This is
      // the ONLY full-text-ish thing here; everything else queries a field.
      return n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
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
      return [{ name: '', rows: [...rows].sort(cmp) }]
    }

    const by = new Map<string, VaultNoteMeta[]>()
    for (const n of rows) {
      const k = field(n, groupBy) || NONE
      const bucket = by.get(k)
      if (bucket) bucket.push(n)
      else by.set(k, [n])
    }
    return [...by.entries()]
      .map(([name, rs]) => ({ name, rows: rs.sort(cmp) }))
      .sort((a, b) => {
        // The empty bucket sinks, for the same reason blanks sort last.
        if ((a.name === NONE) !== (b.name === NONE)) return a.name === NONE ? 1 : -1
        return a.name.localeCompare(b.name, undefined, { numeric: true })
      })
  }, [notes, query, groupBy, sortBy, desc, orphansOnly])

  const shown = groups.reduce((sum, g) => sum + g.rows.length, 0)

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

      <div className="db-scroll">
        <table className="db-table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.className}
                  aria-sort={
                    sortBy === c.key ? (desc ? 'descending' : 'ascending') : 'none'
                  }
                >
                  <button type="button" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sortBy === c.key && (
                      <span className="db-sort" aria-hidden="true">
                        {desc ? '↓' : '↑'}
                      </span>
                    )}
                  </button>
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
                          <span className="db-tag">{n.type}</span>
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
    </div>
  )
}
