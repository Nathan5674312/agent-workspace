/**
 * The Canvas panel in the sidebar: every board in the vault, as a list.
 *
 * SPLIT OUT OF CanvasView.tsx, where it had been sharing a file with the board
 * EDITOR. They are two components with two different consumers — <MainCanvas>
 * renders the editor, <VaultPane> renders this — and they shared nothing: not
 * one constant, not one helper, not one line of state. The editor's file is
 * 3000 lines of pointer handling and undo; opening it to change how the
 * sidebar lists boards was the whole cost of the arrangement.
 *
 * This is the ONE split of that file that earns itself. The editor's own bulk
 * is 42 hooks closing over shared state, and prying those apart costs more
 * code than it saves — see the note at the top of CanvasView.tsx.
 *
 * It reads the boards straight out of `vault.tree()` rather than asking the
 * disk again, which is the same choice DailyNotesView made and for the same
 * reason: the tree is already the app's answer to "what is in this vault", and
 * a second walk is a second answer waiting to disagree with the first. This is
 * what `kind: 'canvas'` on VaultTreeNode is for.
 */
import { useEffect, useState } from 'react'
import { Frame } from 'lucide-react'
import {
  parseCanvas,
  serializeCanvas,
  emptyCanvas,
  CANVAS_DROP_MIME,
  boardTree,
  isCanvasPath,
  ROOT_BOARD,
  type BoardRow,
} from '../../../shared/canvas.js'
import type { VaultTreeNode } from '../../../shared/ipc.js'
import './canvas.css'

export interface CanvasListProps {
  tree: VaultTreeNode | null
  /** The board currently open, so the list can mark it. */
  current: string | null
  onOpen: (path: string) => void
  /** Re-read the tree, so a new board appears in this list and the explorer. */
  onCreated: () => void
}

/** Every `.canvas` in the vault, depth-first, in tree order. */
function collectCanvases(node: VaultTreeNode | null): VaultTreeNode[] {
  if (!node) return []
  const out: VaultTreeNode[] = []
  const walk = (n: VaultTreeNode) => {
    if (n.kind === 'canvas') out.push(n)
    n.children?.forEach(walk)
  }
  walk(node)
  return out
}

/**
 * One board in the sidebar tree.
 *
 * DRAGGABLE, carrying the same payload a note from the file tree carries, so a
 * board can be dropped onto an open board and become a page pointing at it.
 * That page opens the board it names, which is the drill-down: the main board
 * holds a page per pipeline, and clicking one takes you into that pipeline.
 *
 * `data-depth` rather than an inline margin, matching how the folder tree
 * expresses nesting — the indent is a styling decision and belongs in CSS.
 */
function BoardRowButton({
  board,
  current,
  onOpen,
}: {
  board: BoardRow
  current: string | null
  onOpen: (path: string) => void
}) {
  return (
    <button
      type="button"
      className="canvas-list-item"
      data-depth={board.depth}
      aria-current={board.path === current}
      title={board.path}
      onClick={() => onOpen(board.path)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(CANVAS_DROP_MIME, board.path)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <Frame size={13} aria-hidden="true" />
      <span className="canvas-list-item-name">{board.name.replace(/\.canvas$/i, '')}</span>
    </button>
  )
}

export function CanvasList({ tree, current, onOpen, onCreated }: CanvasListProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boards = collectCanvases(tree)

  /**
   * Which boards each board links to, read from the boards themselves.
   *
   * The tree cannot be built from the file listing alone: a board's children
   * are the `.canvas` pages sitting ON it, which means every board has to be
   * read. That is a handful of small JSON files, done once per listing change.
   *
   * Keyed on the joined paths rather than the array, which is rebuilt on every
   * render by `collectCanvases` and would re-read the whole vault each time.
   */
  const [links, setLinks] = useState<Record<string, string[]>>({})
  const listing = boards.map((b) => b.path).join('\n')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<string, string[]> = {}
      for (const path of listing ? listing.split('\n') : []) {
        try {
          const body = await window.api.vault.read(path)
          next[path] = parseCanvas(body.text)
            .nodes.filter(
              (n) => n.type === 'file' && typeof n.file === 'string' && isCanvasPath(n.file),
            )
            .map((n) => n.file as string)
        } catch {
          // A board that will not read has no children as far as the tree is
          // concerned. It still appears; it just cannot nest anything.
          next[path] = []
        }
      }
      if (!cancelled) setLinks(next)
    })()
    return () => {
      cancelled = true
    }
    // `current` as well as `listing`: dropping a board onto another changes
    // which board is a CHILD without changing which boards EXIST, so the
    // listing alone would leave the tree showing the old shape. Re-read on
    // navigation, which is when the tree is next looked at.
    //
    // Not live: the tree still lags a link made on the board you are standing
    // on until you move off it. Closing that needs a save signal plumbed from
    // the board up to this list, which is more than this change is.
  }, [listing, current])

  const rows = boardTree(boards, links)
  // Split so the sidebar can head them separately. Everything the root reaches
  // is the pipeline; the rest are boards nothing links to yet.
  const linked = rows.filter((r) => r.reachable)
  const loose = rows.filter((r) => !r.reachable)

  /**
   * A free name at the vault root: `Canvas.canvas`, then `Canvas 2.canvas`.
   *
   * Chosen against the TREE rather than by attempting a save and catching the
   * conflict. save() with mtime 0 does refuse an existing file, so the
   * exception-driven version would also be correct, but it would write a
   * backup and a temp file on the way to finding that out.
   */
  const freeName = (): string => {
    const taken = new Set(boards.map((b) => b.path.toLowerCase()))
    if (!taken.has('canvas.canvas')) return 'Canvas.canvas'
    for (let i = 2; ; i++) {
      const name = `Canvas ${i}.canvas`
      if (!taken.has(name.toLowerCase())) return name
    }
  }

  const create = async () => {
    try {
      setBusy(true)
      setError(null)
      const path = freeName()
      // mtime 0 is the CREATE stamp (see vault.ts save()): it matches no file
      // on disk, so this refuses rather than overwrites if the name was taken
      // between reading the tree and here.
      await window.api.vault.save(path, serializeCanvas(emptyCanvas()), 0)
      onCreated()
      onOpen(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="canvas-list">
      <div className="canvas-list-head">
        <span className="canvas-list-title">Canvas</span>
        <button type="button" className="canvas-list-new" onClick={() => void create()} disabled={busy}>
          {busy ? 'Making…' : '+ New'}
        </button>
      </div>

      {error && <p className="canvas-list-empty">{error}</p>}

      {boards.length === 0 ? (
        <p className="canvas-list-empty">
          No canvases yet. A canvas is a board you arrange notes and text on. New
          ones are saved as <code>.canvas</code>, the same format Obsidian uses.
        </p>
      ) : (
        <div className="canvas-list-items">
          {linked.map((b) => (
            <BoardRowButton key={b.path} board={b} current={current} onOpen={onOpen} />
          ))}
          {loose.length > 0 && (
            <>
              {/* Boards the root cannot reach. Shown rather than hidden: a board
                  that vanished the moment nothing linked to it would be a file
                  on disk the app denied having. Drag one onto the main board and
                  it moves up into the tree above. */}
              <div className="canvas-list-subhead">
                {linked.length === 0 ? `No ${ROOT_BOARD} yet` : 'Not linked'}
              </div>
              {loose.map((b) => (
                <BoardRowButton key={b.path} board={b} current={current} onOpen={onOpen} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
