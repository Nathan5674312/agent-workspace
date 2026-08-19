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
import { useEffect, useMemo, useState } from 'react'
import { useVault } from './useVault.js'
import { LeftRibbon, ribbonLabel } from './LeftRibbon.js'
import { SidebarPlaceholder } from './SidebarPlaceholder.js'
import { TerminalView } from './TerminalView.js'
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
}
import { ConflictDialog } from './ConflictDialog.js'
import { SettingsDialog } from './SettingsDialog.js'
import { HelpDialog } from './HelpDialog.js'
import { ArtCredit } from './ArtCredit.js'
import {
  collectFolderPaths,
  folderOf,
  indexNotesByName,
  isBufferDirty,
  isPlainName,
  nextUntitledPath,
  resolveWikilink,
  sortTree,
  type TreeSort,
} from './helpers.js'
import type { VaultNoteBody } from '../../../shared/ipc.js'
import './split.css'

export function VaultPane(): React.ReactElement {
  const vault = useVault()
  const [activeRibbon, setActiveRibbon] = useState('files')
  const [selectedNote, setSelectedNote] = useState<VaultNoteBody | null>(null)
  /** The live edit buffer. Never written to disk without an explicit click. */
  const [buffer, setBuffer] = useState('')
  const [backlinks, setBacklinks] = useState<string[]>([])
  const [tabs, setTabs] = useState<VaultTab[]>([
    { id: 'default', name: 'Universal Vault', path: null, view: 'editor' },
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
   * The primary canvas's view IS the active tab's view. Derived, not mirrored:
   * a second copy in state would drift the moment a tab switch raced a view
   * click, and there is no state here that the tabs array does not already hold.
   */
  const view: MainView = tabs.find((t) => t.id === activeTabId)?.view ?? 'editor'

  const handleViewChange = (next: MainView) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === activeTabId
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
  const [conflictOpen, setConflictOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
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
    if (!(await loadNote(path, tabId))) return false
    // Browser semantics: opening from the tree truncates any forward history.
    // Trail and cursor move together, both read from the same `n`.
    setNav((n) => ({
      trail: [...n.trail.slice(0, n.index + 1), path],
      index: n.index + 1,
    }))
    return true
  }

  const goBack = async () => {
    if (!canGoBack) return
    if (await loadNote(nav.trail[nav.index - 1])) {
      setNav((n) => ({ ...n, index: n.index - 1 }))
    }
  }

  const goForward = async () => {
    if (!canGoForward) return
    if (await loadNote(nav.trail[nav.index + 1])) {
      setNav((n) => ({ ...n, index: n.index + 1 }))
    }
  }

  const handleOpenWikilink = (name: string) => {
    const path = resolveWikilink(name, noteIndex)
    if (path) void openNote(path)
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
   * `window.prompt` rather than a dialog: this file already asks with
   * `window.confirm` on every dirty-buffer guard, so a native prompt is an
   * established idiom here and not a new one. Cancel returns null, which is a
   * decision and not an error — nothing is created and nothing is said.
   *
   * CONTAINMENT is not checked here and must not be: the name crosses IPC from
   * a renderer that is untrusted by design, so that check lives in
   * `vault.mkdir` where no caller can skip it, and its refusal lands in the
   * banner below.
   *
   * What IS checked here is a different thing — that the input is a NAME. The
   * prompt asks for one, and a name with a separator in it quietly becomes a
   * path: typed while `Notes/Untitled.md` was open, `../Escaped` joined to
   * `Notes` and resolved to `Escaped` at the vault ROOT. Containment held, so
   * main was right to allow it; it is this control that promised something
   * narrower than it delivered. Found by driving the real app, not by reading.
   */
  const handleNewFolder = async () => {
    const typed = window.prompt('New folder name')
    if (typed === null) return
    const name = typed.trim()
    // Nothing typed is a decision, not an error. Saying nothing is the answer.
    if (!name) return
    if (!isPlainName(name)) {
      setOpenError(
        `"${name}" is a path, not a folder name. New folders are created beside the open note; type a plain name.`,
      )
      return
    }
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
      getGraph={vault.getGraph}
      getNotes={vault.getNotes}
      getInbox={vault.getInbox}
      backlinks={backlinks}
      onBack={goBack}
      onForward={goForward}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onOpenNote={openNote}
      onOpenWikilink={handleOpenWikilink}
      discarded={discarded}
      view={v}
      onViewChange={onChange}
    />
  )

  return (
    <div className="vault-pane">
      <div className="vault-layout">
        <LeftRibbon activeView={activeRibbon} onViewChange={setActiveRibbon} />

        <div className="vault-sidebar">
          {activeRibbon === 'files' ? (
            <>
              <ExplorerHeader
                onNewNote={() => void handleNewNote()}
                onNewFolder={() => void handleNewFolder()}
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
            onSettings={() => setSettingsOpen(true)}
            onHelp={() => setHelpOpen(true)}
          />
        </div>

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
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Same treatment as Settings, and for the same reason it is safe: Help
          is read-only text and cannot reach the buffer, so it needs no dirty
          guard. It cannot bypass a conflict either — <ConflictDialog> is a
          showModal() dialog in the top layer, and this one opening under it
          changes nothing about which must be answered first. */}
      <HelpDialog isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}
