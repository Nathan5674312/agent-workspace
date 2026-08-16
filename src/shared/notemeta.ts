/**
 * The note metadata the database view needs, on top of the minimal `VaultNote`
 * every other consumer uses.
 *
 * WHY THIS IS NOT IN ipc.ts, where it naturally belongs: `VaultNote` is the
 * contract the explorer, the editor and the graph all read, and widening it
 * there is the right change. It is not made here only because `src/shared/ipc.ts`
 * currently carries another agent's uncommitted work, and touching that file
 * means either colliding with it or sweeping it into an unrelated commit. Fold
 * this back into `VaultNote` once that work lands.
 *
 * No new IPC channel exists for this. `vault:list` ALREADY carries these fields
 * -- `server.py`'s /notes has returned `folder`, `type` and `orphan` all along
 * and `vault.ts` was discarding them on the way through. The wire format did not
 * change; only what we admit is on it.
 */
import type { VaultNote } from './ipc.js'

export type VaultNoteMeta = VaultNote & {
  /**
   * Full containing folder, `(root)` for top-level notes. Straight from the
   * server. This is NOT the grouping axis -- see `areaOf`.
   */
  folder: string
  /** `type:` frontmatter, `''` when absent. 190 of 258 notes have none. */
  type: string
  /** `status:` frontmatter, `''` when absent. */
  status: string
  /** `updated:` frontmatter as written, `''` when absent. Never parsed to a Date. */
  updated: string
  /** Hops from Home. `null` means unreachable. */
  depth: number | null
  /** R6: not reachable from Home within 2 hops. Notion has no equivalent. */
  orphan: boolean
}

/** Sentinel for "this note has no value for the field being grouped on". */
export const NONE = '—'

/**
 * The "Area" property, and the one real judgement call in this file.
 *
 * The obvious move is to group by `folder`, and it does not work: the vault has
 * **99 distinct folders**, which is a list, not an axis. The first path segment
 * gives ~10 -- Business, System, Projects, Transcripts, (root) -- which is what
 * a person actually means when they say where a note lives, and it is the
 * honest translation of Obsidian's folder into Notion's Area property.
 */
export function areaOf(n: { folder: string }): string {
  if (!n.folder || n.folder === '(root)') return '(root)'
  const cut = n.folder.indexOf('/')
  return cut === -1 ? n.folder : n.folder.slice(0, cut)
}

/**
 * Normalise one row off the wire.
 *
 * Every field is defended even though the server sends all of them, because the
 * note server is a SEPARATE process on a version this app does not control. An
 * older server (or one mid-restart) simply omits `status` and `updated`, and the
 * table must render a blank cell rather than throw on `undefined.toLowerCase()`.
 */
export function toMeta(raw: unknown): VaultNoteMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const path = str(o.path)
  if (!path) return null
  return {
    path,
    title: str(o.title) || path.split('/').pop()!.replace(/\.md$/i, ''),
    mtime: typeof o.mtime === 'number' ? o.mtime : 0,
    folder: str(o.folder) || '(root)',
    type: str(o.type),
    status: str(o.status),
    updated: str(o.updated),
    depth: typeof o.depth === 'number' ? o.depth : null,
    orphan: o.orphan === true,
  }
}
