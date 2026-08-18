/**
 * Tab bar — named tabs, new tab, tab-list chevron, split pane, tab actions.
 *
 * A TAB NOW HOLDS A NOTE. It used to be `{ id, name }`, and `activeTabId`'s only
 * consumer in the entire app was the highlight class one line below it — so the
 * strip and the "+" both ran code and changed nothing anyone could see, which
 * is a worse failure than a disabled button because it looks like it worked.
 *
 * Still ONE buffer for the whole pane, owned by <VaultPane>. Switching tabs is a
 * note switch and goes through the same guarded loader as the tree and every
 * wikilink, so the unsaved-edits confirm still fires. Per-tab buffers are a
 * different and much larger design; the point of a tab here is which note is on
 * screen, not a private copy of it.
 */
import { ChevronDown, Columns2, EllipsisVertical } from 'lucide-react'
import { PaneMenu, PaneMenuItem } from './PaneMenu.js'

export interface VaultTab {
  id: string
  name: string
  /** The note this tab is showing. `null` on a tab opened but not yet used. */
  path: string | null
}

export interface TabBarProps {
  tabs: VaultTab[]
  activeTabId: string
  onTabChange: (id: string) => void
  onNewTab: () => void
  onCloseTab: (id: string) => void
  onCloseOthers: () => void
  onCopyPath: () => void
  activePath: string | null
  split: boolean
  onToggleSplit: () => void
}

export function TabBar({
  tabs,
  activeTabId,
  onTabChange,
  onNewTab,
  onCloseTab,
  onCloseOthers,
  onCopyPath,
  activePath,
  split,
  onToggleSplit,
}: TabBarProps) {
  const lastTab = tabs.length <= 1

  return (
    <div className="vault-tab-bar">
      <div className="vault-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`vault-tab ${activeTabId === tab.id ? 'vault-tab--active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            title={tab.path ?? 'No note selected'}
          >
            {tab.name}
          </button>
        ))}
      </div>
      <button className="vault-new-tab" onClick={onNewTab} title="New tab">
        +
      </button>

      {/* The tab list. Every tab, not just the ones clipped off the end of the
          strip: an overflow-only menu needs a ResizeObserver to know what is
          clipped, and a menu that lists everything is correct without one. */}
      <PaneMenu
        id="vault-tab-list-menu"
        className="vault-tab-chevron"
        label="All tabs"
        icon={<ChevronDown size={14} aria-hidden="true" />}
      >
        {tabs.map((tab) => (
          <PaneMenuItem
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
          >
            <span aria-current={tab.id === activeTabId}>{tab.name}</span>
          </PaneMenuItem>
        ))}
      </PaneMenu>

      {/* Two canvases side by side over ONE note and ONE buffer. What differs
          between them is the view mode, which <MainCanvas> already keeps
          locally — that is the whole reason this is a toggle and not a feature:
          editor on the left, graph on the right, for free. */}
      <button
        className="vault-tab-split"
        onClick={onToggleSplit}
        aria-label="Split the editor into two panes"
        aria-pressed={split}
        title={split ? 'Back to one pane' : 'Split into two panes'}
      >
        <Columns2 size={14} aria-hidden="true" />
      </button>

      {/* Only actions that exist. Rename, delete, move and reveal-in-folder are
          all absent from the IPC contract, and there is deliberately no
          shell.openPath on the bridge, so none of them may appear here. */}
      <PaneMenu
        id="vault-tab-actions-menu"
        className="vault-tab-menu"
        label="Tab actions"
        icon={<EllipsisVertical size={14} aria-hidden="true" />}
      >
        <PaneMenuItem
          onClick={() => onCloseTab(activeTabId)}
          disabled={lastTab}
          reason="The last tab stays open"
        >
          Close this tab
        </PaneMenuItem>
        <PaneMenuItem
          onClick={onCloseOthers}
          disabled={lastTab}
          reason="There are no other tabs"
        >
          Close others
        </PaneMenuItem>
        <PaneMenuItem
          onClick={onCopyPath}
          disabled={!activePath}
          reason="No note is open"
        >
          Copy note path
        </PaneMenuItem>
      </PaneMenu>
    </div>
  )
}
