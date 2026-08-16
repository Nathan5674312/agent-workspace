/**
 * Tab bar — named tabs, new tab, tab-list chevron, split pane, window controls.
 * ponytail: single tab for v1, no multi-tab management yet.
 */
import { ChevronDown, Columns2, EllipsisVertical } from 'lucide-react'

const NOT_YET = 'Not implemented yet'

export interface TabBarProps {
  tabs: Array<{ id: string; name: string }>
  activeTabId: string
  onTabChange: (id: string) => void
  onNewTab: () => void
}

export function TabBar({
  tabs,
  activeTabId,
  onTabChange,
  onNewTab,
}: TabBarProps) {
  return (
    <div className="vault-tab-bar">
      <div className="vault-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`vault-tab ${activeTabId === tab.id ? 'vault-tab--active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.name}
          </button>
        ))}
      </div>
      <button className="vault-new-tab" onClick={onNewTab} title="New tab">
        +
      </button>
      {/* Disabled, not inert: none of these three had an onClick at all, so
          they were decoration that read as controls. */}
      <button className="vault-tab-chevron" disabled title={NOT_YET}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button className="vault-tab-split" disabled title={NOT_YET}>
        <Columns2 size={14} aria-hidden="true" />
      </button>
      <button className="vault-tab-menu" disabled title={NOT_YET}>
        <EllipsisVertical size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
