import { useEffect, useState } from 'react'
import type { VaultNoteBody, VaultGraph } from '../../../shared/ipc.js'
import { Editor } from './Editor.js'
import { GraphView } from './GraphView.js'
import { CanvasView } from './CanvasView.js'
import { isCanvasPath } from '../../../shared/canvas.js'
import { DatabaseView } from './DatabaseView.js'
import { PlannerView } from './PlannerView.js'
import { InboxView } from './InboxView.js'
import { RoadmapView } from './RoadmapView.js'
import { VersionsView } from './VersionsView.js'
import { TerminalView } from './TerminalView.js'
import { PaneMenu, PaneMenuItem } from './PaneMenu.js'
import { BookmarkToggleItem } from './BookmarksView.js'
import type { VaultNoteMeta, InboxItem } from '../../../shared/notemeta.js'
import type { WikilinkRef } from './helpers.js'
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
export type MainView =
  | 'editor'
  | 'versions'
  | 'graph'
  | 'database'
  | 'inbox'
  | 'roadmap'
  | 'canvas'
  | 'planner'
  /**
   * The terminal is a SURFACE now, not a sidebar panel.
   *
   * It was rendered into the ~250px sidebar column, which is a strange place
   * for the one feature in this app that can reach the operating system: it is
   * a log you read and a prompt you type into, and both wanted the width. Under
   * the ribbon's rule — the ribbon picks the surface, the sidebar finds notes —
   * it could not have stayed there anyway, because it finds nothing.
   */
  | 'terminal'

export interface MainCanvasProps {
  note: VaultNoteBody | null
  text: string
  onTextChange: (text: string) => void
  isDirty: boolean
  onSave: (text: string, mtime: number) => Promise<void>
  onConflict: (diskMtime: number, diskText: string) => void
  /** Save an older version over the open note. False when the user declined. */
  onRestore: (text: string) => Promise<boolean>
  /**
   * Write one frontmatter property back into a note, from a database cell.
   *
   * Owned by <VaultPane> rather than here because it may have to touch the open
   * buffer: the row being edited can be the note in the editor, and a file that
   * changed under a buffer still showing the old frontmatter is the exact split
   * this feature exists to close. It rejects when that buffer is dirty.
   */
  onSetProperty: (path: string, key: string, value: string) => Promise<void>
  /**
   * Write `[[to]]` into `from`'s Markdown — the graph's Alt+drag.
   *
   * Resolves to whether anything was actually written, so a cancelled confirm
   * or an already-existing link does not pay for a full graph rebuild. It does
   * not reject: it reports its own failures on the pane's banner, because the
   * caller is a canvas pointer handler.
   */
  onAddLink: (from: string, to: string) => Promise<boolean>
  getGraph: () => Promise<VaultGraph>
  getNotes: () => Promise<VaultNoteMeta[]>
  getInbox: () => Promise<InboxItem[]>
  /**
   * The open board's path. Pane state in <VaultPane>, not tab state, for the
   * same reason `splitView` is: one board at a time is the v1 scope, and a
   * canvas is not a note so it cannot ride on a tab's `path`.
   */
  canvasPath: string | null
  backlinks: string[]
  /** Resolves false when the open was refused — a conflict dialog, a declined
   *  discard, or a failed read. Callers must not commit a view change until
   *  this says the note is actually open. */
  onOpenNote: (path: string) => Promise<boolean>
  onOpenWikilink: (link: WikilinkRef) => void
  discarded: { label: string; text: string } | null
  /** Where in the open note to land, from the link that opened it. */
  anchor: { fragment?: string; line?: number; nonce: number } | null
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
  onSetProperty,
  onAddLink,
  getGraph,
  getNotes,
  getInbox,
  canvasPath,
  backlinks,
  onOpenNote,
  onOpenWikilink,
  discarded,
  anchor,
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
  /**
   * THE LOAD FOLLOWS THE VIEW, NOT THE CLICK, and that distinction is a bug fix.
   *
   * This used to live inside `handleSwitchToGraph`, which is the Graph TAB's
   * onClick — so the data arrived only when the graph was reached by pressing
   * that one control. The moment a second entry point existed (the Graph ribbon
   * icon, which switches the view from VaultPane) the view rendered with
   * `graph` still null and said "No graph data" over a vault with 470 nodes in
   * it. The tab worked, the icon did not, and nothing about the code said why.
   *
   * Keyed on `view` alone, so every route into the graph loads it and there is
   * only one place that can be wrong. `live` cancels a late response the same
   * way every async effect in this pane does — leaving the graph view and
   * coming back must not paint the first request's answer over the second's.
   *
   * The always-re-fetch contract below is preserved deliberately: it is cheap
   * because the memo lives in the main process (`graph()` in vault.ts), where
   * it has a TTL and is invalidated by our own saves. A memo up here is what
   * used to make an added [[link]] invisible until the app restarted.
   */
  useEffect(() => {
    if (view !== 'graph') return
    let live = true
    setLoadingGraph(true)
    setGraphError(null)
    // Read-only. The graph is a rebuildable cache derived from wikilinks and is
    // never written back from this pane.
    getGraph()
      .then((g) => {
        if (live) setGraph(g)
      })
      .catch((e: unknown) => {
        if (live) setGraphError(String(e))
      })
      .finally(() => {
        if (live) setLoadingGraph(false)
      })
    return () => {
      live = false
    }
  }, [view])

  /**
   * DATABASE AND INBOX LOAD FROM THE VIEW TOO, for the reason the graph effect
   * above already documents at length.
   *
   * Both used to load inside an onClick — `handleSwitchToDatabase` and
   * `handleSwitchToInbox`, the two buttons in the strip that is now gone. The
   * graph had exactly that shape once, and its comment records what happened:
   * "the moment a second entry point existed (the Graph ribbon icon...) the
   * view rendered with `graph` still null and said 'No graph data' over a vault
   * with 470 nodes in it. The tab worked, the icon did not, and nothing about
   * the code said why."
   *
   * Promoting these three surfaces into the ribbon creates that second entry
   * point for the other two. Keying the load on the view rather than on one
   * control is what stops the same bug landing twice more, and it is why the
   * strip could be deleted without taking the data with it.
   */
  useEffect(() => {
    if (view !== 'database') return
    let live = true
    setLoadingNotes(true)
    setNotesError(null)
    /**
     * Always re-fetch, never memo up here.
     *
     * A cached note list is worse than a cached graph, not better. Frontmatter
     * is exactly what this view exists to show, so an edit to `status:` that
     * the table keeps showing the old value for is the stale-status-board
     * failure the database view was built to end.
     *
     * There is NO cache behind this. `vault.ts` memoises `graph()` only
     * (GRAPH_TTL_MS, invalidated by save); `list()` does a fresh round trip on
     * every switch. Affordable at 258 notes and the correct default for a view
     * whose whole job is to be current — but do not read this as "something
     * upstream is caching for me".
     */
    getNotes()
      .then((n) => {
        if (live) setNotes(n)
      })
      .catch((e: unknown) => {
        if (live) setNotesError(String(e))
      })
      .finally(() => {
        if (live) setLoadingNotes(false)
      })
    return () => {
      live = false
    }
  }, [view])

  /**
   * The graph too, for derived facets — but SEPARATELY, and its failure is not
   * the table's failure.
   *
   * Facets are an extra column; the database is a working view without them, so
   * a graph that will not build must degrade that column rather than take the
   * whole table down with an error nobody can act on. Skipped entirely when the
   * graph is already loaded, since the graph view and this share one copy and
   * it is memoised in main for 30 seconds anyway.
   */
  useEffect(() => {
    if (view !== 'database' || graph) return
    let live = true
    getGraph()
      .then((g) => {
        if (live) setGraph(g)
      })
      .catch(() => {
        /* the facet column degrades to folder and date, which need no graph */
      })
    return () => {
      live = false
    }
  }, [view, graph])

  /**
   * THE "BRING THE EDITOR FORWARD" EFFECT USED TO LIVE HERE. It watched the
   * open note's path and switched view when it changed, because the tree, the
   * tab bar and the arrows could all load a note and none of them could reach
   * `view`. It is gone, and <VaultPane> now switches at the navigation itself.
   *
   * Deleted rather than kept alongside, because inferring a navigation from a
   * path change was wrong three ways and each one was reachable:
   *
   *  - RE-OPENING THE OPEN NOTE is not a path change. With the versions panel
   *    or the planner up, clicking that note in the tree fired nothing and the
   *    sidebar was dead against the tab.
   *  - A TAB CLICK loads the incoming tab's note, so this fired and reset that
   *    tab's view to the editor — a tab parked on the graph never stayed there.
   *  - IN SPLIT, both canvases see the same note, so the second one collapsed
   *    onto the editor too and the split showed one view twice.
   */

  /**
   * Re-fetch every time, for the strongest version of the reason the other two
   * have: this queue's whole job is to tell you what arrived since you last
   * looked. A cached inbox is a lie about the present.
   */
  useEffect(() => {
    if (view !== 'inbox') return
    let live = true
    setLoadingInbox(true)
    setInboxError(null)
    getInbox()
      .then((i) => {
        if (live) setInbox(i)
      })
      .catch((e: unknown) => {
        if (live) setInboxError(String(e))
      })
      .finally(() => {
        if (live) setLoadingInbox(false)
      })
    return () => {
      live = false
    }
  }, [view])

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
            : view === 'canvas'
              ? // The board's own name, because a canvas IS a document — unlike
                // the graph and the database, which are lenses over all of them.
                (canvasPath?.split('/').pop()?.replace(/\.canvas$/i, '') ?? 'Canvas')
              : view === 'database'
              ? 'Database view'
              : view === 'planner'
              ? 'Planner'
              : view === 'inbox'
                ? 'Inbox'
                : view === 'terminal'
                ? 'Terminal'
              : view === 'roadmap'
                  ? 'Roadmap'
                  : view === 'versions'
                    ? // Still the note's own view, so it keeps the note's name.
                      `${note?.title ?? 'No note selected'} — versions`
                    : /* Empty, not "No note selected".
                       *
                       * This strip is a note's NAME. With no note there is no
                       * name, and the editor below already says so — the two
                       * sat 470px apart saying the same six words, which reads
                       * as the app repeating itself rather than as one answer.
                       * The body keeps the message because it is the half that
                       * can also say what to do about it. */
                      (note?.title ?? '')}
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

      {/**
       * THE SECOND NAVIGATION STRIP USED TO BE HERE, and deleting it is the
       * point of this change rather than a side effect of it.
       *
       * It was five text buttons — Canvas, Graph, Database, Inbox, Roadmap —
       * sitting inside the main area while a column of icons down the left
       * edge did the same job for a different, overlapping set. Canvas and
       * Graph were in BOTH, four inches apart, one drawn as an icon and one as
       * bare text, so the two controls for one destination did not read as
       * related. Database, Inbox and Roadmap were ONLY here, which made them
       * invisible until you had already arrived somewhere else.
       *
       * All five are ribbon icons now, beside the surfaces they were separated
       * from for no stated reason. `LeftRibbon.tsx` holds the rule.
       *
       * The unsaved-edits notice stays, because it is not navigation: it
       * answers the question the surface switch raises. It renders only when
       * there is something to say, so the row does not exist otherwise —
       * unlike the strip, which was 40px of chrome on every screen.
       */}
      {isDirty && (
        <div className="vault-view-notice">
          <span className="vault-canvas-dirty-warning">
            Unsaved changes are kept while you switch views
          </span>
        </div>
      )}

      <div className="vault-view-content">
        {view === 'terminal' ? (
          /**
           * Full width now, where it used to be squeezed into the ~250px
           * sidebar. It is a rendered log plus a prompt — see the header of
           * TerminalView — and both wanted the room the sidebar could not give.
           *
           * Closing returns to the note rather than to a sidebar panel, which
           * is the only thing "close" can mean once this is a surface.
           */
          <TerminalView onClose={() => onViewChange('editor')} />
        ) : view === 'roadmap' ? (
          <RoadmapView />
        ) : view === 'canvas' ? (
          <CanvasView
            path={canvasPath}
            onOpenNote={(path) => {
              // Same contract as the table and the graph: a file page that
              // opens a note behind the board reads as a dead click.
              void onOpenNote(path).then((opened) => {
                /**
                 * UNLESS THE PAGE IS ANOTHER BOARD, which is the drill-down:
                 * the main board holds a page per pipeline and clicking one
                 * goes INTO that pipeline.
                 *
                 * `openNote` already routed the `.canvas` to the canvas view
                 * and returned true. Switching to the editor here undid that
                 * one line later, so opening a board from a board landed you in
                 * the markdown editor instead — the exact "dead click" this
                 * callback exists to prevent, caused by the fix for it.
                 */
                if (opened && !isCanvasPath(path)) onViewChange('editor')
              })
            }}
          />
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
        ) : view === 'planner' ? (
          <PlannerView
            getNotes={getNotes}
            onOpenNote={async (path) => {
              // Same conditional switch the table and the graph use: a refused
              // open — a declined discard, a conflict dialog — must not drag
              // the user out of the month they were reading.
              if (await onOpenNote(path)) onViewChange('editor')
            }}
          />
        ) : view === 'database' ? (
          <DatabaseView
            notes={notes}
            graph={graph}
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
            /**
             * RE-READ THE WHOLE LIST after a successful write, rather than
             * patching the edited row in place.
             *
             * The row is not the only thing the write changed. `updated:` is
             * frontmatter too, `mtime` moved, and the month grouping and the
             * Updated sort both read those — so a locally patched row would
             * agree with the file about `status` and lie about everything else.
             * This is the same `getNotes()` a tab switch already runs, and the
             * comment on `handleSwitchToDatabase` above is the reason it is
             * affordable: there is no cache behind it and the view's whole job
             * is to be current.
             *
             * NOT wrapped in try/catch. A failed write must reach the cell that
             * asked for it — that is where the conflict is reported — and
             * swallowing it here would leave the table showing the old value
             * with no sign anything went wrong.
             */
            onSetProperty={async (path, key, value) => {
              await onSetProperty(path, key, value)
              setNotes(await getNotes())
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
            anchor={anchor}
          />
        ) : graphError ? (
          <div className="vault-graph-error">Graph failed: {graphError}</div>
        ) : loadingGraph && !graph ? (
          /**
           * The strip button used to carry this, as its own label going
           * "Loading...". Deleting the strip would have deleted the only
           * feedback a 470-node vault gives while it builds, so it moves into
           * the view rather than out of the app.
           *
           * `&& !graph` so a re-fetch does not blank a graph that is already on
           * screen — the effect above re-runs on every entry to this view, and
           * replacing a drawn layout with a spinner each time would be a
           * regression the button never had.
           */
          <div className="vault-graph-loading">Building the graph...</div>
        ) : (
          <GraphView
            graph={graph}
            /**
             * RE-FETCH, don't patch a link into the local copy.
             *
             * `save()` calls `invalidateGraph()` in main, so this comes back
             * rebuilt from the files rather than from a cached index — which is
             * the point: the new edge has to appear because it is in the
             * Markdown now, not because the renderer drew one it was told
             * about. If the write did not happen, neither does this.
             */
            onLinkNotes={(from, to) => {
              void onAddLink(from, to)
                .then(async (written) => {
                  if (written) setGraph(await getGraph())
                })
                /**
                 * The rebuild can fail after the write SUCCEEDED, and without
                 * this that is an unhandled rejection: no new edge, no error,
                 * and no sign the link is in fact on disk. Reported the same
                 * way `handleSwitchToGraph` reports a failed fetch, because it
                 * is the same failure — `onAddLink` never rejects, so anything
                 * arriving here came from `getGraph`.
                 */
                .catch((e: unknown) => setGraphError(String(e)))
            }}
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
