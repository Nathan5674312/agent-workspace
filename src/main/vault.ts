/**
 * Vault data layer. Talks to the existing local server (note-system/app/server.py)
 * on 127.0.0.1:8765 — it already owns atomic writes, backups, the lost-update
 * guard, path-traversal checks and the no-silent-overwrite rule. Reimplementing
 * any of that in Node would reintroduce bugs that were fixed on 2026-08-08.
 *
 * These calls run in the MAIN process only. The renderer has no network access,
 * and requests from Node carry no Origin header, which is what the server's
 * bad_origin() check expects from a non-browser client.
 */
import type {
  VaultGraph,
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
} from '../shared/ipc.js'
import { parseWikilinks } from '../shared/wikilink.ts'

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

export async function list(): Promise<VaultNote[]> {
  // The server's /notes shape is its own; normalise to VaultNote here so the
  // renderer never sees two spellings of the same thing.
  const raw = await req<unknown>('/notes')
  const rows = Array.isArray(raw) ? raw : []
  return rows.flatMap((r) => {
    // `r as Record<...>` is a compile-time claim, not a runtime one. A `null`
    // element threw "Cannot read properties of null" straight out of list(),
    // which fails list, graph AND backlinks together — one malformed row from
    // the server took out the whole graph. The array check above already
    // treats this response as untrusted; so does this.
    if (typeof r !== 'object' || r === null) return []
    const o = r as Record<string, unknown>
    // Only a string is a path. `String({})` produced "[object Object]" and
    // carried it forward as a real note.
    const path = typeof o.path === 'string' ? o.path : typeof o.rel === 'string' ? o.rel : ''
    if (!path) return []
    return [{
      path,
      title: String(o.title ?? titleOf(path)),
      // TRAP for the next caller: /notes carries no mtime (server.py builds the
      // row without one), so this is always 0. A row from here is fine to open
      // or to draw, but its mtime is NOT a version — feeding it to save() 409s
      // every time. Read the note first. Left as 0 rather than made optional
      // because VaultNote.mtime is `number` in the shared contract, and
      // src/shared/ipc.ts is not this section's to change.
      mtime: Number(o.mtime ?? 0),
    }]
  })
}

/**
 * Startup coherence check for the two vault roots.
 *
 * `tree()` reads the folder structure off disk from VAULT_DIR. Every read and
 * write goes through the server, which has its own root. Nothing made the two
 * agree, so when they diverge the explorer lists notes that `read()` then 400s
 * on — and the failure reads as a broken note rather than a misconfigured root.
 *
 * The server exposes no endpoint for its root (checked: server.py's do_GET
 * serves /, /inbox, /notes and /note only), so this asks the question the one
 * way available — take notes the server says it has and look for them under
 * ours. `/notes` is already implemented as `list()`, so this costs one HTTP
 * call and a few stats.
 *
 * Returns null when the roots agree OR when the question cannot be answered:
 * server down, or an empty index. A missing answer is not a mismatch, and a
 * false alarm here would send someone chasing a config bug that does not exist.
 *
 * The message carries VAULT_DIR unscrubbed. That is deliberate — the whole
 * point is to name the wrong directory, and this string is for the main-process
 * console, not the renderer. Do not forward it over IPC without scrub().
 */
export async function checkRoots(): Promise<string | null> {
  // Only the server being unreachable is swallowed. A malformed index is
  // list()'s problem and it already returns [] for that.
  const notes = await list().catch((): VaultNote[] => [])
  if (notes.length === 0) return null

  const { access } = await import('node:fs/promises')
  const { join } = await import('node:path')

  // Sample rather than test one: a note can legitimately be missing, deleted
  // between the server building its index and this stat, and one stale row must
  // not be reported as two different vaults.
  //
  // Spread the sample across the list instead of taking the first N. A fixed
  // prefix is the SAME notes every boot, so a bulk rename or move of whatever
  // happens to sort first — an index the server has not rebuilt yet — reports
  // "different vaults" deterministically. Striding samples the whole vault, so
  // a stale corner cannot masquerade as a wrong root.
  const WANT = 9
  const step = Math.max(1, Math.floor(notes.length / WANT))
  const sample: VaultNote[] = []
  for (let i = 0; i < notes.length && sample.length < WANT; i += step) sample.push(notes[i])

  let hits = 0
  const misses: string[] = []
  for (const n of sample) {
    const hit = await access(join(VAULT_DIR, n.path)).then(() => true, () => false)
    if (hit) hits++
    else if (misses.length < 2) misses.push(n.path)
  }

  // Majority, not "any one hit". The old rule was that a single surviving file
  // proved the roots agreed, which fails the exact case this function is for:
  // PARTIALLY overlapping roots — the app pointed at a sibling or a parent of
  // the server's vault. One coincidentally shared filename (Home.md, README.md)
  // bought silence while every other note still 400d on open, which is the
  // "broken note, not broken config" confusion the check exists to end.
  if (hits * 2 > sample.length) return null

  return (
    `vault: the note server and this app are pointed at different vaults. ` +
    `Only ${hits} of ${sample.length} notes the server lists exist under ` +
    `${VAULT_DIR} (missing e.g. ${misses.map((m) => `"${m}"`).join(', ')}). ` +
    `The explorer will list notes that fail to open. ` +
    `Fix VAULT in note-system/app/server.py or AGENT_WORKSPACE_VAULT_DIR.`
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
 * Memoised graph.
 *
 * The measurement the old `ponytail:` note asked for: on an 800-note vault a
 * single `backlinks()` call issued 800 GET /note requests, because it rebuilds
 * the whole graph — and the vault pane calls it every time a note is opened.
 * The Python server serialises every request on one module-wide lock, so that
 * is the cost of a click.
 *
 * `inflight` is not an optimisation, it is correctness under overlap: opening a
 * note while the graph tab loads used to start two full rescans that each
 * hammered the same server. Concurrent callers now share one.
 *
 * The TTL is what keeps this honest as a CACHE rather than a second source of
 * truth — edits made outside the app show up within 30s, and our own writes
 * invalidate immediately.
 */
const GRAPH_TTL_MS = 30_000
let graphCache: { at: number; value: VaultGraph } | null = null
let graphInflight: Promise<VaultGraph> | null = null

/** Drop the memo. Called by save(); exported so a future watcher can call it. */
export function invalidateGraph(): void {
  graphCache = null
}

/**
 * Graph edges from [[wikilinks]]. This is a CACHE, per the project's own rule:
 * the projection must be deletable and rebuildable from the files, never
 * authoritative. Nothing here writes anything.
 */
export async function graph(): Promise<VaultGraph> {
  if (graphCache && Date.now() - graphCache.at < GRAPH_TTL_MS) return graphCache.value
  if (graphInflight) return graphInflight
  graphInflight = buildGraph().finally(() => {
    graphInflight = null
  })
  return graphInflight
}

async function buildGraph(): Promise<VaultGraph> {
  const notes = await list()

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

  const index = new Map<string, string>()
  const add = (key: string, path: string) => {
    const k = norm(key)
    if (k && !index.has(k)) index.set(k, path)
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

  // Bounded, was `Promise.all(notes.map(...))` — one in-flight fetch per note,
  // all at once. Against a vault in the low hundreds that opens ~150 concurrent
  // sockets to a Python ThreadingHTTPServer that serialises every request on
  // one module-wide lock, so the requests queue anyway and the only thing the
  // extra parallelism buys is socket pressure and a 15s timeout that can fire
  // on notes still waiting their turn. A small pool keeps the server busy
  // without stampeding it.
  const LIMIT = 8
  let cursor = 0
  const worker = async (): Promise<void> => {
    // Safe without a lock: single-threaded event loop, and the read of `cursor`
    // and its increment are one synchronous step with no await between them.
    while (cursor < notes.length) {
      const n = notes[cursor++]
      let text: string
      try {
        text = (await read(n.path)).text
      } catch {
        continue
      }
      for (const name of parseWikilinks(text)) {
        const target = index.get(norm(name))
        if (!target || target === n.path) continue
        // `parseWikilinks` already dedups by NAME within a note; this dedups by
        // resolved TARGET, because [[Home]] and [[Home.md]] name one note.
        // Stringifying the pair sidesteps the separator question entirely.
        const key = JSON.stringify([n.path, target])
        if (seenEdges.has(key)) continue
        seenEdges.add(key)
        links.push({ from: n.path, to: target })
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LIMIT, notes.length) }, () => worker()),
  )

  const value = { nodes: notes.map((n) => n.path), links }
  graphCache = { at: Date.now(), value }
  return value
}

export async function backlinks(path: string): Promise<string[]> {
  const g = await graph()
  return [...new Set(g.links.filter((l) => l.to === path).map((l) => l.from))]
}
