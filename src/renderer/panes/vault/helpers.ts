/**
 * Pure helpers for the vault pane. Deliberately free of React and JSX so the
 * test suite can import THIS file (not a copy of it) under `--experimental-
 * strip-types`. Nothing here touches the DOM, the network, or node.
 */
import type { VaultLink, VaultTreeNode } from '../../../shared/ipc.js'

/**
 * Re-exported, not reimplemented. The graph builder in src/main/vault.ts and
 * this pane MUST agree on what a wikilink is — they disagreed before, and the
 * graph drew edges the editor's Links list did not list.
 */
export { parseWikilinks } from '../../../shared/wikilink.ts'

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
 * Normalisation shared by the indexer and the resolver. Must match the one in
 * src/main/vault.ts `graph()`, or a link the graph draws will not open here.
 */
const norm = (s: string) =>
  s.trim().toLowerCase().replace(/\\/g, '/').replace(/\.md$/i, '')

/**
 * Wikilink key -> vault-relative path.
 *
 * Basenames AND full paths, because Obsidian accepts both and the main
 * process's graph index already indexed both — so `[[Business/Playbooks/Launch]]`
 * drew an edge in the graph while clicking the same link in the editor resolved
 * to null and silently did nothing. Basenames are added for every note before
 * any path, so on a collision the short form wins, matching the graph.
 */
export function indexNotesByName(node: VaultTreeNode | null): Map<string, string> {
  const index = new Map<string, string>()
  const notes: VaultTreeNode[] = []
  const walk = (n: VaultTreeNode | null): void => {
    if (!n) return
    if (n.kind === 'note') notes.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)

  const add = (key: string, path: string) => {
    const k = norm(key)
    if (k && !index.has(k)) index.set(k, path)
  }
  for (const n of notes) add(n.name, n.path)
  for (const n of notes) add(n.path, n.path)
  return index
}

/** Resolve a wikilink target to a vault path. Case-insensitive, like the indexer. */
export function resolveWikilink(
  name: string,
  index: Map<string, string>,
): string | null {
  return index.get(norm(name)) ?? null
}

/**
 * The subset of graph edges d3-force can actually resolve, in d3's own shape.
 *
 * d3's `forceLink` THROWS ("node not found: x") on an edge whose endpoint is
 * missing from the node list, synchronously, inside the effect that builds the
 * simulation. With no error boundary above the pane that unmounts the whole
 * React root and takes the unsaved edit buffer with it. The graph is derived,
 * rebuildable, non-authoritative data; a dangling edge is worth one missing
 * line, never the user's text.
 */
export function resolvableLinks(
  nodes: string[],
  links: VaultLink[],
): Array<{ source: string; target: string }> {
  const ids = new Set(nodes)
  return links
    .filter((l) => ids.has(l.from) && ids.has(l.to))
    .map((l) => ({ source: l.from, target: l.to }))
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

/**
 * Did this failed save fail because the note changed on disk?
 *
 * `SaveConflict` is thrown in the main process. Electron rebuilds it on the
 * renderer side from a STRING, so the class, the prototype and `currentMtime`
 * are all gone by the time it lands here — `instanceof` is not available and
 * message matching is the only thing left. Electron currently stringifies with
 * `error.toString()`, which keeps the name; match the sentence as well so a
 * change in how Electron serialises cannot quietly turn every conflict into an
 * unexplained save failure the user can never get past.
 *
 * Kept out of the component so it can be tested against real strings.
 */
export function isSaveConflict(message: string): boolean {
  return (
    message.includes('SaveConflict') ||
    message.includes('changed on disk since you opened it')
  )
}

/** True when the editor buffer differs from the text last read from disk. */
export function isBufferDirty(diskText: string | null, buffer: string): boolean {
  if (diskText === null) return false
  return diskText !== buffer
}
