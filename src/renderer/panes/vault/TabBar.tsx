/**
 * Tab bar — named tabs, new tab, tab-list chevron, split pane, window controls.
 * ponytail: single tab for v1, no multi-tab management yet.
 */
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
            className={`vault-tab ${activeTabId === tab.id ? 'active' : ''}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.name}
          </button>
        ))}
      </div>
      <button className="vault-new-tab" onClick={onNewTab} title="New tab">
        +
      </button>
      <button className="vault-tab-chevron" title="Tab list">
        ⌄
      </button>
      <button className="vault-tab-split" title="Split right">
        ⫿
      </button>
      <button className="vault-tab-menu" title="Tab menu">
        ⋮
      </button>
    </div>
  )
}
