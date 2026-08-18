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
 * Explorer sort order. Two axes, four combinations, no duplicate outcome —
 * which is the whole reason the kind and the direction are both in the value.
 * "Folders first" with a name direction already IS "Name (A→Z)", so shipping
 * both as separate options would put a choice on the menu that changes nothing,
 * the exact defect this control is being fixed for.
 *
 * `folders-asc` is what the main process already returns (src/main/vault.ts
 * `sort`), so it is the default and the app looks identical until touched.
 */
export type TreeSort = 'folders-asc' | 'folders-desc' | 'files-asc' | 'files-desc'

/**
 * A re-sorted COPY of the tree. Never mutates its argument.
 *
 * `Array.prototype.sort` sorts in place, and this tree is React state shared
 * with the wikilink index, expand-all, and everything else in the pane — sorting
 * it where it lies would reorder those behind their backs and skip the render.
 *
 * `localeCompare`, not `<`: the vault has non-ASCII note names and a codepoint
 * comparison files them wrongly. Kept identical to the main process comparator
 * so the default mode reproduces the server order exactly.
 */
export function sortTree(
  node: VaultTreeNode | null,
  mode: TreeSort,
): VaultTreeNode | null {
  if (!node) return null
  if (!node.children) return node
  const foldersFirst = mode.startsWith('folders')
  const direction = mode.endsWith('asc') ? 1 : -1
  const children = node.children
    .map((child) => sortTree(child, mode) as VaultTreeNode)
    .sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : (a.kind === 'folder') === foldersFirst ? -1 : 1) ||
        direction * a.name.localeCompare(b.name),
    )
  return { ...node, children }
}

/**
 * Is this one folder name, rather than a path wearing the costume of one?
 *
 * "+ Folder" prompts for a NAME and joins it to the open note's folder, so a
 * separator in it silently makes a path: with `Notes/Untitled.md` open,
 * `../Escaped` joined to `Notes` and resolved to `Escaped` at the vault root.
 * Nothing escaped the vault — `resolveInVault` in the main process is what
 * guarantees that and still does — but the control created a folder somewhere
 * the user did not point at, which is its own kind of lying about what it does.
 *
 * NOT a containment check and no substitute for one. That check is in main,
 * where a renderer cannot skip it. This is about the promise the prompt makes.
 */
export function isPlainName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return false
  // Backslash as well as forward slash: this runs on Windows, where a user
  // types the separator they see in File Explorer.
  return !/[/\\]/.test(trimmed)
}

/** The folder a vault path sits in. `''` for a note at the vault root. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * The first free `Untitled.md`, `Untitled 1.md`, … in `folder`.
 *
 * Checked against the tree the renderer already holds rather than asking the
 * main process, and compared case-INSENSITIVELY: this vault lives on NTFS,
 * where `untitled.md` and `Untitled.md` are the same file, so a case-sensitive
 * check would hand back a path that `save()` then writes straight over an
 * existing note. The tree is a snapshot, so this is a collision-avoider and not
 * a lock — the only real guarantee against clobbering is save()'s own mtime
 * guard, which is why the caller sends mtime 0 and lets a genuine race lose.
 */
export function nextUntitledPath(
  root: VaultTreeNode | null,
  folder: string,
): string {
  const taken = new Set<string>()
  const walk = (n: VaultTreeNode | null): void => {
    if (!n) return
    if (n.kind === 'note') taken.add(n.path.toLowerCase())
    for (const child of n.children ?? []) walk(child)
  }
  walk(root)
  for (let i = 0; ; i++) {
    const name = i === 0 ? 'Untitled.md' : `Untitled ${i}.md`
    const path = folder ? `${folder}/${name}` : name
    if (!taken.has(path.toLowerCase())) return path
  }
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
