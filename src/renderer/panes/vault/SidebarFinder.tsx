/**
 * The sidebar's own switch: three ways to find a note.
 *
 * It exists because the ribbon stopped doing this job. Files, Search and
 * Bookmarks are not places you go, they are ways of finding what to open, so
 * under the rule stated in `LeftRibbon.tsx` they cannot live in a strip that
 * means "surface". They needed a control of their own, and it belongs HERE —
 * in the panel it changes — rather than in a column four inches away whose
 * other icons do something categorically different.
 *
 * Three text tabs rather than three more icons, deliberately. The ribbon is
 * already an icon column; a second icon column immediately beside it, with
 * different semantics and no labels, is how the app got confusing in the first
 * place. Words here say plainly that this is a different kind of control.
 */

/** What the sidebar is currently listing. */
export type Finder = 'files' | 'search' | 'bookmarks'

export const FINDERS: { id: Finder; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'search', label: 'Search' },
  { id: 'bookmarks', label: 'Bookmarks' },
]

export interface SidebarFinderProps {
  value: Finder
  onChange: (finder: Finder) => void
}

export function SidebarFinder({ value, onChange }: SidebarFinderProps) {
  return (
    /**
     * `tablist`, not a group of buttons.
     *
     * These three are mutually exclusive views of one region and exactly one is
     * always chosen, which is what a tablist means and what lets a screen
     * reader announce "2 of 3" instead of three unrelated pressed states.
     */
    <div className="vault-finder" role="tablist" aria-label="Find a note by">
      {FINDERS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          className={`vault-finder-tab ${value === id ? 'vault-finder-tab--active' : ''}`}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
