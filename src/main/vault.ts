/**
 * Vault data layer. Every call here reads or writes the vault directory
 * DIRECTLY, in the main process. No socket, nothing to start, nothing to be
 * down.
 *
 * It was not always so. All of this used to be HTTP to
 * note-system/app/server.py on 127.0.0.1:8765. `tree()`, `list()` and `graph()`
 * came off the wire first; `read()` and `save()` stayed behind it because that
 * server owned four things worth keeping — atomic writes, backups, the
 * lost-update guard and the no-silent-overwrite rule — and because the guard
 * compared a NANOSECOND mtime that could not survive a JS number. That server
 * has since been destroyed and its source is gone, which made both reasons
 * moot: the four behaviours are implemented in `save()` below, and the mtime
 * problem was never mtime, it was PYTHON -> JSON -> JS. `st_mtime_ns` is
 * ~1.7e18 against a Number.MAX_SAFE_INTEGER of 9.0e15, so it lost its low
 * digits crossing the wire and a freshly-stat'd value never compared equal to
 * the one the reader saw.
 *
 * With both ends in Node the version stamp is `Stats.mtimeMs`: a float64 of
 * ~1.7e12 that IS a JS number, compares `===` against a fresh stat of an
 * unmodified file, and leaves `VaultNote.mtime: number` in the shared contract
 * alone. `{ bigint: true }.mtimeNs` was the alternative and buys nothing here —
 * both are capped by the filesystem's own timestamp granularity long before
 * they are capped by their width, and a BigInt would have to be widened through
 * the IPC contract and every renderer that touches it.
 *
 * The server also owned PATH CONTAINMENT (`safe()`), which is why this file
 * used to forward the caller's path verbatim and said so. Nothing downstream
 * guards it now, so `resolveInVault()` does, and it is the only thing between
 * the renderer's argument and the rest of the disk.
 *
 * These calls run in the MAIN process only. The renderer has no network access
 * and no filesystem access.
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  VaultGraph,
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
} from '../shared/ipc.js'
import { parseWikilinks } from '../shared/wikilink.ts'
import { parseFrontmatter, type VaultNoteMeta } from '../shared/notemeta.ts'

/**
 * The vault root on disk. Every read and every write in this file is resolved
 * against it, and nothing may resolve outside it — see `resolveInVault()`. Kept
 * overridable so tests can point at a scratch dir.
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
 * Node's fs errors stringify with the ABSOLUTE path they failed on —
 * `ENOENT: no such file or directory, open 'C:\…\Universal Vault\x.md'` — and
 * these errors are thrown across IPC to the renderer, which is untrusted. So
 * the vault's location on disk (and with it the OS username) would cross the
 * boundary on every missing note. Keep the sentence, drop the path.
 *
 * This used to scrub Python's OSError strings for the same reason. The source
 * changed; the leak did not.
 */
function scrub(message: string): string {
  return (
    message
      // Runs to a quote or newline, NOT to the first space. The class used to be
      // `[^\s'"]*`, and the real vault path contains a space ("Universal
      // Vault") — so `...\Desktop\Universal Vault\x.md` scrubbed to
      // `<path> Vault<path>`, leaking the fragment it exists to hide.
      .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^'"\n]*/g, '<path>')
      // POSIX absolute paths were not redacted at all. This runs on Windows
      // today, but it redacts whatever the OS hands it, and one day that is a
      // WSL or container path. Two segments minimum, so a lone `/…` fragment in
      // one of our own sentences survives.
      .replace(/\/(?:[^/\s'"\n]+\/)+[^/\s'"\n]*/g, '<path>')
  )
}

/**
 * Anything thrown by `node:fs` on its way to the renderer.
 *
 * One funnel rather than a scrub() at each throw site, because the rule is
 * per-BOUNDARY, not per-call: everything read() and save() raise crosses IPC,
 * and a new fs call added later would otherwise leak by default. Our own
 * `vault:` errors and SaveConflict are rethrown untouched — they name no path,
 * and SaveConflict must arrive as itself or the renderer's ConflictDialog never
 * fires.
 */
function fsError(e: unknown): Error {
  if (e instanceof SaveConflict) return e
  const message = e instanceof Error ? e.message : String(e)
  return message.startsWith('vault: ') ? new Error(message) : new Error(scrub(message))
}

/**
 * Vault-relative path -> absolute path on disk, or a refusal.
 *
 * server.py's `safe()` was the ONLY thing standing between a renderer-supplied
 * path and the rest of the filesystem, and this layer deliberately forwarded
 * `../../escaped.md` and `C:/Windows/win.ini` untouched so that guard could see
 * the exact bytes. There is nothing downstream to see them now, so the guard is
 * here — without it, migrating read() and save() into this process would have
 * handed the renderer a read/write primitive over the whole disk.
 *
 * Containment is LEXICAL, and that is deliberate: `realpath` is not consulted.
 * Junctions into this vault are a documented convention on this machine and
 * `tree()` follows them, so a note inside one has a vault-relative path that
 * resolves under the root while its real path does not. Resolving links would
 * make every note reached that way unopenable.
 */
function resolveInVault(rel: string): string {
  const root = resolve(VAULT_DIR)
  const abs = resolve(root, rel)
  const inside = relative(root, abs)
  // '' is the root itself, which is a directory and not a note. A leading '..'
  // or an absolute answer both mean the path climbed out.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('vault: path escapes the vault')
  }
  return abs
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
 * The `mtime: number` annotations on this function and on the IPC handler are
 * erased at runtime and stopped nothing: the renderer is untrusted and its
 * arguments arrive as whatever it chose to send. What made that fatal was the
 * shape of the OLD guard — server.py:703 ran its check only when the request
 * carried a non-null mtime:
 *
 *     if p.exists() and data.get("mtime") is not None:
 *
 * and JSON.stringify erased `undefined`, `NaN` and `null` into exactly that, so
 * a writer that sent NOTHING was trusted more than one that sent something
 * stale, and the note was overwritten whole-file.
 *
 * The guard in save() below cannot fail that way — a non-number `!==` every
 * mtime on disk, so the default outcome is a refusal rather than a clobber.
 * This stays regardless: the reason to reject junk at the boundary is to say
 * "mtime must be a finite number" instead of raising a conflict the user cannot
 * act on, and a guard that is correct twice over is the one that survives the
 * next edit to save().
 *
 * 0 is deliberately still accepted. It is the CREATE stamp — a path that does
 * not exist yet has no version to lose, so `save(path, '', 0)` is how the new
 * note button makes a file. On a file that does exist it compares unequal and
 * conflicts. Noisy, never lossy.
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

/**
 * One note, with the version stamp its next save() will be checked against.
 *
 * The stat comes BEFORE the read, and the order is the difference between a
 * false alarm and silent data loss. A write that lands between the two calls
 * gives us the OLD mtime with the NEW text: stale stamp, so the user's next
 * save raises a conflict they did not need — noisy. The other order gives us
 * the NEW mtime with the OLD text: a stamp that says "you have seen the current
 * file" when the buffer has not, and the next save overwrites the newer version
 * with no conflict at all. Noisy beats lossy.
 */
export async function read(path: string): Promise<VaultNoteBody> {
  // `path` arrives over IPC from the renderer. Empty or non-string is refused
  // at the boundary rather than left to fail deeper with a worse message.
  const safePath = requirePath(path)
  try {
    const abs = resolveInVault(safePath)
    const mtime = statSync(abs).mtimeMs
    return {
      path: safePath,
      text: readFileSync(abs, 'utf8'),
      mtime,
      title: titleOf(safePath),
    }
  } catch (e) {
    throw fsError(e)
  }
}

/**
 * Write a note, keeping the four things the note server owned.
 *
 * 1. LOST-UPDATE GUARD. `mtime` is the stamp read() handed the renderer. The
 *    file is re-stat'd here and the two must be equal, so a write by anyone
 *    else in between is caught. `mtimeMs` is a float64 of ~1.7e12 derived from
 *    the same syscall on both sides, so an untouched file compares exactly —
 *    no false conflicts. Two writes inside the SAME timestamp tick are
 *    indistinguishable, and that ceiling belongs to the filesystem's timestamp
 *    granularity (~100ns on NTFS, a full second on some others), not to the
 *    representation: `mtimeNs` would collide in exactly the same window.
 *    Against a human typing in an editor it is not reachable.
 * 2. NO SILENT OVERWRITE. A failed guard throws SaveConflict carrying the
 *    disk's current mtime and writes NOTHING. That is what the renderer's
 *    ConflictDialog is driven by, and it is the only thing protecting the
 *    user's unsaved buffer.
 * 3. BACKUP before overwrite. See backup() below.
 * 4. ATOMIC WRITE. Temp file in the target's own directory, then rename.
 *    `writeFileSync` truncates before it writes, so a crash mid-write leaves a
 *    0-byte note where the text was. rename is atomic on NTFS and replaces the
 *    target in one step. Same pattern as settings.ts:128.
 *
 * A path that does not exist yet skips the guard entirely and is CREATED —
 * server.py:765 did the same, under the comment "creating a note still needs no
 * stamp: there is no version to lose". That is what makes `save(p, '', 0)` the
 * create call.
 *
 * The guard, the backup and the rename are deliberately synchronous with no
 * `await` between them: an await there would let a second save() interleave
 * BETWEEN the stat and the rename, and both would pass a guard only one of them
 * still satisfied.
 */
export async function save(
  path: string,
  text: string,
  mtime: number,
): Promise<VaultNote> {
  const safePath = requirePath(path)
  const safeMtime = requireMtime(mtime)
  let written: number
  try {
    const abs = resolveInVault(safePath)
    // `throwIfNoEntry: false` distinguishes "not there" (a create) from a real
    // stat failure like a permission denial, which must still surface.
    const cur = statSync(abs, { throwIfNoEntry: false })
    if (cur) {
      if (cur.mtimeMs !== safeMtime) throw new SaveConflict(cur.mtimeMs)
      backup(abs, safePath)
    }

    const tmp = `${abs}.saving.tmp`
    try {
      writeFileSync(tmp, text, 'utf8')
      renameSync(tmp, abs)
    } catch (e) {
      // A half-written temp file is litter next to the user's notes, and it
      // would be picked up by the next save's rename if the name were reused.
      try {
        unlinkSync(tmp)
      } catch {
        /* never existed, or is not ours to remove */
      }
      throw e
    }
    written = statSync(abs).mtimeMs
  } catch (e) {
    throw fsError(e)
  }
  // Our own write is the one staleness source we can react to instantly.
  invalidateGraph()
  return { path: safePath, title: titleOf(safePath), mtime: written }
}

/**
 * Copy the CURRENT file aside before it is overwritten.
 *
 * The note server kept pre-edit copies in `.backups/` at the vault root, which
 * is why `.backups/` was already in SKIP below before this function existed.
 * Same location, same job, so the copies it left are still where they were and
 * still excluded: the vault-relative path is mirrored under `.backups/` with a timestamp
 * appended, so `Projects/AI.md` becomes
 * `.backups/Projects/AI.md.2026-08-16T09-12-33-104Z`. The suffix is not `.md`,
 * so a backup can never be indexed as a note even if SKIP changed.
 *
 * A failure here ABORTS the save rather than being swallowed. Overwriting the
 * only copy of a note after failing to keep a copy of it is the exact loss this
 * exists to prevent, and a `.backups/` that cannot be written to is something
 * the user needs told about, not something to write through.
 *
 * ponytail: unbounded — every save keeps a copy forever. Prune by age or count
 * when the vault's size makes that matter, or when version history gets a UI.
 */
function backup(abs: string, rel: string): void {
  const dest = resolve(VAULT_DIR, '.backups', `${rel}.${stamp()}`)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(abs, dest)
}

/** Filesystem-safe ISO timestamp: no colons, no dots. Sorts lexically. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
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
 * Reading the directory here did not reintroduce the risk that once put writes
 * behind the Python server: that was about atomic writes, backups and the
 * lost-update guard, and a directory listing has none of those hazards. The
 * writes have since come over too, with all three of those kept — see save().
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
