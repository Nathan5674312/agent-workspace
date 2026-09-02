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
  History,
  SquareTerminal,
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
  /* Versions used to sit in the top strip. It is about the OPEN NOTE rather
     than about the vault, and the strip is now the handful of places this user
     actually works — so it moved here, where the less-reached-for things live.
     Unlike its neighbours this one opens a MAIN view rather than a sidebar
     section; see the handler in VaultPane. */
  { id: 'versions', label: 'Versions', Icon: History },
  { id: 'calendar', label: 'Daily notes', Icon: Calendar },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  /**
   * PLUGINS WAS REMOVED, and it is the one icon that was deleted rather than
   * built. The roadmap's own entry is the reason: "the agent is the plugin
   * system and the canvas is the render target. Building a JS plugin host would
   * be choosing Obsidian's supply-chain risk on purpose." So this was not an
   * unbuilt feature waiting its turn — it was a promise the product had already
   * decided not to keep, and an icon that opens a panel saying "not built yet"
   * for something that will never be built is the inert control this pane's
   * review exists to forbid.
   *
   * The roadmap ENTRY stays. It records the position, which is worth keeping;
   * what it no longer claims is a place in the ribbon. The extension story the
   * entry points at is already on screen under Canvas, where boards an agent
   * can run actually live.
   */
]

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
