import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
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
import { facets, facetKeys, neighbourhoods } from '../../../shared/facets.js'
import type { VaultGraph } from '../../../shared/ipc.js'
import { SelectMenu } from './SelectMenu.js'
import { isSaveConflict } from './helpers.js'

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
 * ~~Status is read-only here on purpose. Making a cell editable means writing
 * frontmatter back into the file, and the save path owns a lost-update guard
 * (`SaveConflict`) that a table cell has nowhere to show. That is a feature,
 * not a missing afternoon.~~
 *
 * **Superseded 2026-08-27. Type and Status are editable, and they write into
 * the note's own Markdown.** The argument above was wrong in its second half.
 * The guard is real and stayed exactly as it was — nothing about it needed
 * weakening — but "nowhere to show it" was never true: <VersionsView> already
 * reports a SaveConflict inline without opening the conflict dialog, which is
 * about the edit buffer and has nothing to offer a table cell. The cell does
 * the same, and marks itself. See `PropertyCell` below and `handleSetProperty`
 * in VaultPane.
 *
 * WHY IT CHANGED, which is not "someone had an afternoon": a reader put the
 * case better than the original comment did — the appealing thing is not three
 * powerful views, it is changing view without changing where the truth lives.
 * A table that can only read is a fourth place to look; a table that writes
 * `status:` into the file is the same note seen side-on. The Markdown stays the
 * only store. Nothing is cached, mirrored, or kept in a database of our own.
 *
 * Still read-only, and each for a reason rather than a backlog: Area is derived
 * from the folder, so moving the note IS the edit; Links and Backlinks are the
 * wikilinks in the body; Updated is a stamp; Tags is a list, and `setFrontmatter`
 * writes scalars only because this vault contains both list spellings and
 * picking one would rewrite the other.
 */

/**
 * ONE EDITABLE PROPERTY CELL — the write half of "many views, same rows".
 *
 * This is the control the file header used to say would not be built, and the
 * argument against it was: the save path owns a lost-update guard that a table
 * cell has nowhere to show. That was the wrong half of the problem. <VersionsView>
 * already reports a SaveConflict inline without opening the conflict dialog,
 * which is about the edit buffer and has nothing to offer a cell. So the cell
 * does the same, and the guard is untouched — see `handleSetProperty`.
 *
 * READ MODE IS NOT AN INPUT. A grid of 258 boxes reads as a form, and this is a
 * table you mostly look at. It stays a chip until you click it, which is also
 * what keeps the column scannable at a glance.
 *
 * <datalist> rather than a <select>, deliberately: `status` is a convention in
 * these notes, not an enum — nothing declares the allowed values and the vault
 * has whatever people typed. A select could only offer what already exists,
 * which would make the first note to use a new status unwritable. The list is
 * the existing values as suggestions; the field still takes anything.
 *
 * ENTER COMMITS AND NOTHING ELSE DOES. Not blur — `review-s2-vault-pane`
 * hard-fails on `onBlur=` anywhere in this pane, and that guard is right: every
 * write in this app is something the user asked for at the moment they asked
 * for it. A cell that saved because focus moved would be the first write here
 * that nobody pressed anything to cause, and the test file's own note on the
 * subject says the repair for a guard in the way is to narrow it to what it was
 * always about, never to widen an exception through it. Escape cancels.
 *
 * Which cell is open is owned by the TABLE, not by each cell, and that is what
 * replaces blur: opening one closes the other, so a click on a second cell
 * abandons the first instead of leaving two inputs open across the grid.
 */
function PropertyCell({
  value,
  options,
  listId,
  label,
  editing,
  onOpen,
  onClose,
  onCommit,
  children,
}: {
  value: string
  options: string[]
  listId: string
  label: string
  editing: boolean
  onOpen: () => void
  onClose: () => void
  onCommit: (next: string) => Promise<void>
  children: React.ReactNode
}) {
  // UNCONTROLLED on purpose. The field is read off the element at commit
  // time -- see the Enter handler -- so a draft in state would be a second copy
  // that has to be kept in step for no gain, and re-rendering 258 rows on every
  // keystroke in one of them is a real cost in a table this size.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commit = async (next: string) => {
    onClose()
    if (next === value) return
    setBusy(true)
    setError(null)
    try {
      await onCommit(next)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      /**
       * The conflict gets a sentence a person can act on; anything else is
       * reported as itself.
       *
       * Both stay ON THE CELL until the next attempt rather than clearing on a
       * timer. The write did not happen, the old value is still on screen, and
       * a message that disappears leaves a row that looks like it was edited
       * and was not.
       */
      setError(
        isSaveConflict(message)
          ? 'Changed on disk since the table loaded. Reopen the table and try again.'
          : message,
      )
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <>
        <input
          className="db-cell-input"
          list={listId}
          defaultValue={value}
          autoFocus
          aria-label={label}
          // Says what commits, in the one place the question comes up. Enter is
          // not guessable when every other table on earth saves on blur.
          placeholder="Enter to save"
          // The row opens the note on click, and the table sorts on the header.
          // Neither should fire because someone clicked into a text field.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              // Read off the ELEMENT rather than from state: picking a
              // <datalist> suggestion with the keyboard and pressing Enter in
              // the same beat commits before a change event has been seen.
              void commit(e.currentTarget.value)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
            // Arrow keys and Escape belong to the field while it is open.
            e.stopPropagation()
          }}
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </>
    )
  }
  return (
    <button
      type="button"
      className={`db-cell-edit ${error ? 'db-cell-error' : ''}`}
      // Not `disabled` while busy: a disabled button loses focus, which throws
      // the keyboard user out of the table mid-edit. It just stops responding.
      aria-busy={busy || undefined}
      // The full message on hover, since the cell is too narrow to show it.
      title={error ?? `${label}: click to edit`}
      onClick={(e) => {
        e.stopPropagation()
        if (!busy) onOpen()
      }}
    >
      {children}
      {error && (
        <span className="db-cell-warn" role="alert">
          !
        </span>
      )}
    </button>
  )
}

/**
 * The four view shapes on the roadmap. All four are built now.
 *
 * They share one row set and one filter deliberately — that is the whole claim
 * of "many views, same rows": Board and Gallery are re-renderings of the same
 * `groups` the table draws. None of them is a second query path.
 *
 * There were four. Calendar moved out to the Planner, where it merged with the
 * daily notes it could never show — see PlannerView for the argument.
 */
type ViewMode = 'table' | 'board' | 'gallery'

const VIEW_MODES: { key: ViewMode; label: string; Icon: LucideIcon; built: boolean }[] = [
  { key: 'table', label: 'Table', Icon: Table, built: true },
  { key: 'board', label: 'Board', Icon: Columns3, built: true },
  { key: 'gallery', label: 'Gallery', Icon: LayoutGrid, built: true },
  // Calendar was here and has MOVED, to the Planner — see PlannerView. It was
  // the only one of the four that was not just a re-rendering of `groups`: a
  // day's daily note is not a row in this table, it is a file that may not
  // exist yet, and the useful gesture on an empty day is to write it. That is
  // an authoring surface, and it was wearing a view's clothes in here.
]

type SortKey = 'title' | 'area' | 'type' | 'status' | 'updated' | 'links' | 'backlinks'
type GroupKey =
  | 'area' | 'family' | 'type' | 'status' | 'tag' | 'facet' | 'folder' | 'month' | 'linked' | 'none'

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'area', label: 'Area' },
  { key: 'family', label: 'Category' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'tag', label: 'Tag' },
  // Derived, not written. Grouping by this is the only way to see a facet that
  // nobody typed — which is the entire point of having them.
  { key: 'facet', label: 'Facet' },
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
const COLUMNS: { key: SortKey | 'tags' | 'facets'; label: string; className: string; sort: boolean }[] = [
  { key: 'title', label: 'Name', className: 'db-col-title', sort: true },
  { key: 'area', label: 'Area', className: 'db-col-area', sort: true },
  { key: 'type', label: 'Type', className: 'db-col-type', sort: true },
  { key: 'status', label: 'Status', className: 'db-col-status', sort: true },
  { key: 'tags', label: 'Tags', className: 'db-col-tags', sort: false },
  // Not sortable: a facet list has no order a column header could promise, the
  // same reason Tags is not sortable either.
  { key: 'facets', label: 'Facets', className: 'db-col-tags', sort: false },
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
function groupValues(
  n: VaultNoteMeta,
  key: GroupKey,
  facetsOf: (path: string) => string[],
): string[] {
  switch (key) {
    case 'area': return [areaOf(n)]
    case 'family': {
      const f = typeFamily(n.type)
      return [f === 'none' ? '' : FAMILIES[f].label]
    }
    case 'type': return [n.type]
    case 'status': return [n.status]
    case 'tag': return n.tags.length ? n.tags : ['']
    // Multi-valued like tags, and for the same reason: a note sits in several
    // folders' worth of ancestry and can be both dated and a hub.
    case 'facet': {
      const f = facetsOf(n.path)
      return f.length ? f : ['']
    }
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

function TagList({
  tags,
  blank = true,
  title,
}: {
  tags: string[]
  blank?: boolean
  /** Overrides the default hover text, which is just the values joined. */
  title?: string
}) {
  if (!tags.length) return blank ? <span className="db-blank">{NONE}</span> : null
  const head = tags.slice(0, TAG_CAP)
  const rest = tags.length - head.length
  return (
    <span className="db-tags" title={title ?? tags.join(', ')}>
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
  /**
   * The link graph, for derived facets.
   *
   * Optional because the database is useful without it: absent, every note
   * still has its folder and date facets and simply has no `shape` or `about`,
   * which are the two that need to know about neighbours. A missing graph
   * degrades the column, it does not empty the view.
   */
  graph?: VaultGraph | null
  loading: boolean
  error: string | null
  onOpenNote: (path: string) => void
  /**
   * Write one property back into the note's own Markdown.
   *
   * REJECTS rather than resolving on failure, and the cell needs it that way:
   * a SaveConflict has to reach the control that asked for the write, because
   * that is the only place on screen that can say which row did not change.
   */
  onSetProperty: (path: string, key: string, value: string) => Promise<void>
}

export function DatabaseView({
  notes,
  graph,
  loading,
  error,
  onOpenNote,
  onSetProperty,
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

  /**
   * Every note's derived facets, computed once per (notes, graph) pair.
   *
   * ONCE is the point. `facets()` defaults its hub threshold to
   * `hubThreshold(hood.degrees)`, which sorts the whole degree array — calling
   * it per row means 465 sorts of a 465-element array to produce one number
   * that is identical every time. `neighbourhoods()` computes it alongside the
   * adjacency map and it is passed in.
   *
   * Nothing here is written anywhere. These are recomputed from the paths and
   * the graph on every render that changes either, which is what lets them
   * never be stale: move a note and its facets moved with it.
   */
  /**
   * The suggestions the two editable columns offer, read off the vault itself.
   *
   * Not a declared enum anywhere, because there is not one: `status` and `type`
   * are a convention these notes follow, so the honest list of allowed values
   * is the list of values in use. That also makes the suggestions self-healing
   * — rename a status across the vault and the old one stops being offered
   * without anything needing to be told.
   *
   * Sorted, and off the FULL note set rather than the filtered rows: a filter
   * is what you are looking at, not what the vault permits, and offering fewer
   * values because a search box is narrowed would be a trap.
   */
  /**
   * WHICH cell is open for editing, as the path and the key joined by a NUL, or null for none.
   *
   * One piece of state for the whole table rather than one per cell, and that
   * is what stands in for the blur handler this pane is not allowed to have:
   * opening a second cell closes the first by construction, so there can never
   * be two inputs open across 258 rows. A per-cell boolean could not do that
   * without the cells knowing about each other.
   *
   * NUL as the separator because a vault path can contain anything else, and
   * two cells resolving to one key would let an edit open on the wrong row.
   */
  const [editingCell, setEditingCell] = useState<string | null>(null)

  const [typeOptions, statusOptions] = useMemo(() => {
    const types = new Set<string>()
    const statuses = new Set<string>()
    for (const n of notes ?? []) {
      if (n.type) types.add(n.type)
      if (n.status) statuses.add(n.status)
    }
    return [[...types].sort(), [...statuses].sort()]
  }, [notes])

  const facetIndex = useMemo(() => {
    const empty = new Map<string, { keys: string[]; why: string }>()
    if (!notes) return empty
    const paths = notes.map((n) => n.path)
    // A missing graph is not an error. Folder and date facets need no
    // neighbours at all, so the column degrades to those rather than emptying.
    const links = graph?.links ?? []
    const { hoods, hubAt } = neighbourhoods(paths, links)
    const out = new Map<string, { keys: string[]; why: string }>()
    for (const path of paths) {
      const hood = hoods.get(path) ?? { neighbours: [], degrees: [] }
      const f = facets(path, hood, hubAt)
      // Each line leads with the facet itself, then its reason.
      //
      // TAG_CAP is 2 and its comment promises "the full list is in the cell's
      // title" — a promise a title carrying only prose would quietly break, since
      // a note with four facets shows two and a "+2". Leading with the key keeps
      // that contract AND explains each one, which is the thing a value nobody
      // typed has to be able to do.
      const lines = f.map((x) => `${x.kind}:${x.value} — ${x.why}`)
      out.set(path, { keys: facetKeys(f), why: lines.join('\n\n') })
    }
    return out
  }, [notes, graph])

  const facetsOf = (path: string): string[] => facetIndex.get(path)?.keys ?? []
  const facetWhy = (path: string): string => facetIndex.get(path)?.why ?? ''

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
      for (const raw of groupValues(n, groupBy, facetsOf)) {
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
                      {/* Type and Status are the two EDITABLE columns, and the
                          only two, because they are the only plain scalars a
                          person maintains by hand. Area is derived from the
                          folder (moving the note is the edit), Links and
                          Backlinks are the wikilinks in the body, Updated is a
                          stamp, and Tags is a list — see `setFrontmatter`. */}
                      <td className="db-col-type">
                        {/* 190 of 258 notes have no type. A truly empty cell
                            reads as a rendering failure; an em-dash reads as an
                            answer. */}
                        <PropertyCell
                          value={n.type}
                          options={typeOptions}
                          listId="db-types"
                          label="Type"
                          editing={editingCell === `${n.path}\0type`}
                          onOpen={() => setEditingCell(`${n.path}\0type`)}
                          onClose={() => setEditingCell(null)}
                          onCommit={(next) => onSetProperty(n.path, 'type', next)}
                        >
                          {n.type ? (
                            <TypeChip type={n.type} />
                          ) : (
                            <span className="db-blank">{NONE}</span>
                          )}
                        </PropertyCell>
                      </td>
                      <td className="db-col-status">
                        <PropertyCell
                          value={n.status}
                          options={statusOptions}
                          listId="db-statuses"
                          label="Status"
                          editing={editingCell === `${n.path}\0status`}
                          onOpen={() => setEditingCell(`${n.path}\0status`)}
                          onClose={() => setEditingCell(null)}
                          onCommit={(next) => onSetProperty(n.path, 'status', next)}
                        >
                          {n.status ? (
                            <span className={`db-tag db-tone-${statusTone(n.status)}`}>
                              {n.status}
                            </span>
                          ) : (
                            <span className="db-blank">{NONE}</span>
                          )}
                        </PropertyCell>
                      </td>
                      <td className="db-col-tags">
                        <TagList tags={n.tags} />
                      </td>
                      {/* The hover text is every facet's own `why`, not the
                          values again. A derived value a person did not type
                          has to be able to say where it came from, or it is
                          indistinguishable from one that was invented. */}
                      <td className="db-col-tags">
                        <TagList tags={facetsOf(n.path)} title={facetWhy(n.path)} />
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
