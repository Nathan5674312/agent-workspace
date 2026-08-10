/**
 * Left icon ribbon — vertical stack of navigation icons for Obsidian-like navigation.
 * v1: files, search, bookmarks, graph, canvas, calendar, terminal, plugins.
 * ponytail: icons are text labels for v1, no SVG assets yet.
 */
export interface LeftRibbonProps {
  activeView: string
  onViewChange: (view: string) => void
}

export function LeftRibbon({ activeView, onViewChange }: LeftRibbonProps) {
  const icons = [
    { id: 'files', label: '📁' },
    { id: 'search', label: '🔍' },
    { id: 'bookmarks', label: '🔖' },
    { id: 'graph', label: '◉' },
    { id: 'canvas', label: '🖼️' },
    { id: 'calendar', label: '📅' },
    { id: 'terminal', label: '⌘' },
    { id: 'plugins', label: '⚙️' },
  ]

  return (
    <nav className="vault-left-ribbon">
      {icons.map(({ id, label }) => (
        <button
          key={id}
          className={`vault-ribbon-icon ${activeView === id ? 'active' : ''}`}
          onClick={() => onViewChange(id)}
          title={id}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}
