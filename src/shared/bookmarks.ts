/**
 * Bookmarks, stored in OBSIDIAN'S OWN FILE.
 *
 * `docs/buttons/ribbon-bookmarks.md` says the question is where a bookmark is
 * stored, not what the panel looks like, and warns that Obsidian's Bookmarks
 * plugin already keeps one in `.obsidian/`. It does, and it is ENABLED on this
 * vault (`.obsidian/core-plugins.json` → `"bookmarks": true`); there is simply
 * no `bookmarks.json` yet because nothing has been bookmarked.
 *
 * So this app writes Obsidian's format into Obsidian's path. A bookmark made
 * here shows up in Obsidian, and one made in Obsidian shows up here. The
 * alternative — our own store — would be a second list of favourites over the
 * same vault, which is the duplication that doc exists to prevent.
 *
 * TWO WRITERS, ONE FILE, and the app already has the answer: `save()` carries an
 * mtime lost-update guard, so writing a bookmark against a stale read raises
 * SaveConflict instead of dropping whatever Obsidian added in the meantime. That
 * guard was built for notes and is exactly the right shape here.
 *
 * The remaining honest gap: a RUNNING Obsidian holds its bookmarks in memory and
 * rewrites the file from that copy, so a bookmark added here while Obsidian is
 * open can be overwritten when Obsidian next saves. Nothing this side can do
 * about that; the panel says so rather than pretending otherwise.
 */

/** Where Obsidian keeps them. Hidden from `tree()` by HIDDEN, readable by path. */
export const BOOKMARKS_PATH = '.obsidian/bookmarks.json'

/**
 * One entry, in Obsidian's shape.
 *
 * Obsidian writes five kinds — file, folder, group, search, graph — and this
 * app can only ACT on the first two. The rest are preserved on write and shown
 * as unopenable rather than dropped: silently deleting a user's saved searches
 * because another app did not understand them is the worst thing a shared file
 * format can do.
 */
export type Bookmark = {
  type: 'file' | 'folder' | 'group' | 'search' | 'graph' | string
  ctime?: number
  path?: string
  title?: string
  /** Heading or block within a note, e.g. `#Section`. Obsidian's own field. */
  subpath?: string
  query?: string
  /** `group` nests. Any depth. */
  items?: Bookmark[]
}

/**
 * Parse, tolerantly.
 *
 * A malformed or half-written file must not blank the panel with an exception —
 * this file is written by another program and can be caught mid-write. An empty
 * list is the honest reading of "cannot tell what is in there", and nothing is
 * overwritten until the user acts.
 */
export function parseBookmarks(text: string): Bookmark[] {
  try {
    const raw: unknown = JSON.parse(text)
    if (!raw || typeof raw !== 'object') return []
    const items = (raw as { items?: unknown }).items
    if (!Array.isArray(items)) return []
    return items.filter((i): i is Bookmark => !!i && typeof i === 'object')
  } catch {
    return []
  }
}

/**
 * Serialise back.
 *
 * Two spaces and a trailing newline because that is what Obsidian writes;
 * matching it keeps the file from churning in git every time the two programs
 * take turns.
 */
export function serializeBookmarks(items: Bookmark[]): string {
  return `${JSON.stringify({ items }, null, 2)}\n`
}

/** Every file/folder entry, flattened out of groups, with its group path. */
export function flattenBookmarks(
  items: Bookmark[],
  groupPath: string[] = [],
): { bookmark: Bookmark; group: string }[] {
  const out: { bookmark: Bookmark; group: string }[] = []
  for (const item of items) {
    if (item.type === 'group') {
      out.push(...flattenBookmarks(item.items ?? [], [...groupPath, item.title ?? 'Group']))
      continue
    }
    out.push({ bookmark: item, group: groupPath.join(' / ') })
  }
  return out
}

/** Is this note already bookmarked, at any depth? */
export function isBookmarked(items: Bookmark[], path: string): boolean {
  return flattenBookmarks(items).some(
    (f) => f.bookmark.type === 'file' && f.bookmark.path === path,
  )
}

/**
 * Add a note, at the TOP LEVEL, if it is not already somewhere in the tree.
 *
 * Never inside a group: a group is a filing decision the user made in Obsidian,
 * and dropping a new bookmark into one because it happened to be first would be
 * this app rearranging their shelf.
 */
export function addBookmark(items: Bookmark[], path: string, title?: string): Bookmark[] {
  if (isBookmarked(items, path)) return items
  const entry: Bookmark = { type: 'file', ctime: Date.now(), path }
  // Obsidian omits `title` unless the user renamed the bookmark. Writing the
  // filename into it would make every entry look hand-renamed.
  if (title) entry.title = title
  return [...items, entry]
}

/**
 * Remove a note wherever it sits, including inside groups.
 *
 * Groups left empty by a removal are KEPT. An empty group is still a heading
 * the user made, and deleting it would be tidying up after them in a file they
 * share with another program.
 */
export function removeBookmark(items: Bookmark[], path: string): Bookmark[] {
  return items
    .map((item) =>
      item.type === 'group'
        ? { ...item, items: removeBookmark(item.items ?? [], path) }
        : item,
    )
    .filter((item) => !(item.type === 'file' && item.path === path))
}

/** What to show for an entry. Obsidian's own rule: a renamed title wins. */
export function bookmarkLabel(b: Bookmark): string {
  if (b.title) return b.title
  if (b.type === 'search') return b.query ? `Search: ${b.query}` : 'Search'
  if (b.type === 'graph') return 'Graph'
  if (!b.path) return b.type
  const name = b.path.split('/').pop() ?? b.path
  const base = name.replace(/\.md$/i, '')
  return b.subpath ? `${base} ${b.subpath}` : base
}

/** Can this app open it? Only files and folders resolve to something here. */
export function isOpenable(b: Bookmark): boolean {
  return (b.type === 'file' || b.type === 'folder') && !!b.path
}
