import { useState } from 'react'
import type { VaultNoteBody, VaultGraph } from '../../../shared/ipc.js'
import { Editor } from './Editor.js'
import { GraphView } from './GraphView.js'

/**
 * Main canvas — dispatcher between editor and graph view.
 * Each view has its own controls and state.
 *
 * The editor unmounts when the graph is shown. That is only safe because the
 * edit buffer is owned by <VaultPane>; nothing note-related may be stored here.
 */
export interface MainCanvasProps {
  note: VaultNoteBody | null
  text: string
  onTextChange: (text: string) => void
  isDirty: boolean
  onSave: (text: string, mtime: number) => Promise<void>
  onConflict: (diskMtime: number, diskText: string) => void
  getGraph: () => Promise<VaultGraph>
  backlinks: string[]
  onOpenNote: (path: string) => void
  onOpenWikilink: (name: string) => void
  discarded: { label: string; text: string } | null
}

export function MainCanvas({
  note,
  text,
  onTextChange,
  isDirty,
  onSave,
  onConflict,
  getGraph,
  backlinks,
  onOpenNote,
  onOpenWikilink,
  discarded,
}: MainCanvasProps) {
  const [view, setView] = useState<'editor' | 'graph'>('editor')
  const [graph, setGraph] = useState<VaultGraph | null>(null)
  const [loadingGraph, setLoadingGraph] = useState(false)
  const [graphError, setGraphError] = useState<string | null>(null)

  const handleSwitchToGraph = async () => {
    setView('graph')
    if (graph !== null) return
    try {
      setLoadingGraph(true)
      setGraphError(null)
      // Read-only. The graph is a rebuildable cache derived from wikilinks and
      // is never written back from this pane.
      const g = await getGraph()
      setGraph(g)
    } catch (e) {
      setGraphError(String(e))
    } finally {
      setLoadingGraph(false)
    }
  }

  return (
    <div className="vault-main-canvas">
      <div className="vault-view-controls">
        <button
          className={`vault-view-button ${view === 'editor' ? 'active' : ''}`}
          onClick={() => setView('editor')}
        >
          Editor
        </button>
        <button
          className={`vault-view-button ${view === 'graph' ? 'active' : ''}`}
          onClick={handleSwitchToGraph}
          disabled={loadingGraph}
        >
          {loadingGraph ? 'Loading...' : 'Graph'}
        </button>
        {isDirty && (
          <span className="vault-canvas-dirty-warning">
            Unsaved changes are kept while you switch views
          </span>
        )}
      </div>

      <div className="vault-view-content">
        {view === 'editor' ? (
          <Editor
            note={note}
            text={text}
            onTextChange={onTextChange}
            isDirty={isDirty}
            onSave={onSave}
            onConflict={onConflict}
            backlinks={backlinks}
            onOpenNote={onOpenNote}
            onOpenWikilink={onOpenWikilink}
            discarded={discarded}
          />
        ) : graphError ? (
          <div className="vault-graph-error">Graph failed: {graphError}</div>
        ) : (
          <GraphView graph={graph} />
        )}
      </div>
    </div>
  )
}
