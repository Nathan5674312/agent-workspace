/**
 * Explorer header — controls above the folder tree.
 * New note, new folder, sort, collapse-all, expand.
 *
 * New note, new folder and sort are DISABLED, not merely inert. The IPC
 * contract has no create call and the tree has no sort mode, so all three did
 * nothing but log to a console the user cannot see — a control that looks live
 * and silently does nothing is the defect this pane's own review called out
 * when it fixed the note-header arrows. Disabled with a reason is honest;
 * remove the attribute when the contract grows the calls.
 */
import { Minus } from 'lucide-react'
export interface ExplorerHeaderProps {
  onNewNote: () => void
  onNewFolder: () => void
  onCollapse: () => void
  onExpand: () => void
}

const NOT_YET = 'Not available yet — the vault IPC contract has no create call'

export function ExplorerHeader({
  onNewNote,
  onNewFolder,
  onCollapse,
  onExpand,
}: ExplorerHeaderProps) {
  return (
    <div className="vault-explorer-header">
      <button
        className="vault-header-button"
        onClick={onNewNote}
        disabled
        title={NOT_YET}
      >
        + Note
      </button>
      <button
        className="vault-header-button"
        onClick={onNewFolder}
        disabled
        title={NOT_YET}
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
      {/* The tree is always sorted folders-first then by name (src/main/vault.ts
          `sort`). Offering "Modified" with nothing behind it is a lie the user
          only discovers by picking it and watching nothing move. */}
      <select
        className="vault-sort-select"
        defaultValue="name"
        disabled
        title="Sorted by name — other sort modes are not implemented yet"
      >
        <option value="name">Sort by name</option>
      </select>
    </div>
  )
}
