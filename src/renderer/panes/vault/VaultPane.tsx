/**
 * SECTION 2 — Obsidian pane (top right), vault open.
 *
 * Rebuild the Obsidian workspace layout, structure-for-structure. Regions:
 *   left ribbon      files · search · bookmarks · graph · canvas · calendar ·
 *                    terminal · plugins
 *   explorer header  new note · new folder · sort · collapse-all · expand
 *   folder tree      real vault folders, collapsible, in vault order
 *   vault switcher   vault name · help · settings (bottom row)
 *   tab bar          named tabs · new tab · tab-list chevron · split
 *   main canvas      editor OR graph view, each with its own controls
 *
 * v1 editor scope: read, edit, wikilinks, backlinks, graph. No plugin API, no
 * live preview, no canvas. A <textarea> is the right v1 editor.
 *
 * NO styling beyond structure.
 *
 * THE EDIT BUFFER LIVES HERE, not in <Editor>. That is deliberate: the editor
 * unmounts whenever the canvas switches to the graph view, and state inside an
 * unmounted component is gone. Holding the buffer at this level is what stops a
 * click on "Graph" from silently discarding unsaved edits, and it is what lets
 * the conflict dialog act on the user's REAL current text rather than a stale
 * snapshot. There is no auto-save, no debounce, no save-on-blur and no
 * save-on-unmount anywhere in this pane. Writes happen only on an explicit click.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useVault } from './useVault.js'
import { LeftRibbon, ribbonLabel } from './LeftRibbon.js'
import { SidebarPlaceholder } from './SidebarPlaceholder.js'
import { CanvasList } from './CanvasView.js'
import { SidebarResizer } from './SidebarResizer.js'
import { TerminalView } from './TerminalView.js'
import { BookmarksView } from './BookmarksView.js'
import { DailyNotesView } from './DailyNotesView.js'
import { ExplorerHeader } from './ExplorerHeader.js'
import { FolderTree } from './FolderTree.js'
import { VaultSwitcher } from './VaultSwitcher.js'
import { TabBar, type VaultTab } from './TabBar.js'
import { MainCanvas, type MainView } from './MainCanvas.js'

/**
 * What a tab is CALLED when it holds no note.
 *
 * A tab showing the database used to still read "New tab", because the name was
 * only ever written by `loadNote` and a view change is not a note. A label that
 * does not describe its own contents is the same lie as a button that does
 * nothing. Once a tab has a note, the note's title wins — the view is then a
 * lens on that note rather than the whole of it.
 */
const VIEW_LABEL: Record<MainView, string> = {
  editor: 'New tab',
  versions: 'Versions',
  graph: 'Graph',
  database: 'Database',
  inbox: 'Inbox',
  roadmap: 'Roadmap',
  canvas: 'Canvas',
  planner: 'Planner',
}
import { ConflictDialog } from './ConflictDialog.js'
import { SettingsDialog } from './SettingsDialog.js'
import { HelpDialog } from './HelpDialog.js'
import { NameDialog } from './NameDialog.js'
import { ArtCredit } from './ArtCredit.js'
import {
  collectFolderPaths,
  folderOf,
  indexNotesByName,
  isBufferDirty,
  isPlainName,
  isSaveConflict,
  nextUntitledPath,
  resolveWikilink,
  sortTree,
  type TreeSort,
  type WikilinkRef,
} from './helpers.js'
import type { VaultNoteBody } from '../../../shared/ipc.js'
import { setFrontmatter } from '../../../shared/notemeta.js'
import { addWikilink, linkTextFor, NEW_HEADING } from '../../../shared/wikilink.js'
import './split.css'

export function VaultPane(): React.ReactElement {
  const vault = useVault()
  /**
   * The layout box. <SidebarResizer> writes `--vault-sidebar-w` onto it during
   * a drag, and `.vault-sidebar` reads it — so a resize reflows two boxes and
   * re-renders nothing. Deliberately not width state: this component owns the
   * edit buffer and re-renders on every keystroke already.
   */
  const layoutRef = useRef<HTMLDivElement>(null)
  const [activeRibbon, setActiveRibbon] = useState('files')
  const [selectedNote, setSelectedNote] = useState<VaultNoteBody | null>(null)
  /**
   * The open note's path, readable AFTER an await.
   *
   * `selectedNote` inside an async handler is whatever it was when the closure
   * was made, and the write handlers below await a read and a save — the user
   * can open a different note in that window. `handleSave` already guards its
   * `setSelectedNote` with a functional updater for exactly this reason, but a
   * functional updater cannot guard `setBuffer`: its `prev` is the buffer, not
   * the note. So the current path is mirrored here and checked at the moment
   * the write lands. Without it, note A's text is loaded under note C's
   * identity, isDirty flips, and the next Save writes A over C.
   */
  const openPathRef = useRef<string | null>(null)
  openPathRef.current = selectedNote?.path ?? null
  /** The live edit buffer. Never written to disk without an explicit click. */
  const [buffer, setBuffer] = useState('')
  const [backlinks, setBacklinks] = useState<string[]>([])
  const [tabs, setTabs] = useState<VaultTab[]>([
    // Placeholder only. Renamed to the real folder name by the effect below,
    // as soon as the first tree arrives — it used to be a literal that outlived
    // every vault change.
    { id: 'default', name: 'Vault', path: null, view: 'editor' },
  ])
  const [activeTabId, setActiveTabId] = useState('default')
  /**
   * The SECOND canvas's view, when split. It is pane state and not tab state on
   * purpose: the point of split is looking at two views of one note at once, so
   * the right-hand pane is a lens, not a document. The left-hand view is the
   * tab's and travels with it.
   */
  const [splitView, setSplitView] = useState<MainView>('graph')

  /**
   * The open canvas board. Pane state rather than tab state, deliberately: a
   * board is a document, but tabs carry a NOTE path that the editor buffer and
   * the whole save path are built around, and threading a second kind of
   * document through them is a bigger change than one board at a time is worth.
   * Multiple canvas tabs is the upgrade, not the omission.
   */
  const [canvasPath, setCanvasPath] = useState<string | null>(null)

  /**
   * The open vault's name, from the tree root — the folder's own basename.
   *
   * Derived, never stored, so it cannot go stale against the folder actually
   * being read. Empty until the first tree lands; the switcher renders the
   * placeholder for that one frame rather than a name that might be wrong.
   */
  const vaultName = vault.tree?.name ?? 'Vault'

  /**
   * Rename the seeded first tab once the vault's real name is known.
   *
   * That tab is created before any tree has loaded, so it has to be seeded with
   * something — and it was seeded with the literal "Universal Vault", which
   * then never changed no matter which folder was opened. Scoped as tightly as
   * possible: only the original tab, only while it still holds no note and is
   * still on the editor view, so nothing a user has since done to it is
   * overwritten.
   */
  useEffect(() => {
    if (vaultName === 'Vault') return
    setTabs((ts) =>
      ts.map((t) =>
        t.id === 'default' && t.path === null && t.view === 'editor' && t.name !== vaultName
          ? { ...t, name: vaultName }
          : t,
      ),
    )
  }, [vaultName])

  /**
   * The primary canvas's view IS the active tab's view. Derived, not mirrored:
   * a second copy in state would drift the moment a tab switch raced a view
   * click, and there is no state here that the tabs array does not already hold.
   */
  const view: MainView = tabs.find((t) => t.id === activeTabId)?.view ?? 'editor'

  /**
   * `tabId` defaults to the active tab but is a parameter for the same reason
   * `loadNote`'s is: a tab CLICK opens the note before it activates the tab, so
   * at that moment `activeTabId` is still the tab being left, and the default
   * would rewrite the view of the tab the user just navigated away from.
   */
  const handleViewChange = (next: MainView, tabId: string = activeTabId) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId
          ? { ...t, view: next, name: t.path ? t.name : VIEW_LABEL[next] }
          : t,
      ),
    )
  }
  /**
   * Two canvases over one note and one buffer, differing only in view mode —
   * which <MainCanvas> already owns locally, so this is a boolean rather than a
   * layout system. Per-pane notes and drag-to-resize are separate features.
   */
  const [split, setSplit] = useState(false)
  /**
   * Explorer sort order, applied to a COPY of the tree below. Not persisted:
   * `AppSettings` holds the vault directory and nothing else, and a sort order
   * is not worth growing that contract for.
   */
  const [sort, setSort] = useState<TreeSort>('folders-asc')
  /**
   * The boot vault-root warning, shown IN THE PANE rather than only in the
   * settings modal.
   *
   * `checkRoots()` has been producing a good sentence for a while and nobody
   * has ever read it: `state()` carries it over IPC, and the only thing that
   * rendered it was <SettingsDialog>, three clicks away behind a gear icon.
   * So the failure it describes — a root above a vault, which turns 281 notes
   * and 657 links into 1 420 notes, 567 links and 1 344 orphans — presented as
   * a graph full of unconnected dust with no text anywhere on screen. The user
   * would have had to already suspect the vault path to go find the sentence
   * explaining that the vault path is wrong.
   *
   * The graph and the database are where the damage is visible, so the
   * explanation belongs next to them. Dismissible, because it is a diagnosis
   * and not a modal: someone deliberately indexing a tree that contains a vault
   * should be told once and then left alone.
   */
  const [rootWarning, setRootWarning] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    // Failure here is not worth surfacing: this is the DIAGNOSTIC channel, and
    // a diagnostic that raises its own error banner is just noise on top of
    // whatever the real problem was.
    void window.api.settings
      .get()
      .then((s) => {
        if (live) setRootWarning(s.rootMismatch)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const [conflictOpen, setConflictOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [conflictData, setConflictData] = useState<{
    diskMtime: number
    diskText: string
  } | null>(null)
  /**
   * Why a conflict resolution failed. Without this the three buttons could fail
   * into console.error alone: the click appeared to do nothing at all, and the
   * user had no way to tell "saved" from "still unsaved" in the one dialog where
   * that distinction is the whole point.
   */
  const [conflictError, setConflictError] = useState<string | null>(null)
  /**
   * Whichever side of a conflict the user chose to throw away, kept in memory
   * so a reflex click is recoverable by copy/paste. Cleared only by opening a
   * different note.
   */
  const [discarded, setDiscarded] = useState<{ label: string; text: string } | null>(
    null,
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /**
   * Navigation history for the note header's back/forward, browser-style:
   * `trail` is the path list, `index` is where we are in it. Opening a note
   * from the tree truncates anything ahead of the cursor.
   *
   * This is real state rather than two decorative arrows on purpose — the
   * section-1 review found inert controls sitting next to live ones, and a
   * back button that does nothing is worse than no back button.
   *
   * ONE piece of state, not two. As a separate array and index, `openNote` read
   * the index from its render closure to truncate the trail while advancing it
   * with a functional updater — and `openNote` awaits a vault read first, so two
   * quick clicks both truncated against the SAME stale index and then each
   * incremented. That left the index pointing past the end of a one-entry
   * trail: Back was enabled and went to the note already open, Forward was
   * disabled with history ahead of it. A trail and its cursor are one fact and
   * have to move in one update.
   */
  const [nav, setNav] = useState<{ trail: string[]; index: number }>({
    trail: [],
    index: -1,
  })
  /** A failed open used to be a console-only no-op — invisible to the user. */
  const [openError, setOpenError] = useState<string | null>(null)
  /**
   * The `#heading` or `#^block-id` of the link being followed, handed to the
   * editor to land on. Lives here rather than in the editor because the link is
   * clicked in one note and consumed in another, and the editor for the second
   * one has not mounted yet at the moment of the click.
   */
  const [anchor, setAnchor] = useState<{ fragment: string; nonce: number } | null>(
    null,
  )

  const canGoBack = nav.index > 0
  const canGoForward = nav.index >= 0 && nav.index < nav.trail.length - 1

  const isDirty = isBufferDirty(selectedNote?.text ?? null, buffer)

  const noteIndex = useMemo(() => indexNotesByName(vault.tree), [vault.tree])

  /**
   * The tree as the explorer draws it. A memo because this pane re-renders on
   * every keystroke in the editor — it owns the buffer — and re-sorting the
   * whole vault per character would be a real cost for a result that changes
   * only when the tree or the mode does.
   *
   * The wikilink index above is built from the UNSORTED tree on purpose: it is
   * a lookup, order means nothing to it, and keying it to the sort would throw
   * the map away every time the dropdown moved.
   */
  const sortedTree = useMemo(() => sortTree(vault.tree, sort), [vault.tree, sort])

  /**
   * Backlinks for the open note. Cancelled on note change / unmount so a slow
   * response cannot overwrite a newer note's backlinks.
   *
   * Keyed on the PATH, not on the note object. `backlinks()` rebuilds the whole
   * wikilink graph — every note in the vault read over HTTP — and `handleSave`
   * replaces `selectedNote` with a new object on every successful save. On the
   * object the effect re-ran on each save and paid a full-vault rescan for a
   * result that cannot have changed for the note you are sitting on.
   */
  const selectedPath = selectedNote?.path ?? null
  useEffect(() => {
    if (!selectedPath) {
      setBacklinks([])
      return
    }
    let cancelled = false
    vault
      .getBacklinks(selectedPath)
      .then((links) => {
        if (!cancelled) setBacklinks(links)
      })
      .catch(() => {
        if (!cancelled) setBacklinks([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedPath, vault.getBacklinks])

  /**
   * Load a note into the buffer. Returns whether it actually happened — every
   * caller needs to know, because history must only move when the note really
   * changed. It can decline for three reasons: an open conflict, a declined
   * discard prompt, or a failed read.
   */
  const loadNote = async (
    path: string,
    tabId: string = activeTabId,
  ): Promise<boolean> => {
    // An open conflict must be resolved before anything else can move. Closing
    // it implicitly is how the buffer used to vanish.
    if (conflictOpen) return false
    if (isDirty) {
      const ok = window.confirm(
        `"${selectedNote?.title ?? 'This note'}" has unsaved edits that will be lost. Discard them and open the other note?`,
      )
      if (!ok) return false
    }
    try {
      const note = await vault.readNote(path)
      setSelectedNote(note)
      setBuffer(note.text)
      setDiscarded(null)
      setOpenError(null)
      // The tab records the note HERE rather than in each caller, because this
      // is the single point where a note actually became current — the tree, a
      // wikilink, a backlink, a graph node, a database row and the inbox all
      // funnel through it, and six copies of this line would drift.
      //
      // `tabId` is a parameter and not just `activeTabId` for the tab-click
      // case: that click has to open the note BEFORE it switches tabs (the open
      // can be refused), so at this moment `activeTabId` is still the tab being
      // navigated away from, and defaulting would rename the wrong one.
      setTabs((ts) =>
        ts.map((t) => (t.id === tabId ? { ...t, name: note.title, path } : t)),
      )
      return true
    } catch (e) {
      setOpenError(
        `Could not open ${path}: ${e instanceof Error ? e.message : String(e)}`,
      )
      return false
    }
  }

  /**
   * Returns whether the note actually opened.
   *
   * It used to return nothing, so every caller assumed success. `loadNote`
   * declines on three real paths -- an open conflict dialog, a declined
   * discard prompt, and a failed read -- and a caller that switches view
   * regardless yanks the user somewhere they just said no to.
   */
  const openNote = async (path: string, tabId?: string): Promise<boolean> => {
    /**
     * A `.canvas` is not a note, and this is the ONE place that has to know.
     *
     * The guard lives here rather than in the explorer because `openNote` is
     * the single entry point every caller already routes through — the tree,
     * bookmarks, wikilinks, the nav trail, the database and the graph. Branching
     * in FolderTree would have fixed the explorer and left every other path
     * still loading JSON into the markdown buffer.
     *
     * It returns BEFORE the nav trail push on purpose: back and forward call
     * `loadNote` directly, so a board in the trail would be read as a note the
     * moment someone pressed Back.
     */
    if (path.toLowerCase().endsWith('.canvas')) {
      setCanvasPath(path)
      handleViewChange('canvas', tabId)
      return true
    }
    if (!(await loadNote(path, tabId))) return false
    /**
     * OPENING A NOTE IS SHOWING IT, and this is where that has to be said.
     *
     * <MainCanvas> used to infer it from the open path changing. That missed
     * the case the Versions view exposed: with the panel up you re-click the
     * note already open, the path does not change, the effect does not fire,
     * and the sidebar goes dead against that tab — the only ways back to the
     * editor were a new tab or closing this one. The planner behaved the same.
     * Inferring a navigation from its result is the bug; the navigation itself
     * happens here, and every entry point funnels through it.
     *
     * NOT ON A TAB CLICK. `tabId` is passed only by <TabBar>, and a tab's view
     * is its own — switching to a tab parked on the graph must show the graph.
     * Back and forward call `loadNote` directly and switch for themselves.
     */
    if (tabId === undefined) handleViewChange('editor')
    // Browser semantics: opening from the tree truncates any forward history.
    // Trail and cursor move together, both read from the same `n`.
    setNav((n) => ({
      trail: [...n.trail.slice(0, n.index + 1), path],
      index: n.index + 1,
    }))
    return true
  }

  /**
   * Back and forward go through `loadNote` rather than `openNote` — they must
   * not push the trail they are walking — so they carry the view switch that
   * `openNote` does, for the same reason: arriving at a note behind the
   * versions panel or the planner reads as an arrow that does nothing.
   */
  const goBack = async () => {
    if (!canGoBack) return
    if (await loadNote(nav.trail[nav.index - 1])) {
      setNav((n) => ({ ...n, index: n.index - 1 }))
      handleViewChange('editor')
    }
  }

  const goForward = async () => {
    if (!canGoForward) return
    if (await loadNote(nav.trail[nav.index + 1])) {
      setNav((n) => ({ ...n, index: n.index + 1 }))
      handleViewChange('editor')
    }
  }

  /**
   * Follow a wikilink, including its `#heading` or `#^block-id`.
   *
   * TWO HALVES, AND THE SECOND ONLY RUNS IF THE FIRST DID. Resolving the note
   * is this pane's job because it holds the name index; finding the line is the
   * editor's, because it holds the text. The anchor is set only after the open
   * actually happened — `openNote` declines on a conflict dialog, a refused
   * discard and a failed read, and scrolling a note the user just said no to
   * would be the editor acting on a navigation that never occurred.
   *
   * An EMPTY target means `[[#Heading]]`: a link into the note it is written
   * in. There is nothing to open, so it goes straight to the anchor.
   */
  const handleOpenWikilink = (link: WikilinkRef) => {
    const jump = () => {
      if (link.fragment) setAnchor((a) => ({ fragment: link.fragment!, nonce: (a?.nonce ?? 0) + 1 }))
    }
    if (!link.target) {
      jump()
      return
    }
    const path = resolveWikilink(link.target, noteIndex)
    if (!path) return
    void openNote(path).then((opened) => {
      if (opened) jump()
    })
  }

  /**
   * PLACEMENT, not preference: this sits BEFORE handleSave rather than after
   * it because review-s2-vault-pane.test.mjs reads this file as text and slices
   * handleSave's body out with `indexOf('const handleSave')` ->
   * `indexOf('const handleConflict')`. A function between those two markers is
   * read as part of handleSave, and this one legitimately calls setBuffer,
   * which that suite forbids there. Keep new handlers out of that span.
   *
   * Restore an old version: a SAVE of its text, never a file copy.
   *
   * Routed through the same `vault.saveNote` as the Save button, deliberately,
   * and with `target.mtime` — the stamp read() handed us — as the version being
   * replaced. So the lost-update guard runs, the CURRENT text is copied into
   * `.backups/` before it is overwritten (a restore is itself undoable), and a
   * note changed by someone else in the meantime raises SaveConflict instead of
   * being clobbered. <VersionsView> reports that; it does not open the conflict
   * dialog, which is about the edit buffer and has nothing useful to offer here.
   *
   * The buffer is updated too, and that is why this lives up here rather than
   * in the panel: writing the file and leaving the editor on the old text would
   * show "Unsaved changes" for text that is already on disk, and the next Save
   * would undo the restore.
   *
   * Returns false when the user declined the unsaved-edits prompt. Anything the
   * prompt discards is kept in `discarded`, the same recovery the conflict
   * dialog uses — a restore must not be the one action that eats typing.
   */
  const handleRestore = async (text: string): Promise<boolean> => {
    const target = selectedNote
    if (!target) return false
    const replaced = buffer
    if (isDirty) {
      const ok = window.confirm(
        `"${target.title}" has unsaved edits. Restoring an older version replaces them. Continue?`,
      )
      if (!ok) return false
    }
    const saved = await vault.saveNote(target.path, text, target.mtime)
    setSelectedNote((prev) =>
      prev && prev.path === target.path ? { ...prev, mtime: saved.mtime, text } : prev,
    )
    setBuffer(text)
    setDiscarded(
      isDirty ? { label: 'Your unsaved version (replaced by restore)', text: replaced } : null,
    )
    return true
  }

  /**
   * Write one frontmatter property back into a note from the database table.
   *
   * THE POINT OF THE FEATURE: the table is a lens, not a second store. Editing
   * `status` in a row has to end up as `status:` in that note's own Markdown,
   * or the app has three views of three different truths and the Markdown is
   * the one that loses.
   *
   * Routed through `vault.saveNote` for the same reason the restore above is:
   * it is the only write path that keeps a pre-edit copy in `.backups/` and
   * runs the lost-update guard. DatabaseView.tsx used to argue this could not
   * be built because "a table cell has nowhere to show" a SaveConflict. That
   * was the wrong half of the problem — <VersionsView> already reports one
   * inline without opening the dialog, and the cell now does the same. Nothing
   * about the guard needed weakening to make a cell editable.
   *
   * The mtime handed to save() is the one from THIS read, moments earlier, not
   * a stamp cached when the table was drawn. The table is a long-lived view
   * over hundreds of notes and its `mtime` column can be minutes stale, so
   * using it would raise a conflict on almost every edit and teach the user to
   * ignore the one that mattered. Read, patch, write, with the guard covering
   * the window that is actually ours.
   *
   * REFUSED, not merged, when the note is open in the editor with unsaved
   * edits. Both texts are legitimate and this cannot know which the user meant;
   * writing the file would strand the buffer on a stale mtime, and writing the
   * buffer would silently discard whatever they had typed. The error names the
   * note, because the row being edited is usually not the tab in front of them.
   */
  const handleSetProperty = async (path: string, key: string, value: string): Promise<void> => {
    const openHere = selectedNote?.path === path
    if (openHere && isDirty) {
      throw new Error(
        `"${selectedNote!.title}" is open in the editor with unsaved edits. Save or discard them first.`,
      )
    }
    const note = await vault.readNote(path)
    const next = setFrontmatter(note.text, key, value)
    // Setting a property to what it already says is not a write. Without this
    // every re-commit of an unchanged cell would burn a backup copy.
    if (next === note.text) return
    const saved = await vault.saveNote(path, next, note.mtime)
    /**
     * Keep the editor honest when it is showing the note that just changed.
     *
     * Only reachable when the buffer is CLEAN — the branch above refused
     * otherwise — so there is nothing of the user's to lose here. Leaving it
     * alone instead would show the old frontmatter over a file that no longer
     * says that, and the next Save would quietly undo the property edit.
     */
    // `openPathRef`, not the captured `openHere`: that was true when the edit
    // was requested, and two awaits have happened since. If the user opened
    // another note in between, loading this text into the buffer would put note
    // A's text under note C's identity and the next Save would write it there.
    if (openPathRef.current === path) {
      setSelectedNote((prev) =>
        prev && prev.path === path ? { ...prev, mtime: saved.mtime, text: next } : prev,
      )
      setBuffer(next)
    }
  }

  /**
   * ADD A CONNECTION: write `[[to]]` into `from`'s own Markdown.
   *
   * The graph half of the same idea the database cell answers. An edge is not a
   * thing this app stores — the graph, the Links column and the backlinks list
   * are all derived from wikilinks in the body — so "connect A to B" has
   * exactly one meaning, which is to write the link into A and let everything
   * re-derive. Anything else would be the app's first private store, and a
   * store is what the whole write-back exists to avoid.
   *
   * `linkTextFor` is handed THE SAME resolver the editor follows links with, so
   * the check it makes is literally "would clicking this link land on the note
   * I am linking to". That matters more than it sounds: the name index is
   * first-wins, and 6 of the 212 notes outside the skills library share a stem
   * with another, so a short link is sometimes a link to the wrong note.
   *
   * CONFIRMED BEFORE WRITING, unlike a property cell, because this appends a
   * line to PROSE in a file that is usually not on screen. `window.confirm` is
   * what the discard prompt in `loadNote` already uses; a real dialog would be
   * nicer and is not what makes this safe.
   *
   * The mtime comes from the read a moment earlier, so the guard covers the
   * window the dialog is open in: a note that changed while you were reading
   * the confirmation raises SaveConflict instead of being clobbered.
   *
   * Errors land on the pane's own banner rather than being thrown. The caller
   * is a canvas pointer handler with nowhere to put a rejection, and an
   * unhandled one would make a refused write look like a write that worked.
   *
   * Returns whether anything was written, so the graph is only re-fetched when
   * there is something new to draw.
   */
  const handleAddLink = async (from: string, to: string): Promise<boolean> => {
    if (from === to) return false
    try {
      // Same refusal as a property edit, for the same reason: two legitimate
      // texts and nothing here can know which one was meant.
      if (selectedNote?.path === from && isDirty) {
        throw new Error(
          `"${selectedNote.title}" is open in the editor with unsaved edits. Save or discard them first.`,
        )
      }
      const link = linkTextFor(to, (name) => resolveWikilink(name, noteIndex))
      const note = await vault.readNote(from)
      const next = addWikilink(note.text, link)
      // Already linked. Silent, not an error — dragging A to B twice is a
      // reasonable thing to do and the second one is simply already true.
      if (next === note.text) return false

      const headings = (t: string) => (t.match(/^#{1,6}\s/gm) ?? []).length
      const where =
        headings(next) > headings(note.text)
          ? `a new "${NEW_HEADING}" section`
          : 'its related-notes section'
      if (!window.confirm(`Add to ${from}\n\nIn ${where}:\n\n    ${link}`)) return false

      const saved = await vault.saveNote(from, next, note.mtime)
      // The editor may be showing the note that just grew a line. Only
      // reachable with a clean buffer, so there is nothing of the user's here.
      //
      // `openPathRef`, not the captured `selectedNote`: that is whatever was
      // open when this handler started, and a read and a save have completed
      // since. Opening another note in that window would otherwise load THIS
      // note's text into the buffer under the other note's identity.
      if (openPathRef.current === from) {
        setSelectedNote((prev) =>
          prev && prev.path === from ? { ...prev, mtime: saved.mtime, text: next } : prev,
        )
        setBuffer(next)
      }
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setOpenError(
        isSaveConflict(message)
          ? `${from} changed on disk since the graph was drawn. Nothing was written.`
          : message,
      )
      return false
    }
  }

  const handleSave = async (text: string, mtime: number) => {
    // Pin the note this save belongs to. `selectedNote` is captured from the
    // render that produced this closure, and a save is a round-trip to the
    // vault server; the user can open a different note while it is in flight.
    // Spreading the CAPTURED note into setSelectedNote afterwards put note A's
    // identity back on screen underneath note B's buffer, and the next Save
    // then wrote B's text over A. Update only if we are still on the same note.
    const target = selectedNote
    if (!target) return
    const saved = await vault.saveNote(target.path, text, mtime)
    // Record what is now on disk WITHOUT clobbering the buffer: if the user
    // kept typing while the save was in flight, those keystrokes stay, and the
    // note simply reads as dirty again.
    setSelectedNote((prev) =>
      prev && prev.path === target.path
        ? { ...prev, mtime: saved.mtime, text }
        : prev,
    )
  }

  const handleConflict = (diskMtime: number, diskText: string) => {
    setConflictData({ diskMtime, diskText })
    setConflictError(null)
    setConflictOpen(true)
  }

  /**
   * FORCE OVERWRITE. Re-saves the buffer under the disk's current mtime, which
   * defeats the lost-update guard on purpose. Gated behind the dialog click AND
   * a second explicit confirm, and the disk text is retained in `discarded` so
   * it is still recoverable in-app (the vault server also keeps its own backup).
   */
  const handleKeepBuffer = async () => {
    if (!selectedNote || !conflictData) return
    const ok = window.confirm(
      'This overwrites the version currently on disk with yours. The disk version will be kept in "Discarded version" below until you open another note. Continue?',
    )
    if (!ok) return
    try {
      setConflictError(null)
      const saved = await vault.saveNote(
        selectedNote.path,
        buffer,
        conflictData.diskMtime,
      )
      setDiscarded({ label: 'Disk version (overwritten)', text: conflictData.diskText })
      setSelectedNote({ ...selectedNote, mtime: saved.mtime, text: buffer })
      setConflictOpen(false)
      setConflictData(null)
    } catch (e) {
      // Dialog stays open and the buffer is untouched, so nothing is lost — but
      // say so, otherwise the click reads as a no-op.
      setConflictError(`Could not save your version: ${String(e)}`)
    }
  }

  /** Discards the buffer in favour of disk. Buffer is retained in `discarded`. */
  const handleKeepDisk = () => {
    if (!selectedNote || !conflictData) return
    setDiscarded({ label: 'Your version (discarded)', text: buffer })
    setSelectedNote({
      ...selectedNote,
      text: conflictData.diskText,
      mtime: conflictData.diskMtime,
    })
    setBuffer(conflictData.diskText)
    setConflictOpen(false)
    setConflictData(null)
    setConflictError(null)
  }

  const handleMerge = async (merged: string) => {
    if (!selectedNote || !conflictData) return
    try {
      setConflictError(null)
      const saved = await vault.saveNote(
        selectedNote.path,
        merged,
        conflictData.diskMtime,
      )
      setSelectedNote({ ...selectedNote, mtime: saved.mtime, text: merged })
      setBuffer(merged)
      setConflictOpen(false)
      setConflictData(null)
    } catch (e) {
      // Same as above: both sides are still in memory, but a silent failure here
      // is how a user walks away believing the merge landed.
      setConflictError(`Could not save the merge: ${String(e)}`)
    }
  }

  /**
   * Where a new note or folder goes: beside the note you are reading, or the
   * vault root when nothing is open.
   *
   * There is no selected-FOLDER anywhere in this pane — the tree tracks
   * expansion and nothing else — so this is the only signal available about
   * where the user is working, and it is the one a person means by "new note"
   * while reading something.
   */
  const targetFolder = () => (selectedNote ? folderOf(selectedNote.path) : '')

  /**
   * Create an empty note and open it.
   *
   * `save()` with mtime 0 IS the create. The guard it enforces only runs when
   * the file already exists — there is no version to lose on a file that does
   * not — so no second write door had to be opened for this, and there is
   * deliberately no `vault:create`: two ways to write a note means two places
   * to keep the lost-update guard correct.
   *
   * If the name collided anyway (the tree is a snapshot), the mtime 0 does not
   * force anything: an existing file has a real mtime, 0 fails the comparison,
   * and the save raises a conflict rather than flattening a note.
   */
  const handleNewNote = async () => {
    const path = nextUntitledPath(vault.tree, targetFolder())
    try {
      await vault.saveNote(path, '', 0)
      vault.reload()
      await openNote(path)
    } catch (e) {
      setOpenError(`Could not create ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Create a folder and reveal it.
   *
   * THIS USED TO CALL `window.prompt` AND DO NOTHING AT ALL.
   *
   * Electron does not implement prompt. It is on `window`, it is a function, so
   * nothing type-checks or greps as wrong — and it throws `prompt() is not
   * supported.` the instant it is called. The old comment here reasoned that a
   * native prompt was an established idiom because this file already uses
   * `window.confirm`; measured on the Electron 33 binary this app ships,
   * `confirm` opens a real modal and blocks, and `prompt` throws. The throw
   * landed on the handler's first line, ahead of its own try/catch, and the
   * caller invokes it as `void handleNewFolder()` — so the rejection went
   * nowhere and "+ Folder" was silently inert.
   *
   * The name now comes from <NameDialog>, and this half only creates.
   *
   * CONTAINMENT is not checked here and must not be: the name crosses IPC from
   * a renderer that is untrusted by design, so that check lives in
   * `vault.mkdir` where no caller can skip it, and its refusal lands in the
   * banner below.
   */
  const createFolder = async (name: string) => {
    setNewFolderOpen(false)
    const parent = targetFolder()
    const path = parent ? `${parent}/${name}` : name
    try {
      await vault.makeFolder(path)
      vault.reload()
      setExpanded((prev) => new Set(prev).add(path))
    } catch (e) {
      setOpenError(`Could not create ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * That the input is a NAME is a different check from containment, and it
   * belongs in front of the user rather than behind the create.
   *
   * A name with a separator in it quietly becomes a path: typed while
   * `Notes/Untitled.md` was open, `../Escaped` joined to `Notes` and resolved to
   * `Escaped` at the vault ROOT. Containment held, so main was right to allow
   * it; it is this control that promised something narrower than it delivered.
   * Found by driving the real app, not by reading. It now refuses while the
   * name is still being typed, instead of in a banner after the fact.
   */
  const folderNameError = (name: string): string | null =>
    isPlainName(name)
      ? null
      : `"${name}" is a path, not a folder name. New folders are created beside the open note; type a plain name.`

  /**
   * A new tab shows nothing until a note is opened into it, which is what makes
   * the tab visibly real — it used to append a row to an array nothing read,
   * and the canvas below never changed.
   *
   * Clearing the canvas discards the buffer, so it asks first, exactly as
   * opening another note does.
   */
  const handleNewTab = () => {
    if (
      isDirty &&
      !window.confirm(
        `"${selectedNote?.title ?? 'This note'}" has unsaved edits that will be lost. Discard them and open an empty tab?`,
      )
    ) {
      return
    }
    const newId = `tab-${Date.now()}`
    setTabs([...tabs, { id: newId, name: 'New tab', path: null, view: 'editor' }])
    setActiveTabId(newId)
    setSelectedNote(null)
    setBuffer('')
  }

  /**
   * Switch tabs by opening the tab's note, so the dirty-buffer confirm and the
   * conflict block apply to a tab click exactly as they do to the tree.
   *
   * The order matters: open FIRST, activate only on success. `openNote` returns
   * false when the user cancelled the discard prompt or the read failed, and a
   * tab that highlights itself over a note that did not open is the same lie as
   * a button that does nothing.
   */
  const handleTabChange = async (id: string) => {
    /**
     * CLICKING THE TAB YOU ARE ALREADY ON IS NOT A NAVIGATION, and everything
     * below assumes one happened.
     *
     * Without this it ran the whole open path against the note already open:
     * the discard confirm fired on your OWN unsaved edits — "…has unsaved edits
     * that will be lost", about the note you are sitting in — and answering yes
     * re-read the file and threw them away. The trail grew a duplicate entry
     * too, so Back then went to the note already on screen.
     *
     * `handleCloseTab` is the only other caller and cannot trip this: it acts
     * only when the tab being closed IS the active one, and then activates a
     * tab out of `rest`, which is the list with that id removed.
     */
    if (id === activeTabId) return
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.path) {
      if (!(await openNote(tab.path, id))) return
    } else {
      /**
       * A tab holding no note must SHOW no note.
       *
       * This branch used to be absent: `if (tab.path && ...)` simply fell
       * through to `setActiveTabId`, leaving the previous tab's note on screen.
       * That is why a new tab looked like a copy of the one before it, and why
       * switching back appeared to change nothing — both tabs were rendering
       * the same pane-wide `selectedNote`.
       *
       * The dirty confirm is repeated rather than shared with `loadNote`,
       * because there is no note to load here and nothing else would ask.
       */
      if (
        isDirty &&
        !window.confirm(
          `"${selectedNote?.title ?? 'This note'}" has unsaved edits that will be lost. Discard them and switch tabs?`,
        )
      ) {
        return
      }
      setSelectedNote(null)
      setBuffer('')
      setBacklinks([])
      setDiscarded(null)
      setOpenError(null)
    }
    setActiveTabId(id)
  }

  /**
   * Close a tab. The buffer is pane-wide and is NOT touched here — closing a
   * tab is not a decision to throw text away, and the note stays open until
   * something actually navigates.
   */
  const handleCloseTab = (id: string) => {
    if (tabs.length <= 1) return
    const closing = tabs.findIndex((t) => t.id === id)
    const rest = tabs.filter((t) => t.id !== id)
    setTabs(rest)
    if (id !== activeTabId) return
    // Its right-hand neighbour, or the new last tab when it was the rightmost.
    void handleTabChange(rest[Math.min(closing, rest.length - 1)].id)
  }

  const handleCloseOthers = () => setTabs(tabs.filter((t) => t.id === activeTabId))

  const handleCopyPath = () => {
    if (selectedNote) void navigator.clipboard.writeText(selectedNote.path)
  }

  const handleToggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleExpandAll = () => {
    setExpanded(new Set(collectFolderPaths(vault.tree)))
  }

  const handleCollapseAll = () => {
    setExpanded(new Set())
  }

  if (vault.loading) {
    return <div className="vault-pane-loading">Loading vault...</div>
  }

  if (vault.error) {
    return <div className="vault-pane-error">Error: {vault.error}</div>
  }

  /**
   * One element, rendered once or twice. React gives each position its own
   * component instance, so the two canvases get independent `view` state — the
   * editor on one side and the graph on the other — while every prop, and
   * therefore the note and the buffer, is identical by construction rather than
   * by remembering to keep two prop lists in step.
   */
  const canvasWith = (v: MainView, onChange: (v: MainView) => void) => (
    <MainCanvas
      note={selectedNote}
      text={buffer}
      onTextChange={setBuffer}
      isDirty={isDirty}
      onSave={handleSave}
      onConflict={handleConflict}
      onRestore={handleRestore}
      onSetProperty={handleSetProperty}
      onAddLink={handleAddLink}
      getGraph={vault.getGraph}
      getNotes={vault.getNotes}
      getInbox={vault.getInbox}
      canvasPath={canvasPath}
      backlinks={backlinks}
      onBack={goBack}
      onForward={goForward}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onOpenNote={openNote}
      onOpenWikilink={handleOpenWikilink}
      anchor={anchor}
      discarded={discarded}
      view={v}
      onViewChange={onChange}
    />
  )

  return (
    <div className="vault-pane">
      <div className="vault-layout" ref={layoutRef}>
        {/**
         * Versions is the one ribbon entry that opens a MAIN view instead of a
         * sidebar section, because that is what it is — a panel over the open
         * note, not a list to browse beside one.
         *
         * Without this branch it would land in the `else` below and render the
         * placeholder panel, which is what every unimplemented ribbon icon
         * does. Moving it off the top strip and into an icon that never shows
         * versions would not be moving the feature, it would be deleting it.
         */}
        <LeftRibbon
          activeView={view === 'versions' ? 'versions' : activeRibbon}
          onViewChange={(id) => {
            if (id === 'versions') handleViewChange('versions')
            else {
              setActiveRibbon(id)
              /**
               * The calendar icon is the one ribbon item that opens a MAIN view
               * as well as its sidebar panel, and that is the merge rather than
               * an inconsistency. Daily notes used to be a sidebar list, and a
               * sidebar column can show which days you wrote and nothing about
               * what is on them. The planner is the month with its contents, so
               * the icon now means "show me the month" and the sidebar keeps
               * the compact picker beside it.
               */
              if (id === 'calendar') handleViewChange('planner')
            }
          }}
        />

        <div className="vault-sidebar">
          {activeRibbon === 'files' ? (
            <>
              <ExplorerHeader
                onNewNote={() => void handleNewNote()}
                onNewFolder={() => setNewFolderOpen(true)}
                onCollapse={handleCollapseAll}
                onExpand={handleExpandAll}
                sort={sort}
                onSortChange={setSort}
              />
              <FolderTree
                root={sortedTree}
                onSelectNote={openNote}
                expanded={expanded}
                onToggle={handleToggleFolder}
              />
            </>
          ) : activeRibbon === 'bookmarks' ? (
            /* Reads and writes Obsidian's own .obsidian/bookmarks.json, so this
               is the same list Obsidian shows rather than a second one. */
            <BookmarksView onOpenNote={(path) => void openNote(path)} />
          ) : activeRibbon === 'calendar' ? (
            /* Daily notes. The tree is the source for which days exist, so this
               reads the same data the explorer draws rather than asking again. */
            <DailyNotesView
              tree={vault.tree}
              /**
               * THE VIEW SWITCH IS NOT OPTIONAL HERE, and it became load-bearing
               * the moment this icon started opening the planner.
               *
               * `openNote` loads the note; it does not show it. That was
               * survivable while the ribbon left the main area alone — you were
               * usually already on the editor — but the calendar icon now puts
               * the planner up, so picking a day loaded the note BEHIND the
               * calendar and the click read as doing nothing at all. Same
               * failure the database table and the graph both document, and the
               * same fix.
               *
               * Conditional, because `openNote` resolves false when the open was
               * refused — a declined discard, a conflict dialog — and switching
               * anyway would drag the user off the month they were reading on
               * the strength of a click that did not happen.
               */
              onOpenNote={async (path) => {
                if (await openNote(path)) handleViewChange('editor')
              }}
              onCreated={vault.reload}
            />
          ) : activeRibbon === 'canvas' ? (
            /**
             * TWO SECTIONS, not one, and that is a fix rather than a layout
             * preference.
             *
             * Every other ribbon icon replaces the file tree, which is right for
             * them — bookmarks and daily notes are lists you read on their own.
             * The canvas section is different because a board is something you
             * drag files INTO: notes are draggable out of the tree and become
             * cards where they land. Swapping the tree away the moment you open
             * a board meant the source of that gesture was never on screen at
             * the same time as its target, so the gesture was close to
             * unreachable in normal use.
             *
             * The boards come first because that is what the icon was pressed
             * for; the tree sits under it as the thing you pull from.
             */
            <>
              {/* Reads the boards out of the same tree the explorer draws, so
                  there is one answer to what is in the vault. Opening one goes
                  through `openNote`, which routes .canvas to the Canvas view. */}
              <CanvasList
                tree={vault.tree}
                current={canvasPath}
                onOpen={(path) => void openNote(path)}
                onCreated={vault.reload}
              />
              {/* Named, because two unlabelled trees stacked in one column read
                  as one tree that has gone wrong. */}
              <div className="vault-sidebar-heading">Files</div>
              <FolderTree
                root={sortedTree}
                onSelectNote={openNote}
                expanded={expanded}
                onToggle={handleToggleFolder}
              />
            </>
          ) : activeRibbon === 'terminal' ? (
            /* The first ribbon icon to graduate from a placeholder to a real
               panel. The rest still describe themselves; see SidebarPlaceholder. */
            <TerminalView onClose={() => setActiveRibbon('files')} />
          ) : (
            /* Every non-files ribbon icon used to fall through to nothing, so
               the sidebar went blank while the icon reported itself pressed.
               The `else` is the fix; the panel says which feature the icon is a
               promise of, read from the roadmap. */
            <SidebarPlaceholder view={activeRibbon} label={ribbonLabel(activeRibbon)} />
          )}

          <VaultSwitcher
            name={vaultName}
            onSettings={() => setSettingsOpen(true)}
            onHelp={() => setHelpOpen(true)}
          />
        </div>

        <SidebarResizer targetRef={layoutRef} />

        <div className="vault-main">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={(id) => void handleTabChange(id)}
            onNewTab={handleNewTab}
            onCloseTab={handleCloseTab}
            onCloseOthers={handleCloseOthers}
            onCopyPath={handleCopyPath}
            activePath={selectedNote?.path ?? null}
            split={split}
            onToggleSplit={() => setSplit((s) => !s)}
          />

          {openError && (
            <div className="vault-open-error" role="alert">
              {openError}
              <button onClick={() => setOpenError(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}

          {/* Same slot and the same class as the open error above, deliberately:
              this is the other thing that can be wrong with what the pane is
              showing, and a second banner style would be a second thing to keep
              in sync for no gain. `status` rather than `alert` because it is
              already true when the pane mounts — an assertive live region would
              interrupt a screen reader on every launch. */}
          {rootWarning && (
            <div className="vault-open-error" role="status">
              {rootWarning}
              <button onClick={() => setRootWarning(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}

          {/* One column or two. The wrapper exists in both states so toggling
              split does not remount the canvas that was already there and throw
              away its view mode and whatever it had fetched. */}
          <div className={split ? 'vault-canvas-row vault-canvas-row--split' : 'vault-canvas-row'}>
            {canvasWith(view, handleViewChange)}
            {split ? canvasWith(splitView, setSplitView) : null}
          </div>

          {/* Sibling of the canvas, not a child of it: the credit belongs to
              the artwork layer on `.vault-main`, and the canvas scrolls. */}
          <ArtCredit />
        </div>
      </div>

      <ConflictDialog
        isOpen={conflictOpen}
        diskText={conflictData?.diskText ?? ''}
        bufferText={buffer}
        error={conflictError}
        onKeepBuffer={handleKeepBuffer}
        onKeepDisk={handleKeepDisk}
        onMerge={handleMerge}
      />

      {/* Same level as the conflict dialog, and unmounted when closed so its
          "read settings on open" effect runs on every open. Nothing here can
          discard the edit buffer, so it needs no dirty guard. */}
      {/* `isDirty` is new here, and it is what keeps the comment below true.
          Settings can now switch the vault folder, which reloads the window and
          takes the buffer with it, so the dialog needs the one fact that makes
          that safe to offer. */}
      <SettingsDialog
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        isDirty={isDirty}
      />

      {/* Same treatment as Settings, and for the same reason it is safe: Help
          is read-only text and cannot reach the buffer, so it needs no dirty
          guard. It cannot bypass a conflict either — <ConflictDialog> is a
          showModal() dialog in the top layer, and this one opening under it
          changes nothing about which must be answered first. */}
      <HelpDialog isOpen={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* Replaces `window.prompt`, which throws in Electron. See createFolder. */}
      <NameDialog
        isOpen={newFolderOpen}
        title="New folder"
        label={
          targetFolder()
            ? `Created inside ${targetFolder()}`
            : 'Created at the top of the vault'
        }
        placeholder="Folder name"
        confirmLabel="Create folder"
        validate={folderNameError}
        onSubmit={(name) => void createFolder(name)}
        onCancel={() => setNewFolderOpen(false)}
      />
    </div>
  )
}
