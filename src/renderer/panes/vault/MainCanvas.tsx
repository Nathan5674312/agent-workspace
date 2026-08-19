import { useEffect, useState } from 'react'
import type { VaultNoteBody, VaultGraph } from '../../../shared/ipc.js'
import { Editor } from './Editor.js'
import { GraphView } from './GraphView.js'
import { DatabaseView } from './DatabaseView.js'
import { InboxView } from './InboxView.js'
import { RoadmapView } from './RoadmapView.js'
import { VersionsView } from './VersionsView.js'
import { PaneMenu, PaneMenuItem } from './PaneMenu.js'
import { BookmarkToggleItem } from './BookmarksView.js'
import type { VaultNoteMeta, InboxItem } from '../../../shared/notemeta.js'
import { ArrowLeft, ArrowRight, Ellipsis } from 'lucide-react'

/**
 * Main canvas — dispatcher between editor and graph view.
 * Each view has its own controls and state.
 *
 * The editor unmounts when the graph is shown. That is only safe because the
 * edit buffer is owned by <VaultPane>; nothing note-related may be stored here.
 */
/**
 * Which view the canvas is showing. Exported because a TAB owns one: a tab that
 * cannot remember it was on the database is a label, not a tab.
 */
export type MainView = 'editor' | 'versions' | 'graph' | 'database' | 'inbox' | 'roadmap'

export interface MainCanvasProps {
  note: VaultNoteBody | null
  text: string
  onTextChange: (text: string) => void
  isDirty: boolean
  onSave: (text: string, mtime: number) => Promise<void>
  onConflict: (diskMtime: number, diskText: string) => void
  /** Save an older version over the open note. False when the user declined. */
  onRestore: (text: string) => Promise<boolean>
  getGraph: () => Promise<VaultGraph>
  getNotes: () => Promise<VaultNoteMeta[]>
  getInbox: () => Promise<InboxItem[]>
  backlinks: string[]
  /** Resolves false when the open was refused — a conflict dialog, a declined
   *  discard, or a failed read. Callers must not commit a view change until
   *  this says the note is actually open. */
  onOpenNote: (path: string) => Promise<boolean>
  onOpenWikilink: (name: string) => void
  discarded: { label: string; text: string } | null
  onBack: () => void
  onForward: () => void
  canGoBack: boolean
  canGoForward: boolean
  /**
   * LIFTED to <VaultPane>, which owns the tabs. While this lived here it was
   * pane-wide: every tab showed whatever view the canvas happened to be on, so
   * switching tabs could not restore where you were.
   */
  view: MainView
  onViewChange: (view: MainView) => void
}

export function MainCanvas({
  note,
  text,
  onTextChange,
  isDirty,
  onSave,
  onConflict,
  onRestore,
  getGraph,
  getNotes,
  getInbox,
  backlinks,
  onOpenNote,
  onOpenWikilink,
  discarded,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  view,
  onViewChange,
}: MainCanvasProps) {
  const [graph, setGraph] = useState<VaultGraph | null>(null)
  const [loadingGraph, setLoadingGraph] = useState(false)
  const [graphError, setGraphError] = useState<string | null>(null)
  const [notes, setNotes] = useState<VaultNoteMeta[] | null>(null)
  const [loadingNotes, setLoadingNotes] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [inbox, setInbox] = useState<InboxItem[] | null>(null)
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [inboxError, setInboxError] = useState<string | null>(null)

  /**
   * Always re-fetch. This used to early-return whenever `graph` was non-null,
   * which meant the graph you saw was whatever the vault looked like the first
   * time you opened the tab: add a [[link]], save, come back, and the edge was
   * missing with no control anywhere to refresh it. Only restarting the app
   * cleared it.
   *
   * Re-fetching is cheap because the memo now lives in the main process
   * (src/main/vault.ts `graph()`), where it is shared with `backlinks()`, has a
   * TTL, and is invalidated by our own saves. One cache, at the layer that
   * knows when it is stale — instead of a permanent one up here that never did.
   */
  const handleSwitchToGraph = async () => {
    onViewChange('graph')
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

  /**
   * Same contract as the graph: always re-fetch, never memo up here.
   *
   * A cached note list is worse than a cached graph, not better. Frontmatter is
   * exactly what this view exists to show, so an edit to `status:` that the
   * table keeps showing the old value for is the stale-status-board failure the
   * database view was built to end.
   *
   * There is NO cache behind this. `vault.ts` memoises `graph()` only
   * (GRAPH_TTL_MS, invalidated by save); `list()` does a fresh HTTP round trip
   * to the note server on every tab switch. That is affordable at 258 notes and
   * is the correct default for a view whose whole job is to be current -- but
   * do not read this as "something upstream is caching for me".
   */
  const handleSwitchToDatabase = async () => {
    onViewChange('database')
    try {
      setLoadingNotes(true)
      setNotesError(null)
      setNotes(await getNotes())
    } catch (e) {
      setNotesError(String(e))
    } finally {
      setLoadingNotes(false)
    }
  }

  /**
   * Opening a note from ANYWHERE brings the editor forward.
   *
   * The sidebar tree, the tab bar and the back/forward arrows all call
   * `openNote` in <VaultPane>, which loads the note into the buffer — and then
   * nothing happened, because `view` lives here and none of them can reach it.
   * Clicking CLAUDE.md while the graph was open genuinely worked and was
   * completely invisible, which reads as a dead button.
   *
   * Keyed on the PATH rather than the note object: `handleSave` replaces
   * `selectedNote` with a new object on every save, and on the object identity
   * this would drag the user out of the graph each time they hit save.
   *
   * The graph and the database set the view themselves before this runs, so for
   * those two it is a no-op. This is the catch-all for every other entry point.
   */
  const openPath = note?.path
  useEffect(() => {
    if (openPath) onViewChange('editor')
  }, [openPath])

  /**
   * Re-fetch every time, for the strongest version of the reason the other two
   * have: this queue's whole job is to tell you what arrived since you last
   * looked. A cached inbox is a lie about the present.
   */
  const handleSwitchToInbox = async () => {
    onViewChange('inbox')
    try {
      setLoadingInbox(true)
      setInboxError(null)
      setInbox(await getInbox())
    } catch (e) {
      setInboxError(String(e))
    } finally {
      setLoadingInbox(false)
    }
  }

  return (
    <div className="vault-main-canvas">
      {/* Note header — back / forward, the title, and the view menu, in the
          arrangement the real explorer uses. The arrows are wired to actual
          navigation history in <VaultPane>; they disable rather than sit
          inert, so the control tells the truth about whether it can act. */}
      <div className="vault-note-header">
        <div className="vault-note-nav">
          <button
            className="vault-nav-back"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back"
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
          <button
            className="vault-nav-forward"
            onClick={onForward}
            disabled={!canGoForward}
            aria-label="Forward"
            title="Forward"
          >
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
        <span className="vault-note-title">
          {view === 'graph'
            ? 'Graph view'
            : view === 'database'
              ? 'Database view'
              : view === 'inbox'
                ? 'Inbox'
                : view === 'roadmap'
                  ? 'Roadmap'
                  : view === 'versions'
                    ? // Still the note's own view, so it keeps the note's name.
                      `${note?.title ?? 'No note selected'} — versions`
                    : (note?.title ?? 'No note selected')}
        </span>
        {/* This button had no onClick AND no `disabled`, so it took focus,
            painted the app's hover and press feedback, announced itself to a
            screen reader as actionable, and did nothing — sitting between two
            arrows that disable themselves honestly when they cannot act.

            Both rows copy to the clipboard, which is the entire set of things
            that can be done to a note from here: rename, delete and move have
            no IPC channel, and there is deliberately no shell.openPath on the
            bridge, so "Reveal in Explorer" cannot be offered either. Disabled
            with no note open, because then there is nothing to copy. */}
        <PaneMenu
          id="vault-note-options-menu"
          className="vault-note-menu"
          label="More options"
          icon={<Ellipsis size={15} aria-hidden="true" />}
          disabled={!note}
        >
          <PaneMenuItem
            onClick={() => void navigator.clipboard.writeText(note?.path ?? '')}
          >
            Copy note path
          </PaneMenuItem>
          <PaneMenuItem
            onClick={() => void navigator.clipboard.writeText(`[[${note?.title ?? ''}]]`)}
          >
            Copy wikilink
          </PaneMenuItem>
          {/* Writes Obsidian's own .obsidian/bookmarks.json, so a bookmark made
              here is the same bookmark Obsidian shows. */}
          <BookmarkToggleItem path={note?.path ?? null} title={note?.title ?? ''} />
        </PaneMenu>
      </div>

      <div className="vault-view-controls">
        <button
          className={`vault-view-button ${view === 'editor' ? 'active' : ''}`}
          onClick={() => onViewChange('editor')}
        >
          Editor
        </button>
        {/* Next to Editor because it is about the OPEN NOTE, where Graph,
            Database and Inbox are about the vault. Nothing is fetched on the
            click: the panel loads its own list from the note it is given, so
            this needs no loading state up here. */}
        <button
          className={`vault-view-button ${view === 'versions' ? 'active' : ''}`}
          onClick={() => onViewChange('versions')}
        >
          Versions
        </button>
        <button
          className={`vault-view-button ${view === 'graph' ? 'active' : ''}`}
          onClick={handleSwitchToGraph}
          disabled={loadingGraph}
        >
          {loadingGraph ? 'Loading...' : 'Graph'}
        </button>
        <button
          className={`vault-view-button ${view === 'database' ? 'active' : ''}`}
          onClick={handleSwitchToDatabase}
          disabled={loadingNotes}
        >
          {loadingNotes ? 'Loading...' : 'Database'}
        </button>
        <button
          className={`vault-view-button ${view === 'inbox' ? 'active' : ''}`}
          onClick={handleSwitchToInbox}
          disabled={loadingInbox}
        >
          {loadingInbox ? 'Loading...' : 'Inbox'}
          {/* The count is the point of a queue: it has to be legible without
              opening the tab, or nobody opens the tab. Only shown once loaded
              — a badge that says 0 before it has looked is a false all-clear. */}
          {inbox && inbox.length > 0 && (
            <span className="vault-view-badge">{inbox.length}</span>
          )}
        </button>
        {/* Roadmap needs no loading state and no data plumbing: it renders a
            static manifest from shared/roadmap.ts. Last in the strip because it
            is about the app, not about the vault. */}
        <button
          className={`vault-view-button ${view === 'roadmap' ? 'active' : ''}`}
          onClick={() => onViewChange('roadmap')}
        >
          Roadmap
        </button>
        {isDirty && (
          <span className="vault-canvas-dirty-warning">
            Unsaved changes are kept while you switch views
          </span>
        )}
      </div>

      <div className="vault-view-content">
        {view === 'roadmap' ? (
          <RoadmapView />
        ) : view === 'versions' ? (
          <VersionsView note={note} onRestore={onRestore} />
        ) : view === 'inbox' ? (
          <InboxView
            items={inbox}
            loading={loadingInbox}
            error={inboxError}
            // Opening a capture is reading it, not filing it: the note stays in
            // Inbox/ until something actually moves it.
            onOpenNote={async (path) => {
              const opened = await onOpenNote(path)
              if (opened) onViewChange('editor')
              return opened
            }}
          />
        ) : view === 'database' ? (
          <DatabaseView
            notes={notes}
            loading={loadingNotes}
            error={notesError}
            onOpenNote={async (path) => {
              // Loading the note is only half of "open" -- without the view
              // switch it opens behind the table and the click reads as broken
              // even though it worked. But the switch is CONDITIONAL: openNote
              // resolves false when the user declined a discard prompt or a
              // conflict dialog is up, and switching anyway drags them out of
              // the table they were reading into an editor they refused.
              if (await onOpenNote(path)) onViewChange('editor')
            }}
          />
        ) : view === 'editor' ? (
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
          <GraphView
            graph={graph}
            onOpenNote={async (path) => {
              // Loading the note is only half of "open". Without the view
              // switch the note opens behind the graph and nothing appears to
              // happen — the click reads as broken even though it worked.
              // Conditional for the same reason as the table: a refused open
              // must not move the user.
              if (await onOpenNote(path)) onViewChange('editor')
            }}
          />
        )}
      </div>
    </div>
  )
}
