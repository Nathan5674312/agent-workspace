/**
 * Pure helpers for the vault pane. Deliberately free of React and JSX so the
 * test suite can import THIS file (not a copy of it) under `--experimental-
 * strip-types`. Nothing here touches the DOM, the network, or node.
 */
import type { VaultTreeNode } from '../../../shared/ipc.js'

/**
 * Every folder path in the tree, in vault order, root first.
 *
 * The root's path is the empty string and it IS included — an earlier version
 * dropped it behind a truthiness check, which made "expand all" leave the whole
 * tree collapsed because the root was never in the expanded set.
 */
export function collectFolderPaths(node: VaultTreeNode | null): string[] {
  if (!node) return []
  const out: string[] = []
  if (node.kind === 'folder') out.push(node.path)
  for (const child of node.children ?? []) out.push(...collectFolderPaths(child))
  return out
}

/**
 * Wikilink targets in note text, in order of first appearance, deduplicated.
 * Handles `[[Name]]`, `[[Name|alias]]` and `[[Name#heading]]`.
 */
export function parseWikilinks(text: string): string[] {
  const out: string[] = []
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim()
    if (name.length > 0 && !out.includes(name)) out.push(name)
  }
  return out
}

/** Lowercased note basename (no extension) -> vault-relative path. */
export function indexNotesByName(node: VaultTreeNode | null): Map<string, string> {
  const index = new Map<string, string>()
  const walk = (n: VaultTreeNode | null): void => {
    if (!n) return
    if (n.kind === 'note') {
      const base = n.name.replace(/\.md$/i, '').toLowerCase()
      if (!index.has(base)) index.set(base, n.path)
    }
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return index
}

/** Resolve a wikilink target to a vault path. Case-insensitive, like the indexer. */
export function resolveWikilink(
  name: string,
  index: Map<string, string>,
): string | null {
  return index.get(name.trim().replace(/\.md$/i, '').toLowerCase()) ?? null
}

/**
 * Separator used by "Merge both". Distinctive enough to find afterwards and
 * never produced by accident.
 */
export const MERGE_SEPARATOR =
  '\n\n<<<<<<< your version above ======= disk version below >>>>>>>\n\n'

/**
 * Concatenate both sides of a conflict. THE INVARIANT: the result contains both
 * inputs verbatim, so no edit from either side can be dropped. Never trim,
 * normalise, or dedupe here — that is how text gets silently eaten.
 */
export function mergeVersions(buffer: string, disk: string): string {
  return buffer + MERGE_SEPARATOR + disk
}

/** True when the editor buffer differs from the text last read from disk. */
export function isBufferDirty(diskText: string | null, buffer: string): boolean {
  if (diskText === null) return false
  return diskText !== buffer
}
