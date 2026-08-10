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

let BASE = 'http://127.0.0.1:8765'

/** For tests only: override the vault base URL. */
export function _setBaseForTest(url: string) {
  BASE = url
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
  return message
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>')
    .replace(/\\\\[^\s'"]+/g, '<path>')
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

const titleOf = (p: string) => p.split('/').pop()!.replace(/\.md$/i, '')

export async function list(): Promise<VaultNote[]> {
  // The server's /notes shape is its own; normalise to VaultNote here so the
  // renderer never sees two spellings of the same thing.
  const raw = await req<unknown>('/notes')
  const rows = Array.isArray(raw) ? raw : []
  return rows.map((r) => {
    const o = r as Record<string, unknown>
    const path = String(o.path ?? o.rel ?? '')
    return {
      path,
      title: String(o.title ?? titleOf(path)),
      mtime: Number(o.mtime ?? 0),
    }
  })
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
  const o = await req<{ ok: boolean; mtime: number }>('/save', {
    method: 'POST',
    body: JSON.stringify({ path: safePath, text, mtime }),
  })
  return { path: safePath, title: titleOf(safePath), mtime: o.mtime }
}

/** Folder tree, derived from the flat note list. No second source of truth. */
export async function tree(): Promise<VaultTreeNode> {
  const notes = await list()
  const root: VaultTreeNode = {
    name: 'Universal Vault',
    path: '',
    kind: 'folder',
    children: [],
  }
  for (const n of notes) {
    const parts = n.path.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      const at = parts.slice(0, i + 1).join('/')
      let next = cur.children!.find((c) => c.kind === 'folder' && c.name === seg)
      if (!next) {
        next = { name: seg, path: at, kind: 'folder', children: [] }
        cur.children!.push(next)
      }
      cur = next
    }
    cur.children!.push({ name: parts.at(-1)!, path: n.path, kind: 'note' })
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

const WIKILINK = /\[\[([^\]|#]+)/g

/**
 * Graph edges from [[wikilinks]]. This is a CACHE, per the project's own rule:
 * the projection must be deletable and rebuildable from the files, never
 * authoritative. Nothing here writes anything.
 *
 * ponytail: O(n) full rescan per call, no incremental index. Notes are in the
 * low hundreds. Add a mtime-keyed cache only if a measurement says to.
 */
export async function graph(): Promise<VaultGraph> {
  const notes = await list()
  const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n.path]))
  const links: VaultGraph['links'] = []

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
      for (const m of text.matchAll(WIKILINK)) {
        const target = byTitle.get(m[1].trim().toLowerCase())
        if (target && target !== n.path) links.push({ from: n.path, to: target })
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LIMIT, notes.length) }, () => worker()),
  )

  return { nodes: notes.map((n) => n.path), links }
}

export async function backlinks(path: string): Promise<string[]> {
  const g = await graph()
  return [...new Set(g.links.filter((l) => l.to === path).map((l) => l.from))]
}
