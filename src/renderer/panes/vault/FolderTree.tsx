import { useState } from 'react'
import type { VaultTreeNode } from '../../../shared/ipc.js'
import { CANVAS_DROP_MIME } from '../../../shared/canvas.js'

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
  /**
   * The last note the user touched — clicked once, or started dragging.
   *
   * Local, because it is feedback about a gesture and nothing outside this tree
   * acts on it. Lifting it to VaultPane would make every pane re-render to
   * light up one row.
   *
   * Not the same thing as the OPEN note: you can touch a file, drag it onto a
   * board, and never open it. This answers "which one did I just grab", which
   * is the question a single click now asks, since opening moved to double.
   */
  const [touched, setTouched] = useState<string | null>(null)
  // Render the root's CHILDREN, not the root. Obsidian lists the vault's
  // top-level folders directly in the explorer; the vault itself is named once,
  // at the bottom, by the vault switcher. Rendering the root node here put
  // every folder behind one extra collapsed row that had to be opened before
  // the explorer showed anything at all.
  return (
    <div className="vault-folder-tree">
      {root?.children?.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          expanded={expanded}
          onToggle={onToggle}
          onSelectNote={onSelectNote}
          touched={touched}
          onTouch={setTouched}
          depth={0}
        />
      ))}
    </div>
  )
}

interface TreeNodeProps {
  node: VaultTreeNode
  expanded: Set<string>
  onToggle: (path: string) => void
  onSelectNote: (path: string) => void
  /** Path of the last-touched note, or null. */
  touched: string | null
  onTouch: (path: string) => void
  depth: number
}

function TreeNode({
  node,
  expanded,
  onToggle,
  onSelectNote,
  touched,
  onTouch,
  depth,
}: TreeNodeProps) {
  const isExpanded = expanded.has(node.path)
  const hasChildren = !!node.children && node.children.length > 0

  return (
    <div className="vault-tree-node" data-depth={depth} data-kind={node.kind}>
      {node.kind === 'folder' ? (
        <>
          {/* The whole row toggles, not just the chevron — that is how the
              real explorer behaves, and a 12px hit target for the only way to
              open a folder is the kind of thing that reads as "broken" long
              before anyone calls it a bug. The chevron stays as the affordance
              and the state indicator. */}
          <button
            className="vault-tree-item vault-tree-folder"
            onClick={() => onToggle(node.path)}
            disabled={!hasChildren}
            aria-expanded={isExpanded}
            data-has-children={hasChildren}
          >
            <span className="vault-tree-toggle" aria-hidden="true">
              {isExpanded ? '▼' : '▶'}
            </span>
            <span className="vault-tree-label">{node.name}</span>
          </button>
          {isExpanded && hasChildren && (
            <div className="vault-tree-children">
              {node.children!.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelectNote={onSelectNote}
                  touched={touched}
                  onTouch={onTouch}
                  depth={depth + 1}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        /**
         * Notes are DRAGGABLE, so one can be dropped onto an open canvas to
         * become a card. Folders are not: a folder is not a thing a board can
         * hold, and a drag that starts but can never be dropped anywhere is
         * worse than no drag at all.
         *
         * The path travels, not the name — two notes in different folders share
         * a name and the board needs the one that was actually dragged.
         *
         * `effectAllowed` and the custom type together are what make the cursor
         * tell the truth: a copy cursor over a board that will take it, and a
         * no-drop cursor everywhere else.
         */
        <button
          className="vault-tree-item vault-tree-note"
          data-touched={touched === node.path || undefined}
          /**
           * ONE CLICK MARKS, TWO CLICKS OPEN.
           *
           * A single click used to open the note, which fought the other thing
           * this row is for: dragging it onto a board. Reaching for a file to
           * drag meant opening it first, and opening a note unmounts whatever
           * view you were in — including the board you were dragging it to.
           *
           * THE KEYBOARD PATH IS THE EXCEPTION AND IT IS NOT OPTIONAL. Enter or
           * Space on a focused button fires a click with no pointer behind it,
           * and there is no such thing as a keyboard double-click here — so
           * treating every click as "just mark it" would leave a keyboard user
           * with no way to open a note at all. A synthesised click carries
           * `detail: 0`, which is the same signal the canvas uses to tell a
           * real press from one the browser made up.
           */
          onClick={(e) => {
            onTouch(node.path)
            if (e.detail === 0) onSelectNote(node.path)
          }}
          onDoubleClick={() => onSelectNote(node.path)}
          draggable
          onDragStart={(e) => {
            // Marked on drag too: the point of the highlight is "this is the
            // one you just grabbed", and a drag is the strongest form of that.
            onTouch(node.path)
            e.dataTransfer.setData(CANVAS_DROP_MIME, node.path)
            e.dataTransfer.effectAllowed = 'copy'
          }}
        >
          <span className="vault-tree-label">{node.name}</span>
        </button>
      )}
    </div>
  )
}
