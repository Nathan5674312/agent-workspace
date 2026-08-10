import type { VaultTreeNode } from '../../../shared/ipc.js'

/**
 * Folder tree — real vault folders, collapsible, in vault order.
 *
 * Expansion state is CONTROLLED by <VaultPane>. It used to be local `useState`
 * seeded from an `expand-all | collapse-all` mode prop, which meant the seed was
 * read once on mount and the explorer's expand/collapse buttons did nothing.
 *
 * Indentation is expressed as `data-depth`, not an inline margin — this pane
 * ships structure and stable class names only, no styling.
 */
export interface FolderTreeProps {
  root: VaultTreeNode | null
  onSelectNote: (path: string) => void
  expanded: Set<string>
  onToggle: (path: string) => void
}

export function FolderTree({
  root,
  onSelectNote,
  expanded,
  onToggle,
}: FolderTreeProps) {
  return (
    <div className="vault-folder-tree">
      {root && (
        <TreeNode
          node={root}
          expanded={expanded}
          onToggle={onToggle}
          onSelectNote={onSelectNote}
          depth={0}
        />
      )}
    </div>
  )
}

interface TreeNodeProps {
  node: VaultTreeNode
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelectNote: (path: string) => void
  depth: number
}

function TreeNode({
  node,
  expanded,
  onToggle,
  onSelectNote,
  depth,
}: TreeNodeProps) {
  const isExpanded = expanded.has(node.path)
  const hasChildren = !!node.children && node.children.length > 0

  return (
    <div className="vault-tree-node" data-depth={depth} data-kind={node.kind}>
      {node.kind === 'folder' ? (
        <>
          <div className="vault-tree-item">
            <button
              className="vault-tree-toggle"
              onClick={() => onToggle(node.path)}
              disabled={!hasChildren}
              aria-expanded={isExpanded}
              data-has-children={hasChildren}
            >
              {isExpanded ? '▼' : '▶'}
            </button>
            <span className="vault-tree-label">{node.name}</span>
          </div>
          {isExpanded && hasChildren && (
            <div className="vault-tree-children">
              {node.children!.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelectNote={onSelectNote}
                  depth={depth + 1}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <button
          className="vault-tree-item vault-tree-note"
          onClick={() => onSelectNote(node.path)}
        >
          <span className="vault-tree-label">{node.name}</span>
        </button>
      )}
    </div>
  )
}
