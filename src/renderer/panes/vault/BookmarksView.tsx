/**
 * Bookmarks — the left ribbon's `bookmarks` icon.
 *
 * Reads and writes `.obsidian/bookmarks.json`, Obsidian's own file in this same
 * vault, so the two programs share one list. See src/shared/bookmarks.ts for
 * why that beats keeping our own.
 *
 * WRITES GO THROUGH THE MTIME GUARD. Every change re-reads the file, applies the
 * edit to what is actually on disk, and saves against the mtime it just read —
 * so a bookmark Obsidian added between our read and our write raises
 * SaveConflict instead of being silently dropped. That is the same guard notes
 * get, used for the reason it exists.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bookmark as BookmarkIcon, Folder, X } from 'lucide-react'
import {
  BOOKMARKS_PATH,
  addBookmark,
  bookmarkLabel,
  flattenBookmarks,
  isBookmarked,
  isOpenable,
  parseBookmarks,
  removeBookmark,
  serializeBookmarks,
  type Bookmark,
} from '../../../shared/bookmarks.js'
import { PaneMenuItem } from './PaneMenu.js'
import { isSaveConflict } from './helpers.js'
import './bookmarks.css'

/**
 * "Bookmark this note" for the note header's ⋯ menu.
 *
 * Self-contained on purpose: it owns its own read of the file rather than
 * taking state from a parent, so adding it cost no plumbing through
 * <MainCanvas> or <VaultPane>. The list is small and this reads it on open,
 * which is also what keeps it correct when Obsidian has changed it since.
 */
export function BookmarkToggleItem({ path, title }: { path: string | null; title: string }) {
  const [bookmarked, setBookmarked] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!path) {
      setBookmarked(null)
      return
    }
    void (async () => {
      const file = await window.api.vault.read(BOOKMARKS_PATH).catch(() => null)
      if (cancelled) return
      setBookmarked(file ? isBookmarked(parseBookmarks(file.text), path) : false)
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  const toggle = async (): Promise<void> => {
    if (!path) return
    try {
      // Read-modify-write against the CURRENT file, saved under the mtime just
      // read, so a concurrent Obsidian write conflicts instead of vanishing.
      const file = await window.api.vault.read(BOOKMARKS_PATH).catch(() => null)
      const current = file ? parseBookmarks(file.text) : []
      const next = isBookmarked(current, path)
        ? removeBookmark(current, path)
        : addBookmark(current, path)
      await window.api.vault.save(
        BOOKMARKS_PATH,
        serializeBookmarks(next),
        // 0 creates the file when Obsidian has never written one.
        file ? file.mtime : 0,
      )
      setBookmarked(isBookmarked(next, path))
      setFailed(false)
    } catch {
      // The menu has nowhere to show a sentence, so the row itself reports it
      // by changing its label — better than a click that appears to do nothing.
      setFailed(true)
    }
  }

  return (
    <PaneMenuItem
      onClick={() => void toggle()}
      disabled={!path}
      reason="No note is open"
    >
      {failed
        ? 'Could not save bookmark'
        : bookmarked
          ? `Remove ${title} from bookmarks`
          : 'Bookmark this note'}
    </PaneMenuItem>
  )
}

export interface BookmarksViewProps {
  onOpenNote: (path: string) => void
}

export function BookmarksView({ onOpenNote }: BookmarksViewProps) {
  const [items, setItems] = useState<Bookmark[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const file = await window.api.vault.read(BOOKMARKS_PATH)
      setItems(parseBookmarks(file.text))
      setError(null)
    } catch {
      // No file yet is the NORMAL state of a vault nobody has bookmarked in.
      // It is not an error and must not be shown as one.
      setItems([])
      setError(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const file = await window.api.vault.read(BOOKMARKS_PATH).catch(() => null)
      if (cancelled) return
      setItems(file ? parseBookmarks(file.text) : [])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const remove = async (path: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      // Re-read rather than trusting the copy on screen: Obsidian may have
      // written since this panel loaded, and the edit belongs to what is on
      // disk now.
      const file = await window.api.vault.read(BOOKMARKS_PATH)
      const next = removeBookmark(parseBookmarks(file.text), path)
      await window.api.vault.save(BOOKMARKS_PATH, serializeBookmarks(next), file.mtime)
      setItems(next)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(
        isSaveConflict(message)
          ? 'Obsidian changed the bookmarks while this was open. Nothing was written — reload and try again.'
          : `Could not update bookmarks: ${message}`,
      )
    } finally {
      setBusy(false)
    }
  }

  if (items === null) {
    return <div className="bookmarks-view bookmarks-empty">Loading bookmarks…</div>
  }

  const flat = flattenBookmarks(items)

  return (
    <div className="bookmarks-view">
      {flat.length === 0 ? (
        <div className="bookmarks-empty">
          <p>No bookmarks yet.</p>
          <p className="bookmarks-hint">
            Bookmark the open note from the ⋯ menu above the editor. These are
            stored in Obsidian&rsquo;s own <code>bookmarks.json</code>, so they
            appear in Obsidian too.
          </p>
        </div>
      ) : (
        <ul className="bookmarks-list">
          {flat.map(({ bookmark, group }, i) => {
            const openable = isOpenable(bookmark) && bookmark.type === 'file'
            return (
              <li key={`${bookmark.path ?? bookmark.type}-${i}`} className="bookmarks-item">
                <button
                  type="button"
                  className="bookmarks-open"
                  onClick={() => bookmark.path && onOpenNote(bookmark.path)}
                  disabled={!openable}
                  title={
                    openable
                      ? bookmark.path
                      : `${bookmark.type} bookmarks are kept but can only be opened in Obsidian`
                  }
                >
                  {bookmark.type === 'folder' ? (
                    <Folder size={13} aria-hidden="true" />
                  ) : (
                    <BookmarkIcon size={13} aria-hidden="true" />
                  )}
                  <span className="bookmarks-label">{bookmarkLabel(bookmark)}</span>
                  {group && <span className="bookmarks-group">{group}</span>}
                </button>
                {bookmark.type === 'file' && bookmark.path && (
                  <button
                    type="button"
                    className="bookmarks-remove"
                    onClick={() => void remove(bookmark.path as string)}
                    disabled={busy}
                    aria-label={`Remove bookmark ${bookmarkLabel(bookmark)}`}
                    title="Remove bookmark"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error && (
        <p className="bookmarks-error" role="alert">
          {error}{' '}
          <button type="button" className="bookmarks-reload" onClick={() => void load()}>
            Reload
          </button>
        </p>
      )}
    </div>
  )
}
