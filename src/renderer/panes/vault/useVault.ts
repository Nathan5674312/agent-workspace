import { useCallback, useEffect, useState } from 'react'
import type {
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
  VaultGraph,
} from '../../../shared/ipc.js'
import {
  toMeta,
  parseProposal,
  type VaultNoteMeta,
  type InboxItem,
} from '../../../shared/notemeta.js'

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

  /**
   * Everything waiting in Inbox/, newest last.
   *
   * Built from `tree()` + `read()` rather than the server's own /inbox endpoint,
   * which returns all ten in ONE call. That is the better call and it is not
   * made here for a boring reason: it needs a new IPC channel, and `CH` lives
   * in shared/ipc.ts, which currently holds another agent's uncommitted work.
   * Ten reads is affordable; taking their file is not. Swap this for /inbox
   * once that lands.
   */
  const getInbox = useCallback(async (): Promise<InboxItem[]> => {
    const t = await window.api.vault.tree()
    const dir = t.children?.find((c) => c.kind === 'folder' && c.name === 'Inbox')
    const files = (dir?.children ?? []).filter((c) => c.kind === 'note')
    const bodies = await Promise.all(
      // One unreadable capture must not blank the whole queue.
      files.map((f) => window.api.vault.read(f.path).catch(() => null)),
    )
    return bodies
      .filter((b): b is VaultNoteBody => b !== null)
      .map((b) => parseProposal(b.path, b.text))
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
    getInbox,
    getBacklinks,
  }
}
