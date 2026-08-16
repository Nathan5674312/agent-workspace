/**
 * Vault data layer.
 *
 * READS come off disk, here in the main process. `tree()`, `list()` and
 * `graph()` open no socket and need nothing running — the vault is a directory
 * of markdown and every question those three answer is answerable by reading
 * it. That was not always true: they used to be HTTP calls to
 * note-system/app/server.py on 127.0.0.1:8765, so the database and graph views
 * failed with `VaultUnavailable` whenever that separate process was not up.
 * It has since been retired.
 *
 * WRITES still go to that server (`read()` and `save()` below), which owns
 * atomic writes, backups, the lost-update guard and the no-silent-overwrite
 * rule. Reimplementing those in Node would reintroduce bugs fixed on
 * 2026-08-08, and `save()`'s guard compares a NANOSECOND mtime that does not
 * survive a round trip through a JS number — so the read that supplies it stays
 * on the same side of the wire as the write that checks it.
 *
 * These calls run in the MAIN process only. The renderer has no network access
 * and no filesystem access.
 */
import type {
  VaultGraph,
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
} from '../shared/ipc.js'
import { parseWikilinks } from '../shared/wikilink.ts'
import { parseFrontmatter, type VaultNoteMeta } from '../shared/notemeta.ts'

let BASE = 'http://127.0.0.1:8765'

/**
 * The vault root on disk, used ONLY for reading the folder structure. Every
 * write still goes through the server, which owns the atomic-write and
 * lost-update machinery. Kept overridable so tests can point at a scratch dir.
 */
let VAULT_DIR =
  process.env.AGENT_WORKSPACE_VAULT_DIR ||
  'C:\\Users\\Nathan\\Desktop\\Universal Vault'

/** For tests only: override the vault directory used by `tree()`. */
export function _setVaultDirForTest(dir: string) {
  VAULT_DIR = dir
  // A different directory is a different vault, so the index cannot survive the
  // switch. This mattered less when the index came from the server and only the
  // explorer read this variable; now `list()` and `graph()` are built from THIS
  // directory, and a memo held across the change describes the old one.
  invalidateGraph()
}

/**
 * The same setter under a production name, for the persisted `vaultDir` setting
 * (src/main/settings.ts). It is an alias rather than a second variable because
 * there is exactly one vault root and two of them would drift.
 *
 * Only safe to call BEFORE anything reads the vault — at boot, from
 * applySettings(). Changing it later leaves the graph memo, the open buffer and
 * every path in the renderer's nav trail pointing at the old vault, which is
 * why the settings modal applies a change on restart instead.
 */
export { _setVaultDirForTest as setVaultDir }

/** The vault root currently in use. Read by the settings modal. */
export function getVaultDir(): string {
  return VAULT_DIR
}

/** For tests only: override the vault base URL. */
export function _setBaseForTest(url: string) {
  BASE = url
  // A different server is a different vault, so the memo cannot survive the
  // switch. Without this the suite's later graph() cases returned the FIRST
  // fixture's result in 0.08ms and passed without exercising anything.
  invalidateGraph()
}

export class VaultUnavailable extends Error {
  constructor() {
    super('Vault server is not running on 127.0.0.1:8765.')
    this.name = 'VaultUnavailable'
  }
}

export class SaveConflict extends Error {
  // Declared and assigned explicitly rather than as a TS parameter property, so
  // this module can be imported directly by `node --test` under type stripping.
  // That is what lets the suite exercise THIS file instead of a copy of it.
  currentMtime: number
  constructor(currentMtime: number) {
    super('Note changed on disk since you opened it.')
    this.name = 'SaveConflict'
    this.currentMtime = currentMtime
  }
}

/**
 * The server builds its error strings from Python exceptions, and OSError /
 * FileExistsError stringify with the ABSOLUTE path they failed on. Those strings
 * are forwarded to the renderer, which is untrusted, so the vault's location on
 * disk (and with it the OS username) would cross the boundary on every missing
 * note. Keep the sentence, drop the path.
 */
function scrub(message: string): string {
  return (
    message
      // Runs to a quote or newline, NOT to the first space. The class used to be
      // `[^\s'"]*`, and the real vault path contains a space ("Universal
      // Vault") — so `...\Desktop\Universal Vault\x.md` scrubbed to
      // `<path> Vault<path>`, leaking the fragment it exists to hide.
      .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^'"\n]*/g, '<path>')
      // POSIX absolute paths were not redacted at all. The server is Python on
      // Windows today, but it stringifies whatever the OS hands it, and one
      // day that is a WSL or container path. Two segments minimum, so this
      // cannot eat `/notes` or `/note?path=…` out of our own error strings.
      .replace(/\/(?:[^/\s'"\n]+\/)+[^/\s'"\n]*/g, '<path>')
  )
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // One signal for the whole exchange, kept so the body-read failure below can
  // tell "server hung up mid-response" from "server sent something unreadable".
  const signal = AbortSignal.timeout(15_000)
  let res: Response
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal,
    })
  } catch {
    throw new VaultUnavailable()
  }

  // A body that will not parse used to become `{}` and, on a 2xx, was returned
  // as if it were the real payload — so a truncated or non-JSON response
  // surfaced downstream as `undefined.split(...)`, blaming the wrong line.
  let body: unknown = {}
  let parsed = true
  try {
    body = await res.json()
  } catch {
    if (signal.aborted) throw new VaultUnavailable()
    parsed = false
  }
  const o = (body ?? {}) as Record<string, unknown>

  if (res.status === 409 && typeof o.mtime === 'number') {
    throw new SaveConflict(o.mtime)
  }
  if (!res.ok) throw new Error(scrub(String(o.error ?? `${res.status} ${path}`)))
  if (!parsed) throw new Error(`vault: unreadable response from ${path}`)
  return body as T
}

function requirePath(path: unknown): string {
  if (typeof path !== 'string' || path === '') {
    throw new Error('vault: path must be a non-empty string')
  }
  return path
}

/**
 * The lost-update guard's fail-open edge, closed here.
 *
 * server.py:703 runs the guard only when the request carries a non-null mtime:
 *
 *     if p.exists() and data.get("mtime") is not None:
 *
 * so a body with no `mtime` key, or `mtime: null`, skips the check entirely and
 * atomic_write overwrites the note whole-file. Three renderer-supplied values
 * produce exactly that, because JSON.stringify erases them:
 *
 *     undefined -> key dropped   -> None -> guard SKIPPED -> clobber
 *     NaN       -> "mtime":null  -> None -> guard SKIPPED -> clobber
 *     null      -> "mtime":null  -> None -> guard SKIPPED -> clobber
 *
 * A writer that sends nothing was trusted more than one that sends something
 * stale. The `mtime: number` annotations on this function and on the IPC
 * handler are erased at runtime, so they stopped none of it — the renderer is
 * untrusted and its arguments arrive as whatever it chose to send.
 *
 * 0 is deliberately still accepted: it survives JSON.stringify, the server's
 * guard runs, and `int(0) != st_mtime_ns` rejects the save. Noisy, never lossy.
 */
function requireMtime(mtime: unknown): number {
  if (typeof mtime !== 'number' || !Number.isFinite(mtime)) {
    throw new Error('vault: mtime must be a finite number')
  }
  return mtime
}

const titleOf = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '')

/**
 * Every note in the vault, with its frontmatter and its reachability.
 *
 * Served from the index memo below, so the database view and the graph view
 * share one scan of the disk instead of taking one each.
 *
 * TRAP for the next caller, unchanged from when this came off the wire: `mtime`
 * is always 0 here. A row from this function is fine to open or to draw, but
 * its mtime is NOT a version — feeding it to save() 409s every time. Call
 * read() first. Left as 0 rather than made optional because `VaultNote.mtime`
 * is `number` in the shared contract.
 */
export async function list(): Promise<VaultNoteMeta[]> {
  return (await index()).notes
}

/**
 * Startup sanity check on the vault root.
 *
 * This used to compare TWO roots — VAULT_DIR against the note server's own —
 * because reads went over HTTP to a process with its own idea of where the
 * vault was, and when they diverged the explorer listed notes that `read()`
 * then 400d on. There is one root now, so that comparison is a tautology and
 * has been dropped.
 *
 * What is still worth checking at boot is the root itself. `AGENT_WORKSPACE_VAULT_DIR`
 * and the persisted `vaultDir` setting both point this anywhere, and a wrong
 * value fails silently and expensively: the explorer renders an empty tree, the
 * database renders zero rows, and nothing says why. An empty directory is a far
 * more likely misconfiguration than a corrupt one.
 *
 * Returns null when the root looks like a vault. The message carries VAULT_DIR
 * unscrubbed — the whole point is to name the wrong directory, and this string
 * is for the main-process console, not the renderer. Do not forward it over IPC
 * without scrub().
 */
export async function checkRoots(): Promise<string | null> {
  const { stat } = await import('node:fs/promises')

  const dir = await stat(VAULT_DIR).catch(() => null)
  if (!dir || !dir.isDirectory()) {
    return (
      `vault: ${VAULT_DIR} is not a readable directory. ` +
      `The explorer, the database and the graph will all be empty. ` +
      `Set AGENT_WORKSPACE_VAULT_DIR or fix the vault path in settings.`
    )
  }

  // Non-empty is the real signal, and it costs one scan that the first view to
  // load would have paid for anyway — the memo makes this free rather than
  // duplicated work.
  const notes = await list().catch((): VaultNoteMeta[] => [])
  if (notes.length > 0) return null

  return (
    `vault: no notes found under ${VAULT_DIR}. ` +
    `The directory exists but contains no indexable .md files, so the database ` +
    `and graph will render empty. Check the vault path in settings.`
  )
}

export async function read(path: string): Promise<VaultNoteBody> {
  // requirePath was defined and then never called by anything — a guard that
  // looked like it was protecting these two entry points and was not. tsc
  // flagged it as unused, which broke `npm run build` (`tsc --noEmit &&
  // electron-vite build`). Wired in rather than deleted: `path` arrives over
  // IPC from the renderer, and an empty or non-string value here builds a
  // nonsense URL that fails deep in the server with a confusing error instead
  // of a clear one at the boundary.
  const o = await req<{ path: string; text: string; mtime: number }>(
    `/note?path=${encodeURIComponent(requirePath(path))}`,
  )
  return { path: o.path, text: o.text, mtime: o.mtime, title: titleOf(o.path) }
}

export async function save(
  path: string,
  text: string,
  mtime: number,
): Promise<VaultNote> {
  const safePath = requirePath(path)
  const safeMtime = requireMtime(mtime)
  const o = await req<{ ok: boolean; mtime: number }>('/save', {
    method: 'POST',
    body: JSON.stringify({ path: safePath, text, mtime: safeMtime }),
  })
  // Our own write is the one staleness source we can react to instantly.
  invalidateGraph()
  return { path: safePath, title: titleOf(safePath), mtime: o.mtime }
}

/**
 * Directories never shown in the explorer. `.obsidian` and `.git` are machine
 * state, not content; `graphify-out` is a generated index. Everything here is
 * excluded for being NOT-CONTENT — never to hide a folder the user owns.
 */
const HIDDEN = new Set(['.git', '.obsidian', '.trash', 'node_modules', '__pycache__'])

/**
 * Folder tree, read from the actual vault directory.
 *
 * It used to be derived from `/notes`, which is the wrong source: that endpoint
 * is a curated NOTE INDEX for the filing product, not a file listing. It
 * explicitly skips `Inbox/`, parses frontmatter, and applies orphan logic — so
 * the explorer silently lost real folders (Inbox, Templates, _Raw Media) and
 * would have kept drifting as that endpoint's product rules changed.
 *
 * Reading the directory here does not reintroduce the risk that put writes
 * behind the Python server: that was about atomic writes, backups and the
 * lost-update guard. A directory listing has none of those hazards, and writes
 * still go through the server untouched.
 */
export async function tree(): Promise<VaultTreeNode> {
  const { readdir, realpath, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')

  /**
   * Real paths of directories already walked, so a link that points at an
   * ancestor terminates instead of recursing until the stack gives out. This is
   * the cost of following links at all, and it has to be paid before following
   * them, not after someone reports a hang.
   */
  const visited = new Set<string>()

  async function walk(abs: string, rel: string): Promise<VaultTreeNode[]> {
    const real = await realpath(abs).catch(() => abs)
    if (visited.has(real)) return [] // cycle
    visited.add(real)

    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return [] // unreadable directory: show nothing rather than fail the tree
    }
    const out: VaultTreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || HIDDEN.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childAbs = join(abs, e.name)

      /**
       * `readdir` reports a Windows junction or symlink as a LINK, not as a
       * directory — so `e.isDirectory()` was false for both, and linked folders
       * were neither recursed into nor listed. They simply were not in the
       * explorer, with no error, while the server happily read and wrote notes
       * inside them. Junctions into this vault are a documented convention on
       * this machine, so that is content silently disappearing.
       *
       * `stat` follows the link where `readdir`'s Dirent does not. A broken
       * link stats as an error and is skipped.
       */
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        const target = await stat(childAbs).catch(() => null)
        if (!target) continue
        isDir = target.isDirectory()
        isFile = target.isFile()
      }

      if (isDir) {
        out.push({
          name: e.name,
          path: childRel,
          kind: 'folder',
          children: await walk(childAbs, childRel),
        })
      } else if (isFile && e.name.toLowerCase().endsWith('.md')) {
        out.push({ name: e.name, path: childRel, kind: 'note' })
      }
    }
    return out
  }

  const root: VaultTreeNode = {
    name: 'Universal Vault',
    path: '',
    kind: 'folder',
    children: await walk(VAULT_DIR, ''),
  }
  sort(root)
  return root
}

function sort(node: VaultTreeNode): void {
  if (!node.children) return
  node.children.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
      a.name.localeCompare(b.name),
  )
  node.children.forEach(sort)
}

/**
 * Path prefixes that are files but not NOTES, excluded from the database and
 * the graph. Ported from the note server's `links.py` SKIP, which is where
 * these were tuned: third-party skill bundles and generated indexes ran to
 * thousands of documents and swamped both views.
 *
 * Deliberately NOT the same list as HIDDEN above. HIDDEN hides things from the
 * EXPLORER; this hides them from the INDEX. `Templates/` is the case that shows
 * why they must stay separate — the explorer still lists it, because a person
 * browsing wants to open a template, while the database counting it as a note
 * would file every template shape as content.
 *
 * `Inbox/` is here for the reason it was in the server's note_list(): those are
 * pending captures, unfiled by definition, and every one of them would read as
 * an orphan. The Inbox tab reads them directly and is unaffected.
 *
 * Trailing slashes are load-bearing: `links.py` matched the bare prefix
 * "Templates", which also swallowed any real note whose name merely started
 * with it.
 */
const SKIP = [
  'graphify-out/',
  'System/Skills/gstack/',
  'System/Skills/skill-router/',
  'System/Skill Sources/',
  'Templates/',
  '.backups/',
  'Inbox/',
]

/** Where reachability is measured from. `depth` is hops from here. */
const ROOT_NOTE = 'Home.md'

/**
 * Memoised index: one disk scan behind both `list()` and `graph()`.
 *
 * They are built together because they need the same thing — the text of every
 * note — and computing them separately means reading the whole vault twice.
 * `depth`/`orphan` additionally cannot be computed without the graph, which is
 * why the server sent them down with the note list rather than as a third call.
 *
 * `inflight` is not an optimisation, it is correctness under overlap: opening a
 * note while the graph tab loads used to start two full rescans. Concurrent
 * callers share one.
 *
 * The TTL keeps this honest as a CACHE rather than a second source of truth —
 * edits made outside the app show up within 30s, and our own writes invalidate
 * immediately.
 */
const INDEX_TTL_MS = 30_000
type VaultIndex = { notes: VaultNoteMeta[]; graph: VaultGraph }
let indexCache: { at: number; value: VaultIndex } | null = null
let indexInflight: Promise<VaultIndex> | null = null

/** Drop the memo. Called by save(); exported so a future watcher can call it. */
export function invalidateGraph(): void {
  indexCache = null
}

async function index(): Promise<VaultIndex> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.value
  if (indexInflight) return indexInflight
  indexInflight = buildIndex().finally(() => {
    indexInflight = null
  })
  return indexInflight
}

/**
 * Graph edges from [[wikilinks]]. This is a CACHE, per the project's own rule:
 * the projection must be deletable and rebuildable from the files, never
 * authoritative. Nothing here writes anything.
 */
export async function graph(): Promise<VaultGraph> {
  return (await index()).graph
}

/**
 * Every indexed note with its text, read off disk.
 *
 * Reuses `tree()` for the walk rather than globbing again — that function
 * already handles the two things a naive `readdir` recursion gets wrong on this
 * machine: Windows junctions (which `readdir` reports as links, not
 * directories, so linked folders vanish) and the link cycles that follow from
 * supporting them.
 */
async function scan(): Promise<{ note: VaultNoteMeta; text: string }[]> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const paths: string[] = []
  const collect = (n: VaultTreeNode): void => {
    if (n.kind === 'note') paths.push(n.path)
    n.children?.forEach(collect)
  }
  collect(await tree())
  const keep = paths.filter((p) => !SKIP.some((s) => p.startsWith(s)))

  const out: { note: VaultNoteMeta; text: string }[] = []
  // Bounded rather than `Promise.all` over every path: a vault in the low
  // thousands opens that many file handles at once and takes EMFILE, which
  // fails the whole index instead of one note. Same worker-pool shape the HTTP
  // version needed, for a different reason.
  const LIMIT = 16
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < keep.length) {
      const path = keep[cursor++]
      let text: string
      try {
        text = await readFile(join(VAULT_DIR, path), 'utf8')
      } catch {
        // Deleted between the walk and the read, or unreadable. Absent from the
        // index is right; failing the index for one bad file is not.
        continue
      }
      const fm = parseFrontmatter(text)
      const cut = path.lastIndexOf('/')
      out.push({
        text,
        note: {
          path,
          // Filename first, frontmatter second — the same precedence the link
          // resolver below uses, so a note cannot be titled one thing in the
          // database and another in the graph.
          title: fm.title || titleOf(path),
          folder: cut === -1 ? '(root)' : path.slice(0, cut),
          type: fm.type ?? '',
          status: fm.status ?? '',
          updated: fm.updated ?? '',
          depth: null, // filled by the BFS in buildIndex
          orphan: false,
          mtime: 0, // see the TRAP note on list()
        },
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(LIMIT, keep.length) }, worker))

  // The workers finish out of order, so the array order is nondeterministic.
  // Sorted here, once, on the server's own key — the database view renders in
  // this order and a table that reshuffles between loads is unreadable.
  out.sort(
    (a, b) =>
      a.note.folder.localeCompare(b.note.folder) ||
      a.note.title.toLowerCase().localeCompare(b.note.title.toLowerCase()),
  )
  return out
}

async function buildIndex(): Promise<VaultIndex> {
  const scanned = await scan()
  const notes = scanned.map((s) => s.note)

  /**
   * Wikilink resolution index, built the way Obsidian actually resolves.
   *
   * This was keyed ONLY on `note.title` — and the server derives that from
   * frontmatter (`server.py:433`: `(fm or {}).get("title") or n["stem"]`),
   * while a wikilink names the FILE. So every note whose frontmatter title
   * differed from its filename resolved nothing, and its links vanished. That
   * is what left so many notes floating unconnected.
   *
   * Obsidian accepts a link by filename, by path, with or without the
   * extension, and with `|alias` or `#heading` suffixes. All of those resolve
   * to the same note, so all of them are indexed.
   *
   * Filename stems are added for EVERY note before any frontmatter title, so
   * that on a collision the filename wins — matching Obsidian, where the file
   * is the identity and frontmatter is metadata.
   */
  const norm = (s: string) =>
    s.trim().toLowerCase().replace(/\\/g, '/').replace(/\.md$/i, '')

  const byName = new Map<string, string>()
  const add = (key: string, path: string) => {
    const k = norm(key)
    if (k && !byName.has(k)) byName.set(k, path)
  }
  for (const n of notes) {
    add(titleOf(n.path), n.path) // "_START HERE"      — the common form
    add(n.path, n.path) // "Business/…/_START HERE.md" — full path
  }
  // Second pass: frontmatter titles are aliases, and must never shadow a real
  // filename that another note owns.
  for (const n of notes) add(n.title, n.path)

  const links: VaultGraph['links'] = []
  // A note that mentions [[Home]] twelve times is ONE relationship. Without
  // this every mention became its own edge: a note repeating a link 20 000
  // times produced 20 000 identical edges, and since GraphView derives node
  // size from endpoint count (`3.4 + sqrt(degree) * 1.45`), the target grew to
  // a ~200px disc and every frame stroked 20 000 coincident lines.
  const seenEdges = new Set<string>()

  // The text is already in hand from the scan — this used to be a bounded pool
  // of GET /note requests, one per note, because the text lived behind HTTP. On
  // an 800-note vault that was 800 round trips through a Python server that
  // serialised every one of them on a module-wide lock, and it ran on every
  // note the user opened. Reading the directory once costs a fraction of it.
  const out = new Map<string, string[]>()
  for (const { note: n, text } of scanned) {
    for (const name of parseWikilinks(text)) {
      const target = byName.get(norm(name))
      if (!target || target === n.path) continue
      // `parseWikilinks` already dedups by NAME within a note; this dedups by
      // resolved TARGET, because [[Home]] and [[Home.md]] name one note.
      // Stringifying the pair sidesteps the separator question entirely.
      const key = JSON.stringify([n.path, target])
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      links.push({ from: n.path, to: target })
      // Adjacency, kept as the edges are found rather than rebuilt from
      // `links` afterwards, because the BFS below needs it and a second pass
      // over 20k edges to recover what we just computed is waste.
      const adj = out.get(n.path)
      if (adj) adj.push(target)
      else out.set(n.path, [target])
    }
  }

  /**
   * R6 reachability: hops from [[Home]], following links outward.
   *
   * Obsidian links are directional but browsing is not — if A links to B a
   * person can get from A to B — so only outbound edges are walked, matching
   * the server's `links.reach()`. `orphan` is the invariant the vault is
   * actually graded on: not reachable from Home within 2 hops.
   */
  const depth = new Map<string, number>([[ROOT_NOTE, 0]])
  const queue = [ROOT_NOTE]
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]
    for (const next of out.get(cur) ?? []) {
      if (depth.has(next)) continue
      depth.set(next, depth.get(cur)! + 1)
      queue.push(next)
    }
  }
  for (const n of notes) {
    const d = depth.get(n.path)
    n.depth = d ?? null
    n.orphan = d === undefined || d > 2
  }

  const value: VaultIndex = { notes, graph: { nodes: notes.map((n) => n.path), links } }
  indexCache = { at: Date.now(), value }
  return value
}

export async function backlinks(path: string): Promise<string[]> {
  const g = await graph()
  return [...new Set(g.links.filter((l) => l.to === path).map((l) => l.from))]
}
