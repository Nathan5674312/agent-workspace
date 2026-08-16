import { useCallback, useEffect, useState } from 'react'
import type {
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
  VaultGraph,
} from '../../../shared/ipc.js'
import { toMeta, type VaultNoteMeta } from '../../../shared/notemeta.js'

export function useVault() {
  const [tree, setTree] = useState<VaultTreeNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
  }, [])

  const readNote = useCallback((path: string): Promise<VaultNoteBody> => {
    return window.api.vault.read(path)
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

  return {
    tree,
    loading,
    error,
    readNote,
    saveNote,
    getGraph,
    getNotes,
    getBacklinks,
  }
}
