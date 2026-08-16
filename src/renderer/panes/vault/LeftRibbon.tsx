/**
 * Left icon ribbon — vertical navigation, Obsidian-shaped.
 *
 * Icons are Lucide SVGs stroked with `currentColor`. They replace the emoji
 * placeholders, which could not be themed at all: an emoji is an OS-supplied
 * colour raster, so it ignores `color`, takes no stroke weight, and sits on its
 * own baseline. No stylesheet could ever have made them match.
 */
import {
  Files,
  Search,
  Bookmark,
  Waypoints,
  Frame,
  Calendar,
  SquareTerminal,
  Blocks,
  type LucideIcon,
} from 'lucide-react'

export interface LeftRibbonProps {
  activeView: string
  onViewChange: (view: string) => void
}

const VIEWS: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: 'files', label: 'Files', Icon: Files },
  { id: 'search', label: 'Search', Icon: Search },
  { id: 'bookmarks', label: 'Bookmarks', Icon: Bookmark },
  { id: 'graph', label: 'Graph view', Icon: Waypoints },
  { id: 'canvas', label: 'Canvas', Icon: Frame },
  { id: 'calendar', label: 'Daily notes', Icon: Calendar },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'plugins', label: 'Plugins', Icon: Blocks },
]

/**
 * The label a ribbon id announces itself with. Exported so the placeholder
 * panel titles itself with the SAME string the icon's tooltip and accessible
 * name use — two spellings of one control is how a UI starts feeling sloppy.
 */
export function ribbonLabel(id: string): string {
  return VIEWS.find((v) => v.id === id)?.label ?? id
}

export function LeftRibbon({ activeView, onViewChange }: LeftRibbonProps) {
  return (
    <nav className="vault-ribbon" aria-label="Vault views">
      {VIEWS.map(({ id, label, Icon }) => (
        <button
          key={id}
          className={`vault-ribbon-icon ${activeView === id ? 'vault-ribbon-icon--active' : ''}`}
          onClick={() => onViewChange(id)}
          // The button carries the accessible name; the icon is decorative and
          // must not announce itself twice.
          aria-label={label}
          aria-pressed={activeView === id}
          title={label}
        >
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ))}
    </nav>
  )
}
