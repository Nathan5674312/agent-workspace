import { useCallback, useEffect, useState } from 'react'
import type {
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
  VaultGraph,
} from '../../../shared/ipc.js'

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
    getBacklinks,
  }
}
