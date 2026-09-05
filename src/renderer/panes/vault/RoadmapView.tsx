import { useMemo, useState } from 'react'
import { Check, ChevronRight, CircleDashed, CircleDot, Search } from 'lucide-react'
import {
  ROADMAP,
  countByStatus,
  type Feature,
  type FeatureStatus,
} from '../../../shared/roadmap.js'
import {
  STATE_ORDER,
  labelOf,
  stateOf,
  stateRank,
  type RoadmapState,
} from '../../../shared/roadmapStates.js'
import type { VaultNoteMeta } from '../../../shared/notemeta.js'

/**
 * THE ROADMAP SURFACE. Long-horizon work — the kind measured in weeks and
 * months — and the app's own feature list, in one place.
 *
 * It used to be only the second of those: `src/shared/roadmap.ts` rendered as a
 * flat list, reachable from the help dialog, with each row's note printed as a
 * paragraph underneath it. That is what Nathan meant by "a fat paragraph where
 * it is". Two things were wrong with it and they are different problems:
 *
 *   1. It could only ever describe FATE. A roadmap a person can put their own
 *      projects in is a different surface, and it is the one an agent working a
 *      year-long task needs.
 *   2. Everything was expanded, always. A roadmap you cannot scan is a document,
 *      and a document is what the vault is already for.
 *
 * So: rows collapse to one line and open on demand, groups collapse whole, and
 * there is a search box because the answer to "huge roadmaps" is not scrolling.
 *
 * WHERE THE ROWS COME FROM. Any note that carries a `status:` in its
 * frontmatter. No database, no sidecar file, and specifically NO new
 * convention — which was the first version and was wrong: requiring
 * `type: roadmap` matched 1 note out of the 15 in the author's own Roadmap
 * folder, because the notes were already written and they say
 * `type: project`, `type: decision`, `type: spec`.
 *
 * A status is what makes something roadmap-shaped: it is work with a state.
 * Measured on this vault, 61 notes of 1853 carry one — a roadmap, not a dump.
 * So a person makes a row by writing a note the way they already write notes,
 * and an agent makes one with the tools it already has.
 *
 * Read-only, like the view it replaces. Status lives in the note's frontmatter
 * and the note is the place to change it; an editable pill here would make this
 * a second source of truth about work the vault already records.
 */

const TONE: Record<FeatureStatus, { label: string; Icon: typeof Check }> = {
  built: { label: 'Built', Icon: Check },
  partial: { label: 'Partial', Icon: CircleDot },
  planned: { label: 'Planned', Icon: CircleDashed },
}

/** Which sort the list is under. Progress order is the default for a reason —
 *  see STATE_ORDER in shared/roadmapStates.ts. */
type Sort = 'state' | 'title' | 'updated'

const SORTS: { id: Sort; label: string }[] = [
  { id: 'state', label: 'State' },
  { id: 'title', label: 'Name' },
  { id: 'updated', label: 'Updated' },
]

function FeatureRow({ feature }: { feature: Feature }) {
  const { label, Icon } = TONE[feature.status]
  return (
    <li className={`roadmap-item roadmap-item--${feature.status}`}>
      <span className={`roadmap-pill roadmap-pill--${feature.status}`}>
        <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
        {label}
      </span>
      <div className="roadmap-item-body">
        <span className="roadmap-item-label">{feature.label}</span>
        {/* The note is the whole value of a `built` or `partial` row: it is the
            difference between "we think this works" and "this is what was
            verified, and this is the gap". */}
        {feature.note && <p className="roadmap-item-note">{feature.note}</p>}
      </div>
      {feature.surface && <span className="roadmap-item-surface">{feature.surface}</span>}
    </li>
  )
}

/**
 * One roadmap note, collapsed.
 *
 * The row is a button and the detail is a sibling, rather than the detail being
 * inside the button: a button containing a link is invalid, and the detail
 * carries the "open the note" action.
 */
function NoteRow({
  note,
  state,
  labels,
  open,
  onToggle,
  onOpenNote,
}: {
  note: VaultNoteMeta
  state: RoadmapState | null
  labels?: Partial<Record<RoadmapState, string>> | null
  open: boolean
  onToggle: () => void
  onOpenNote?: (path: string) => void
}) {
  // An unrecognised status keeps the word the note actually used. Showing
  // nothing would hide a real value; showing "Idea" would invent one.
  const pill = state ? labelOf(state, labels) : note.status || 'No state'
  return (
    <li className={`roadmap-row roadmap-row--${state ?? 'unknown'}`}>
      <button
        type="button"
        className="roadmap-row-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight
          size={14}
          className={`roadmap-chevron${open ? ' roadmap-chevron--open' : ''}`}
          aria-hidden="true"
        />
        <span className={`roadmap-pill roadmap-pill--${state ?? 'unknown'}`}>{pill}</span>
        <span className="roadmap-row-title">{note.title}</span>
        {note.updated && <span className="roadmap-row-updated">{note.updated}</span>}
      </button>
      {open && (
        <div className="roadmap-row-detail">
          <span className="roadmap-row-path">{note.path}</span>
          {note.tags.length > 0 && (
            <span className="roadmap-row-tags">
              {note.tags.map((t) => (
                <span className="roadmap-tag" key={t}>
                  {t}
                </span>
              ))}
            </span>
          )}
          {onOpenNote && (
            <button
              type="button"
              className="roadmap-row-open"
              onClick={() => onOpenNote(note.path)}
            >
              Open note
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export interface RoadmapViewProps {
  /** Every note in the vault, already loaded for the database. `null` while
   *  the scan is still running — an empty list and "not read yet" are
   *  different answers and the empty state says which. */
  notes: VaultNoteMeta[] | null
  onOpenNote?: (path: string) => void
  /** What this person or organisation calls each state. */
  stateLabels?: Partial<Record<RoadmapState, string>> | null
}

export function RoadmapView({ notes, onOpenNote, stateLabels }: RoadmapViewProps) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('state')
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set())
  const [shutGroups, setShutGroups] = useState<Set<string>>(() => new Set())
  // Fate's own list starts shut. It is the app talking about itself, and this
  // pane belongs to the person's work first.
  const [productOpen, setProductOpen] = useState(false)

  const counts = countByStatus()
  const total = counts.built + counts.partial + counts.planned

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = (notes ?? [])
      .filter((n) => n.status.trim() !== '')
      .filter(
        (n) =>
          q === '' ||
          n.title.toLowerCase().includes(q) ||
          n.folder.toLowerCase().includes(q) ||
          n.status.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q)),
      )

    const by = new Map<string, VaultNoteMeta[]>()
    for (const n of rows) {
      const key = n.folder || '(root)'
      const list = by.get(key)
      if (list) list.push(n)
      else by.set(key, [n])
    }

    // Sort INSIDE each group, then order the groups by name. Grouping is the
    // person's own folders, so alphabetical is the only order that is theirs
    // rather than ours.
    for (const list of by.values()) {
      list.sort((a, b) => {
        if (sort === 'title') return a.title.localeCompare(b.title)
        // Newest first: an `updated` you have to scroll to the bottom for is
        // the wrong end of the list. Missing dates sort last, not first.
        if (sort === 'updated') return (b.updated || '').localeCompare(a.updated || '')
        const d = stateRank(stateOf(a.status)) - stateRank(stateOf(b.status))
        return d !== 0 ? d : a.title.localeCompare(b.title)
      })
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [notes, query, sort])

  const shown = groups.reduce((n, [, list]) => n + list.length, 0)

  // Counts per state, across everything the filter left. The pipeline at a
  // glance, which is the question the pane is opened to answer.
  const stateCounts = useMemo(() => {
    const c = new Map<RoadmapState, number>()
    for (const [, list] of groups)
      for (const n of list) {
        const s = stateOf(n.status)
        if (s) c.set(s, (c.get(s) ?? 0) + 1)
      }
    return c
  }, [groups])

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  return (
    <div className="roadmap-view">
      <div className="roadmap-toolbar">
        <label className="roadmap-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="Search roadmaps"
            aria-label="Search roadmaps"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="roadmap-sort" role="group" aria-label="Sort by">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`roadmap-sort-btn${sort === s.id ? ' roadmap-sort-btn--on' : ''}`}
              aria-pressed={sort === s.id}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="roadmap-head">
        <div className="roadmap-counts">
          {STATE_ORDER.map((s) => (
            <span className={`roadmap-pill roadmap-pill--${s}`} key={s}>
              {stateCounts.get(s) ?? 0} {labelOf(s, stateLabels).toLowerCase()}
            </span>
          ))}
        </div>
        <span className="roadmap-total">
          {shown} {shown === 1 ? 'roadmap' : 'roadmaps'}
        </span>
      </div>

      {notes === null ? (
        <p className="roadmap-empty">Reading the vault…</p>
      ) : groups.length === 0 ? (
        <p className="roadmap-empty">
          {query
            ? 'Nothing matches that.'
            : 'No roadmaps yet. A note joins this list by carrying a status: in its frontmatter — idea, partial, complete or done, or your own words for those.'}
        </p>
      ) : (
        groups.map(([folder, list]) => {
          const shut = shutGroups.has(folder)
          return (
            <section className="roadmap-group" key={folder}>
              <button
                type="button"
                className="roadmap-group-title"
                aria-expanded={!shut}
                onClick={() => setShutGroups((s) => toggle(s, folder))}
              >
                <ChevronRight
                  size={14}
                  className={`roadmap-chevron${shut ? '' : ' roadmap-chevron--open'}`}
                  aria-hidden="true"
                />
                {folder}
                <span className="roadmap-group-count">{list.length}</span>
              </button>
              {!shut && (
                <ul className="roadmap-list">
                  {list.map((n) => (
                    <NoteRow
                      key={n.path}
                      note={n}
                      state={stateOf(n.status)}
                      labels={stateLabels}
                      open={openRows.has(n.path)}
                      onToggle={() => setOpenRows((s) => toggle(s, n.path))}
                      onOpenNote={onOpenNote}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}

      {/* Fate's own roadmap, last and shut. It is the same question in a
          different scope, and it is the app grading itself — which is worth
          having here, and is not what this pane is for. */}
      <section className="roadmap-group roadmap-group--product">
        <button
          type="button"
          className="roadmap-group-title"
          aria-expanded={productOpen}
          onClick={() => setProductOpen((v) => !v)}
        >
          <ChevronRight
            size={14}
            className={`roadmap-chevron${productOpen ? ' roadmap-chevron--open' : ''}`}
            aria-hidden="true"
          />
          Fate itself
          <span className="roadmap-group-count">{total}</span>
        </button>
        {productOpen && (
          <>
            <div className="roadmap-counts">
              <span className="roadmap-pill roadmap-pill--built">{counts.built} built</span>
              <span className="roadmap-pill roadmap-pill--partial">
                {counts.partial} partial
              </span>
              <span className="roadmap-pill roadmap-pill--planned">
                {counts.planned} planned
              </span>
            </div>
            {ROADMAP.map((group) => (
              <section className="roadmap-subgroup" key={group.title}>
                <h3 className="roadmap-subgroup-title">
                  {group.title}
                  {group.subtitle && (
                    <span className="roadmap-group-subtitle">{group.subtitle}</span>
                  )}
                </h3>
                <ul className="roadmap-list">
                  {group.features.map((f) => (
                    <FeatureRow feature={f} key={f.label} />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </section>
    </div>
  )
}
