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
import { LeftRibbon } from './LeftRibbon.js'
import { ExplorerHeader } from './ExplorerHeader.js'
import { FolderTree } from './FolderTree.js'
import { VaultSwitcher } from './VaultSwitcher.js'
import { TabBar } from './TabBar.js'
import { MainCanvas } from './MainCanvas.js'
import { ConflictDialog } from './ConflictDialog.js'
import { ArtCredit } from './ArtCredit.js'
import {
  collectFolderPaths,
  indexNotesByName,
  isBufferDirty,
  resolveWikilink,
} from './helpers.js'
import type { VaultNoteBody } from '../../../shared/ipc.js'

export function VaultPane(): React.ReactElement {
  const vault = useVault()
  const [activeRibbon, setActiveRibbon] = useState('files')
  const [selectedNote, setSelectedNote] = useState<VaultNoteBody | null>(null)
  /** The live edit buffer. Never written to disk without an explicit click. */
  const [buffer, setBuffer] = useState('')
  const [backlinks, setBacklinks] = useState<string[]>([])
  const [tabs, setTabs] = useState([{ id: 'default', name: 'Universal Vault' }])
  const [activeTabId, setActiveTabId] = useState('default')
  const [conflictOpen, setConflictOpen] = useState(false)
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
  const loadNote = async (path: string): Promise<boolean> => {
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
      return true
    } catch (e) {
      setOpenError(
        `Could not open ${path}: ${e instanceof Error ? e.message : String(e)}`,
      )
      return false
    }
  }

  const openNote = async (path: string) => {
    if (!(await loadNote(path))) return
    // Browser semantics: opening from the tree truncates any forward history.
    // Trail and cursor move together, both read from the same `n`.
    setNav((n) => ({
      trail: [...n.trail.slice(0, n.index + 1), path],
      index: n.index + 1,
    }))
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

  const handleNewNote = () => {
    // ponytail: the IPC contract exposes no create call, so this stays a stub.
    console.log('New note')
  }

  const handleNewFolder = () => {
    // ponytail: the IPC contract exposes no create call, so this stays a stub.
    console.log('New folder')
  }

  const handleNewTab = () => {
    const newId = `tab-${Date.now()}`
    setTabs([...tabs, { id: newId, name: 'New tab' }])
    setActiveTabId(newId)
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

  return (
    <div className="vault-pane">
      <div className="vault-layout">
        <LeftRibbon activeView={activeRibbon} onViewChange={setActiveRibbon} />

        <div className="vault-sidebar">
          {activeRibbon === 'files' && (
            <>
              <ExplorerHeader
                onNewNote={handleNewNote}
                onNewFolder={handleNewFolder}
                onCollapse={handleCollapseAll}
                onExpand={handleExpandAll}
              />
              <FolderTree
                root={vault.tree}
                onSelectNote={openNote}
                expanded={expanded}
                onToggle={handleToggleFolder}
              />
            </>
          )}

          <VaultSwitcher
            onSettings={() => console.log('Settings')}
            onHelp={() => console.log('Help')}
          />
        </div>

        <div className="vault-main">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabChange={setActiveTabId}
            onNewTab={handleNewTab}
          />

          {openError && (
            <div className="vault-open-error" role="alert">
              {openError}
              <button onClick={() => setOpenError(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}

          <MainCanvas
            note={selectedNote}
            text={buffer}
            onTextChange={setBuffer}
            isDirty={isDirty}
            onSave={handleSave}
            onConflict={handleConflict}
            getGraph={vault.getGraph}
            backlinks={backlinks}
            onBack={goBack}
            onForward={goForward}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onOpenNote={openNote}
            onOpenWikilink={handleOpenWikilink}
            discarded={discarded}
          />

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
    </div>
  )
}
