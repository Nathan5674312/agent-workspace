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
   * Whichever side of a conflict the user chose to throw away, kept in memory
   * so a reflex click is recoverable by copy/paste. Cleared only by opening a
   * different note.
   */
  const [discarded, setDiscarded] = useState<{ label: string; text: string } | null>(
    null,
  )
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const isDirty = isBufferDirty(selectedNote?.text ?? null, buffer)

  const noteIndex = useMemo(() => indexNotesByName(vault.tree), [vault.tree])

  // Backlinks for the open note. Cancelled on note change / unmount so a slow
  // response cannot overwrite a newer note's backlinks.
  useEffect(() => {
    if (!selectedNote) {
      setBacklinks([])
      return
    }
    let cancelled = false
    vault
      .getBacklinks(selectedNote.path)
      .then((links) => {
        if (!cancelled) setBacklinks(links)
      })
      .catch(() => {
        if (!cancelled) setBacklinks([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedNote, vault.getBacklinks])

  const openNote = async (path: string) => {
    // An open conflict must be resolved before anything else can move. Closing
    // it implicitly is how the buffer used to vanish.
    if (conflictOpen) return
    if (isDirty) {
      const ok = window.confirm(
        `"${selectedNote?.title ?? 'This note'}" has unsaved edits that will be lost. Discard them and open the other note?`,
      )
      if (!ok) return
    }
    try {
      const note = await vault.readNote(path)
      setSelectedNote(note)
      setBuffer(note.text)
      setDiscarded(null)
    } catch (e) {
      console.error('Failed to read note:', e)
    }
  }

  const handleOpenWikilink = (name: string) => {
    const path = resolveWikilink(name, noteIndex)
    if (path) void openNote(path)
  }

  const handleSave = async (text: string, mtime: number) => {
    if (!selectedNote) return
    const saved = await vault.saveNote(selectedNote.path, text, mtime)
    // Record what is now on disk WITHOUT clobbering the buffer: if the user
    // kept typing while the save was in flight, those keystrokes stay, and the
    // note simply reads as dirty again.
    setSelectedNote({ ...selectedNote, mtime: saved.mtime, text })
  }

  const handleConflict = (diskMtime: number, diskText: string) => {
    setConflictData({ diskMtime, diskText })
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
      console.error('Failed to save buffer:', e)
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
  }

  const handleMerge = async (merged: string) => {
    if (!selectedNote || !conflictData) return
    try {
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
      console.error('Failed to save merged:', e)
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

          <MainCanvas
            note={selectedNote}
            text={buffer}
            onTextChange={setBuffer}
            isDirty={isDirty}
            onSave={handleSave}
            onConflict={handleConflict}
            getGraph={vault.getGraph}
            backlinks={backlinks}
            onOpenNote={openNote}
            onOpenWikilink={handleOpenWikilink}
            discarded={discarded}
          />
        </div>
      </div>

      <ConflictDialog
        isOpen={conflictOpen}
        diskText={conflictData?.diskText ?? ''}
        bufferText={buffer}
        onKeepBuffer={handleKeepBuffer}
        onKeepDisk={handleKeepDisk}
        onMerge={handleMerge}
      />
    </div>
  )
}
