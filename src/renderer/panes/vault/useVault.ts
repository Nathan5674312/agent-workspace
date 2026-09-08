import { useCallback, useEffect, useState } from 'react'
import type {
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
  VaultGraph,
} from '../../../shared/ipc.js'
import { toMeta, type VaultNoteMeta } from '../../../shared/notemeta.js'
import { track } from '../../busy.js'

export function useVault() {
  const [tree, setTree] = useState<VaultTreeNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * Bumped to re-run the tree effect. A counter rather than a bare `reload()`
   * that fetches on the side, so a reload and the mount load share ONE code
   * path and therefore one `cancelled` flag — two fetchers writing `tree` would
   * race, and the loser would put a pre-create tree back on screen after the
   * create had already landed.
   */
  const [reloadCount, setReloadCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        setLoading(true)
        setError(null)
        const t = await window.api.vault.tree()
        if (!cancelled) setTree(t)
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reloadCount])

  /**
   * Re-read the folder tree. Called after a create, which is the only thing in
   * the pane that changes what is IN the vault rather than what is in a note.
   */
  const reload = useCallback(() => setReloadCount((n) => n + 1), [])

  /**
   * Every note open goes through here, which is why the busy counter does too:
   * one wrapper covers the tree, the wikilinks, the nav trail, the database and
   * the graph, because they all call this. The counter is what lights the
   * top-edge glow — see renderer/busy.ts.
   */
  const readNote = useCallback((path: string): Promise<VaultNoteBody> => {
    return track(window.api.vault.read(path))
  }, [])

  const saveNote = useCallback(
    (path: string, text: string, mtime: number): Promise<VaultNote> => {
      return window.api.vault.save(path, text, mtime)
    },
    [],
  )

  const getGraph = useCallback((): Promise<VaultGraph> => {
    return window.api.vault.graph()
  }, [])

  /**
   * Every note with its frontmatter, for the database view.
   *
   * The cast is not a shortcut. `Api.list()` is declared as `VaultNote[]` in
   * shared/ipc.ts and the main process genuinely sends the wider row -- that
   * declaration is the stale half, and it cannot be widened right now without
   * touching a file another agent has uncommitted work in. `toMeta` validates
   * every field on the way through, so nothing downstream trusts the cast.
   */
  const getNotes = useCallback(async (): Promise<VaultNoteMeta[]> => {
    const rows = (await window.api.vault.list()) as unknown[]
    return rows.map(toMeta).filter((n): n is VaultNoteMeta => n !== null)
  }, [])

  const getBacklinks = useCallback((path: string): Promise<string[]> => {
    return window.api.vault.backlinks(path)
  }, [])

  const makeFolder = useCallback((path: string): Promise<void> => {
    return window.api.vault.mkdir(path)
  }, [])

  return {
    tree,
    loading,
    error,
    reload,
    readNote,
    saveNote,
    makeFolder,
    getGraph,
    getNotes,
    getBacklinks,
  }
}
