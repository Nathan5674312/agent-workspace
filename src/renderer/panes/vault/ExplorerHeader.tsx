/**
 * Explorer header — controls above the folder tree.
 * New note, new folder, sort, collapse-all, expand.
 *
 * All five act now. The three that used to be `disabled` were disabled for two
 * different reasons and only one of them was true: `vault:save` has always been
 * able to create a note (it skips the mtime guard when the file does not exist,
 * because there is no version to lose), so "+ Note" needed wiring, not a new
 * channel. "+ Folder" genuinely had nothing behind it and now has `vault:mkdir`.
 * Sort had no state to write into and now sorts in the renderer.
 *
 * The rule the old comment stated is still the rule, and is why nothing here is
 * merely inert: a control that looks live and silently does nothing is worse
 * than one that admits it cannot act.
 */
import { Minus } from 'lucide-react'
import { SelectMenu } from './SelectMenu.js'
import type { TreeSort } from './helpers.js'

export interface ExplorerHeaderProps {
  onNewNote: () => void
  onNewFolder: () => void
  onCollapse: () => void
  onExpand: () => void
  sort: TreeSort
  onSortChange: (sort: TreeSort) => void
}

/**
 * Every option re-orders the tree, and no two produce the same order.
 *
 * "Folders first" on its own would be identical to "Name (A→Z)" — the main
 * process already sorts folders first — so the kind and the direction are one
 * choice of four rather than two menus, one of which would have a setting that
 * changes nothing.
 *
 * Modified and Created are deliberately absent: `VaultTreeNode` carries no
 * timestamp, and `tree()` uses `readdir` with no `stat` per entry. Offering
 * either would mean a mode the user picks and watches nothing move.
 */
const SORTS: { value: TreeSort; label: string }[] = [
  { value: 'folders-asc', label: 'Folders first, A→Z' },
  { value: 'folders-desc', label: 'Folders first, Z→A' },
  { value: 'files-asc', label: 'Files first, A→Z' },
  { value: 'files-desc', label: 'Files first, Z→A' },
]

export function ExplorerHeader({
  onNewNote,
  onNewFolder,
  onCollapse,
  onExpand,
  sort,
  onSortChange,
}: ExplorerHeaderProps) {
  return (
    <div className="vault-explorer-header">
      <button
        className="vault-header-button"
        onClick={onNewNote}
        title="New note in the open note's folder"
      >
        + Note
      </button>
      <button
        className="vault-header-button"
        onClick={onNewFolder}
        title="New folder in the open note's folder"
      >
        + Folder
      </button>
      <button
        className="vault-header-button"
        onClick={onCollapse}
        title="Collapse all"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        className="vault-header-button"
        onClick={onExpand}
        title="Expand all"
      >
        +
      </button>
      {/* Controlled, so the tree and the dropdown cannot disagree. The sort
          itself happens one level up in <VaultPane>, against a COPY of the tree
          — <FolderTree> holds no state and simply renders what it is handed. */}
      <SelectMenu
        id="vault-sort-menu"
        className="vault-sort-select"
        label="Sort the folder tree"
        value={sort}
        options={SORTS}
        onChange={onSortChange}
      />
    </div>
  )
}
