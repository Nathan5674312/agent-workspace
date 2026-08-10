/**
 * Explorer header — controls above the folder tree.
 * New note, new folder, sort, collapse-all, expand.
 */
export interface ExplorerHeaderProps {
  onNewNote: () => void
  onNewFolder: () => void
  onCollapse: () => void
  onExpand: () => void
}

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
        title="New note"
      >
        + Note
      </button>
      <button
        className="vault-header-button"
        onClick={onNewFolder}
        title="New folder"
      >
        + Folder
      </button>
      <button
        className="vault-header-button"
        onClick={onCollapse}
        title="Collapse all"
      >
        −
      </button>
      <button
        className="vault-header-button"
        onClick={onExpand}
        title="Expand all"
      >
        +
      </button>
      <select className="vault-sort-select" defaultValue="name">
        <option value="name">Sort by name</option>
        <option value="modified">Modified</option>
      </select>
    </div>
  )
}
