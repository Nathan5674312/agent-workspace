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
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  Actor,
  MoveRecord,
  VaultGraph,
  VaultNote,
  VaultNoteBody,
  VaultTreeNode,
} from '../shared/ipc.js'
import { gate } from './consent.js'
import { parseWikilinks } from '../shared/wikilink.ts'
import { parseFrontmatter, parseList, type VaultNoteMeta } from '../shared/notemeta.ts'

/**
 * The vault root on disk. Every read and every write in this file is resolved
 * against it, and nothing may resolve outside it — see `resolveInVault()`. Kept
 * overridable so tests can point at a scratch dir.
 *
 * THE FALLBACK MUST NOT NAME A REAL PERSON'S MACHINE. It used to be the literal
 * `C:\Users\Nathan\Desktop\Universal Vault`, which is correct on exactly one
 * computer; every packaged install pointed at a folder its user does not have.
 * That is invisible in dev, because in dev it exists.
 *
 * `homedir()` and not Electron's `app.getPath('documents')`, which would be the
 * locale-correct answer: this module imports NO electron, and five test files
 * import it under plain `node --test`, where there is no Electron runtime to
 * ask. A default that breaks the suite to gain a translated folder name is a
 * bad trade — and the settings picker is the real answer for anyone whose notes
 * live elsewhere.
 *
 * The folder is not created here and probably does not exist. That is already a
 * handled state, not a crash: `checkRoots()` stats this path at boot and returns
 * a message the settings modal shows, telling the user to pick their folder.
 * Creating a directory as a side effect of importing a module would be worse.
 */
let VAULT_DIR =
  process.env.AGENT_WORKSPACE_VAULT_DIR || resolve(homedir(), 'Documents', 'Fate')

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
 * `vault:` errors, SaveConflict and MoveConflict are rethrown untouched — they
 * name no path the caller did not already supply, and both conflict classes
 * must arrive AS THEMSELVES or the renderer cannot tell a collision from a
 * disk failure. Wrapping them in a plain Error, which the `vault: ` branch
 * below would do, is exactly the bug that funnel is here to prevent.
 */
function fsError(e: unknown): Error {
  if (e instanceof SaveConflict || e instanceof MoveConflict) return e
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
  return resolveUnder(resolve(VAULT_DIR), rel, 'vault: path escapes the vault')
}

/**
 * The same lexical containment, against `<vault>/.trash`.
 *
 * Needed because a move's trash destination and an undo's trash SOURCE are both
 * paths this file constructs, and one of them — `MoveEntry.trash` — comes back
 * off disk from a file sitting inside the user's own vault. A `..` written into
 * that field by anything else would otherwise make `undoMove()` rename a file
 * from anywhere on the disk into the vault. Guarding a path we appear to own is
 * cheap; the alternative is trusting a file we do not control.
 *
 * The rule itself is factored out rather than restated for the third time in
 * this codebase — versions.ts:resolveInBackups is the second copy, and its own
 * comment asks for exactly this fold. That one is left alone here only because
 * this task is additive to vault.ts.
 */
function resolveInTrash(rel: string): string {
  return resolveUnder(
    resolve(VAULT_DIR, TRASH),
    rel,
    'vault: path escapes the trash',
  )
}

function resolveUnder(root: string, rel: string, refusal: string): string {
  const abs = resolve(root, rel)
  const inside = relative(root, abs)
  // '' is the root itself, which is a directory and not a note. A leading '..'
  // or an absolute answer both mean the path climbed out.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(refusal)
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

  /**
   * THERE IS NO "ROOT IS ABOVE A VAULT" WARNING HERE ANY MORE, deliberately.
   *
   * One stood here and named the child vault, because pointing one level too
   * high used to be quietly catastrophic: every exclusion in this file was a
   * PATH PREFIX relative to VAULT_DIR, so `System/Skills/gstack/` stopped
   * matching the moment the real path became `Universal Vault/System/Skills/
   * gstack/`, and `ignoreFilters()` looked for `<root>/.obsidian/app.json` and
   * found a different vault's file or none. Measured with `vaultDir` on
   * Desktop: 379 deliberately-excluded files came back, notes went 281 -> 1420,
   * and because 633 of them are named `SKILL.md` the LINK count FELL, 657 ->
   * 567, with 1344 of 1420 flagged orphan. The graph was dust.
   *
   * The warning was the wrong repair for that, and was rejected as such: it
   * told the user not to do the thing instead of making the thing work. Both
   * halves are now fixed at the source — `tree()` picks up each vault's own
   * `.obsidian/app.json` and re-anchors its filters to that vault's folder, and
   * `isSkipped()` matches SKIP at any segment boundary rather than only at the
   * root. A folder one level above a vault now indexes that vault exactly as
   * opening it directly would, so there is nothing left to warn about.
   *
   * What remains below is about the folder being UNUSABLE — empty, or with no
   * link structure at all — which is true regardless of where the root sits.
   */

  // Non-empty is the real signal, and it costs one scan that the first view to
  // load would have paid for anyway — the memo makes this free rather than
  // duplicated work.
  const notes = await list().catch((): VaultNoteMeta[] => [])

  // Reported BEFORE the note count, because a truncated walk makes every number
  // below it a floor rather than a total, and saying "1 234 notes" about a
  // partial index is the more confident lie.
  const truncated = getTreeTruncation()
  if (truncated) return `vault: ${truncated}`
  if (notes.length === 0) {
    return (
      `vault: ${VAULT_DIR} contains no files at all, so the explorer, the ` +
      `database and the graph will all be empty. Check the vault path in settings.`
    )
  }

  /**
   * THE "no Home.md" AND "nothing links to anything" WARNINGS ARE GONE.
   *
   * Both were true statements and both were noise, for the same reason the
   * root-above-a-vault warning was: they describe a folder for failing to be an
   * Obsidian vault. Measured across ten real locations, one or the other fired
   * on EIGHT of them — including `System32\drivers\etc`, where "Add a Home.md
   * to pin it" is advice about someone's DNS configuration.
   *
   * They also stopped being true. `pickRoot` now finds a `Home.md` at any
   * depth, and structural edges mean the graph is connected in every one of
   * those ten locations, so "every note will report as an orphan" no longer
   * describes what the user sees. A warning that is both unhelpful and
   * out of date is worse than none: it trains people to dismiss the box that
   * also carries the real messages above.
   *
   * What survives is only what makes the app UNUSABLE here — an unreadable
   * directory, a truncated walk, an empty folder — none of which is an opinion
   * about how the user organises their files.
   */
  return null
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
  /**
   * A binary is refused HERE, in main, not merely hidden in the renderer.
   *
   * Now that the explorer lists every file, `read()` is reachable for a `.png`
   * or an `.exe` — and the editor's contract is read-into-a-textarea, edit,
   * `save()` the string back. A UTF-8 decode of a PNG is lossy, so that round
   * trip does not display a binary badly, it DESTROYS it, and `save()`'s
   * backup would be taken after the damage was already in the buffer.
   *
   * Refusing at the boundary rather than in VaultPane is deliberate: the
   * renderer is untrusted and there is more than one caller, so a guard that
   * lives only in the UI is one new call site away from being absent.
   */
  if (!isTextFile(safePath)) {
    throw new Error(
      `vault: ${titleOf(safePath)} is not a text file, so it cannot be opened in the editor.`,
    )
  }
  try {
    const abs = resolveInVault(safePath)
    const st = statSync(abs)
    // Loading a multi-gigabyte log into a <textarea> hangs the renderer hard
    // enough to look like a crash. Far above the indexing cap on purpose.
    if (st.size > MAX_OPEN_BYTES) {
      throw new Error(
        `vault: ${titleOf(safePath)} is ${Math.round(st.size / 1048576)} MB, too large to open in the editor.`,
      )
    }
    return {
      path: safePath,
      text: readFileSync(abs, 'utf8'),
      mtime: st.mtimeMs,
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
  actor: Actor,
): Promise<VaultNote> {
  const safePath = requirePath(path)
  const safeMtime = requireMtime(mtime)
  // Before the stat, before the backup, before the write. A denied consent is
  // a statement about the disk — nothing below this line has run.
  await gate(actor, 'save', [safePath])
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
 * Extensions that are definitely NOT text, so the file is listed but never read.
 *
 * A DENYLIST, not an allowlist, and that direction is the point. An allowlist of
 * "text extensions" is a list of the file types someone thought of, and every
 * one they did not think of opens as an empty folder — which is exactly the
 * failure being fixed here. Denying the handful of formats that are definitely
 * binary means an unknown extension is treated as text, read, and indexed. The
 * worst case for a wrong guess is a row whose link parse finds nothing; the
 * worst case for the other default is a folder that looks empty.
 *
 * Size is the real guard against a huge unknown file, not this list — see
 * MAX_TEXT_BYTES in `scan()`.
 */
const BINARY_EXT = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'avif', 'heic', 'psd',
  // video and audio
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac',
  // archives and disk images
  'zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'iso', 'dmg', 'cab', 'msi',
  // executables and libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'o', 'a', 'lib', 'pdb', 'class', 'jar', 'pyc',
  // documents that are containers rather than text
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods',
  // fonts, databases, other opaque blobs
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'db', 'sqlite', 'sqlite3', 'mdb', 'dat', 'pack', 'idx',
])

/** Is this filename one we are willing to read as text? See BINARY_EXT. */
function isTextFile(name: string): boolean {
  const cut = name.lastIndexOf('.')
  // No extension at all — LICENSE, Makefile, .gitignore — is text far more
  // often than not, and reading it costs one small file.
  if (cut <= 0) return true
  return !BINARY_EXT.has(name.slice(cut + 1).toLowerCase())
}

/**
 * Above this, a file is listed and indexed but its text is not read. See `scan()`.
 *
 * This is the INDEXING budget and it is paid thousands of times per scan, which
 * is why it is small. It is NOT a limit on what the user may open — see
 * MAX_OPEN_BYTES.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Above this, `read()` refuses rather than hand the renderer a <textarea> that
 * will hang it.
 *
 * Deliberately a different, far larger number than MAX_TEXT_BYTES, and the
 * first attempt at this used one constant for both — which broke opening a 4 MB
 * note, a case the suite already guarded (`a multi-megabyte note round-trips
 * intact`). The two limits answer different questions: indexing is a cost
 * multiplied by every file in the tree and must stay cheap, while opening is
 * one file the user explicitly asked for and should only be refused when it
 * would genuinely wedge the window.
 */
const MAX_OPEN_BYTES = 64 * 1024 * 1024

/**
 * Markdown inline links — `[text](target)` — and the reference form's target.
 *
 * Excludes `(` and `)` from the target so a trailing `)` in prose cannot run
 * away with the match, and excludes whitespace so a link with a title
 * (`[a](b "t")`) stops at the path.
 */
const MD_LINK = /\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?[^)]*\)/g

/**
 * Bare relative paths mentioned in prose or code: `./foo/bar.ts`, `src/x.py`.
 *
 * Deliberately requires a separator AND an extension. Without both this matches
 * ordinary words and version numbers, and every false positive becomes a wrong
 * edge in someone's graph.
 */
const BARE_PATH = /(?:^|[\s('"`])(\.{0,2}\/)?([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8})/g

/**
 * Everything in `text` that might name another file in this tree.
 *
 * THREE grammars, because a vault is not the only thing a folder can be. The
 * app understood `[[wikilinks]]` and nothing else, which is correct for
 * Obsidian and useless everywhere else: measured across ten real locations,
 * `agent-workspace` produced 24 notes and ZERO links and `cc-extension` 10 and
 * ZERO, not because those repos are unconnected but because a README says
 * `[the spec](docs/SPEC.md)` and never `[[SPEC]]`. Both rendered as 100%
 * orphan dust.
 *
 * Wikilinks stay first and unchanged. The other two only ever ADD candidates,
 * and every candidate still has to survive `resolve()` — a path that names no
 * file in the tree produces nothing. So the cost of a false positive here is an
 * edge that fails to resolve, not a wrong edge.
 *
 * `from` anchors the relative forms: `./x.ts` inside `src/main/` means
 * `src/main/x.ts`, which is the whole reason a source tree links itself up
 * without anyone writing a single link by hand.
 */
function linkTargets(text: string, from: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const name = raw.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push(name)
  }

  for (const name of parseWikilinks(text)) push(name)

  const dir = from.slice(0, from.lastIndexOf('/') + 1)
  /** `./a`, `../a` and bare `a/b` resolved against the linking file's folder. */
  const anchor = (target: string): void => {
    // Absolute URLs, mailto:, anchors and query strings name nothing on disk.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return
    const clean = target.split(/[#?]/)[0]
    if (!clean) return
    push(clean) // as written — resolve() also matches vault-relative forms
    // NOT `if (!dir) return`. A file at the ROOT has `dir === ''`, and skipping
    // the walk there left `./docs/GUIDE.md` pushed only in its raw form, which
    // matches no key because every indexed path is stored without the `./`.
    // So a link from a top-level README — the single most common place a repo
    // puts its links — resolved nothing while the identical link one folder
    // down resolved fine.
    //
    // Walked here rather than with path.resolve(): these are vault-relative
    // POSIX-ish strings, not OS paths, and `resolve` would drag in the drive.
    const parts = `${dir}${clean}`.split('/')
    const stack: string[] = []
    for (const p of parts) {
      if (p === '.' || p === '') continue
      if (p === '..') stack.pop()
      else stack.push(p)
    }
    push(stack.join('/'))
  }

  for (const m of text.matchAll(new RegExp(MD_LINK.source, 'g'))) anchor(m[1])
  for (const m of text.matchAll(new RegExp(BARE_PATH.source, 'g'))) {
    anchor(`${m[1] ?? ''}${m[2]}`)
  }
  return out
}

/**
 * A vault's OWN exclusions, from Obsidian's `.obsidian/app.json`
 * (`userIgnoreFilters`, the "Files and links → Excluded files" setting).
 *
 * Read rather than duplicated because the user maintains that list in Obsidian
 * and expects one answer to "is this note hidden".
 *
 * TAKES THE VAULT'S DIRECTORY, and that argument is the whole fix.
 *
 * It used to read `<VAULT_DIR>/.obsidian/app.json` and nothing else, which
 * quietly made the app work in exactly one configuration: the root you opened
 * had to BE the vault. Point it one level up and the vault's own exclusion list
 * is not merely mis-anchored, it is never found — `Desktop/.obsidian/app.json`
 * is a different file that says nothing about `Universal Vault/`, so all 379
 * deliberately-excluded files came back and the graph filled with skill
 * bundles. The old answer to that was a warning telling the user not to do it.
 * The right answer is that exclusions belong to the vault that DECLARES them,
 * so `tree()` picks them up wherever it finds a vault and re-anchors them to
 * that vault's folder.
 *
 * A DIFFERENT matching rule from HIDDEN, and the two must not be folded
 * together: HIDDEN matches a BASENAME anywhere in the tree, these are
 * PATH PREFIXES relative to their own vault. `System/Skills/gstack` hides
 * exactly that folder, not every folder named `gstack`. The prefix must land on
 * a segment boundary or `System/Skill Sources` would also swallow
 * `System/Skill Sources Extra`.
 *
 * app.json is a user-writable file, so it is untrusted input: missing,
 * unreadable, corrupt, or the wrong shape all mean ZERO extra exclusions and no
 * throw — the same posture settings.ts:load() and network.ts's trust store take
 * on their own JSON. Failing here would empty the explorer over a stray comma.
 *
 * Read per call rather than memoised: it is one small file per vault against a
 * walk of the whole tree, and a memo would need invalidating when
 * `setVaultDir()` points this somewhere else.
 *
 * ponytail: prefixes only. Obsidian also accepts a `/regex/` entry in this
 * field; those are dropped rather than honoured (and never crash), so a
 * regex-filtered folder still shows. Implement it when someone writes one.
 * Matching is case-SENSITIVE where Obsidian's is not — same upgrade point.
 */
function ignoreFilters(dir: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(dir, '.obsidian', 'app.json'), 'utf8'))
  } catch {
    return []
  }
  const raw = (parsed as { userIgnoreFilters?: unknown } | null)?.userIgnoreFilters
  if (!Array.isArray(raw)) return []
  return raw
    .filter((f): f is string => typeof f === 'string' && !f.startsWith('/'))
    .map((f) => f.replace(/\/+$/, ''))
    .filter(Boolean)
}

/** Vault-relative path -> is it under one of the filters, on a segment boundary. */
function isIgnored(rel: string, filters: string[]): boolean {
  return filters.some((f) => rel === f || rel.startsWith(`${f}/`))
}

/**
 * When the open root is INSIDE a vault, that vault's exclusions still apply —
 * they are just written from further up than we are standing.
 *
 * `tree()` walks DOWN and picks up a vault's `.obsidian/app.json` when it
 * reaches one, which covers opening a vault or anything above it. It cannot
 * cover opening a folder BELOW one, because the walk never passes the file.
 * Measured: opening `Universal Vault\System` indexed 1179 notes against 13
 * links — the whole of `System/Skills/gstack` and `System/Skill Sources` came
 * back, because both the vault's own filters and this file's SKIP list are
 * written as `System/…` while from in here the same notes are `Skills/…`.
 *
 * So walk UP for the nearest `.obsidian/`, and return the filters re-expressed
 * relative to where we actually are: an ancestor's `System/Skills/gstack`
 * becomes `Skills/gstack` when opened from `System`, and anything outside our
 * subtree drops out entirely because it can never match a path we will see.
 *
 * Bounded by the filesystem root, and `dirname` is what terminates it: at a
 * drive root `dirname(x) === x`, so the loop stops rather than spinning.
 */
function enclosingVaultFilters(dir: string): string[] {
  let cur = resolve(dir)
  let offset = '' // path of `dir` relative to the vault, '' until we climb
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return [] // filesystem root, no vault above us
    offset = offset ? `${basename(cur)}/${offset}` : basename(cur)
    cur = parent
    if (!existsSync(resolve(cur, '.obsidian'))) continue
    const prefix = `${offset}/`
    return ignoreFilters(cur)
      .filter((f) => f === offset || f.startsWith(prefix))
      // `f === offset` means the vault excludes the very folder we opened. Keep
      // it as '' so nothing matches it rather than dropping to a bare prefix
      // that would swallow the entire tree.
      .map((f) => (f === offset ? '' : f.slice(prefix.length)))
      .filter(Boolean)
  }
}

/**
 * Create one folder in the vault.
 *
 * Direct `node:fs`, and the precedent is `tree()` below rather than `save()`
 * above: the reason writes were once kept behind a separate process was atomic
 * replacement, pre-edit backups and the lost-update guard, and a directory has
 * none of those hazards. There is no content to lose and no version to race.
 *
 * `resolveInVault` IS the traversal guard, reused rather than restated — it
 * already rejects `..`, an absolute path and a drive letter, and it already
 * rejects `''` because the root is not something to create. A second
 * containment check written specially for this call is a second thing to keep
 * correct, and the two would drift.
 *
 * The name check is a separate concern from containment: `tree()` skips
 * dot-directories and everything in HIDDEN, so those names would create a real
 * folder that never appears in the explorer — a button that reports success and
 * shows nothing, which is the defect this control is being fixed for. Refusing
 * is the honest answer.
 *
 * NOT recursive, deliberately. `recursive: true` swallows EEXIST, so typing the
 * name of a folder that already exists would report success and appear to do
 * nothing. Letting EEXIST through is what puts a real sentence in front of the
 * user.
 */
export async function mkdir(path: string, actor: Actor): Promise<void> {
  const safePath = requirePath(path)
  await gate(actor, 'mkdir', [safePath])
  try {
    const abs = resolveInVault(safePath)
    const name = basename(abs)
    if (name.startsWith('.') || HIDDEN.has(name)) {
      throw new Error('vault: the explorer does not show folders with that name')
    }
    mkdirSync(abs)
  } catch (e) {
    throw fsError(e)
  }
}

/**
 * Something is already where a file was about to go.
 *
 * A distinct class rather than a `vault: …` string for the same reason
 * SaveConflict is one: the renderer has to be able to tell "there is a note
 * there already, pick another name" apart from every other fs failure, and it
 * cannot do that by matching on a message. Carries the path it collided on so
 * the dialog can name it — that path came FROM the renderer, so echoing it back
 * leaks nothing `scrub()` protects.
 *
 * Fields are declared and assigned explicitly, not as TS parameter properties,
 * for the reason stated on SaveConflict: this module is imported directly by
 * `node --test` under type stripping.
 */
export class MoveConflict extends Error {
  path: string
  constructor(path: string) {
    super('Something is already at that path.')
    this.name = 'MoveConflict'
    this.path = path
  }
}

/** `<vault>/.trash` — already in HIDDEN, so nothing under it is ever listed. */
const TRASH = '.trash'

/**
 * The move journal: `<vault>/.trash/moves.jsonl`, append-only, one JSON object
 * per line.
 *
 * It lives BESIDE THE DATA, not in Electron's userData, and the deciding
 * argument is that a journal entry is useless without the trashed original it
 * points at. Splitting them puts the two halves of one undo on different
 * lifecycles: copy the vault to another machine and the notes arrive with no
 * way to unfile them; clear app data and the trash fills with files nothing can
 * name. Keeping both under `.trash/` means the undo travels with the thing it
 * undoes, and a vault backup backs up its own history.
 *
 * The cost of that choice is that the journal sits inside the user's files.
 * `.trash` is in HIDDEN, so `tree()` skips it and `list()`/`graph()` are built
 * from `tree()` — the journal is invisible to the explorer, the database and
 * the graph. It is also not `.md`, so it could not be indexed as a note even if
 * HIDDEN changed.
 *
 * Append-only is what makes an undo record honest under a crash: an entry is
 * never rewritten, so a torn write can only ever damage the LAST line, and
 * `readJournal()` drops a line it cannot parse. Undoing appends a second record
 * `{ undo: <id> }` rather than editing the first.
 */
const JOURNAL = 'moves.jsonl'

/** A journal move record. `trash` is relative to `.trash/` and stays in main. */
type MoveEntry = MoveRecord & { trash: string }

/** One journal line: a move, or the tombstone that undid one. */
type JournalLine = MoveEntry | { undo: string; at: number }

function journalPath(): string {
  return resolve(VAULT_DIR, TRASH, JOURNAL)
}

/**
 * The journal as it stands on disk, read fresh every time.
 *
 * Deliberately NOT memoised: this is the state an undo is authorised against,
 * and a stale copy would let the same move be undone twice. It is also what
 * makes the journal survive a restart without any load step — there is no
 * in-memory journal to lose.
 */
function readJournal(): { moves: Map<string, MoveEntry>; undone: Set<string> } {
  const moves = new Map<string, MoveEntry>()
  const undone = new Set<string>()

  let text: string
  try {
    text = readFileSync(journalPath(), 'utf8')
  } catch {
    // No journal is not an error: it is a vault nothing has been moved in.
    return { moves, undone }
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec: JournalLine
    try {
      rec = JSON.parse(line)
    } catch {
      // A half-written last line from a crash. Skipping it costs one undo;
      // failing here would cost every undo in the file.
      continue
    }
    if (!rec || typeof rec !== 'object') continue
    if ('undo' in rec && typeof rec.undo === 'string') undone.add(rec.undo)
    else if ('id' in rec && typeof rec.id === 'string') moves.set(rec.id, rec)
  }
  return { moves, undone }
}

function appendJournal(rec: JournalLine): void {
  mkdirSync(resolve(VAULT_DIR, TRASH), { recursive: true })
  appendFileSync(journalPath(), `${JSON.stringify(rec)}\n`, 'utf8')
}

/**
 * Refuse a path the explorer would not show.
 *
 * The rule mkdir() applies to a new folder name, applied to every SEGMENT of a
 * path instead: filing a note into `.obsidian/` or `.trash/` would make it
 * vanish from the sidebar, the database and the graph while reporting success,
 * which is the same defect mkdir() refuses for. Pointing a move INTO `.trash/`
 * would additionally put a file where the journal's own bookkeeping lives.
 *
 * Segments come off the RESOLVED path, not the caller's string, so
 * `Notes/../.git/x.md` is caught as `.git` rather than read as three innocent
 * segments.
 */
function requireVisible(abs: string): void {
  for (const part of relative(resolve(VAULT_DIR), abs).split(sep)) {
    if (part.startsWith('.') || HIDDEN.has(part)) {
      throw new Error('vault: the explorer does not show that path')
    }
  }
}

/** Vault-relative, forward slashes — the canonical form for the contract. */
function relOf(abs: string): string {
  return relative(resolve(VAULT_DIR), abs).split(sep).join('/')
}

/**
 * Move a note, reversibly. The primitive an agent files with.
 *
 * The whole point is that NOTHING here deletes. The original is not unlinked at
 * the end of a successful move, it is RENAMED into `<vault>/.trash/` with its
 * relative path preserved and a timestamp appended — the same shape `backup()`
 * uses for `.backups/`, for the same reason: a flat trash cannot tell
 * `Projects/AI.md` from `Archive/AI.md`.
 *
 * Order is the design, and it is copy-verify-then-trash rather than rename:
 *
 *  1. `resolveInVault()` BOTH ends. A move writes in two places, so one guard
 *     is half a guard. This is the only thing between the renderer and the
 *     rest of the disk.
 *  2. Destination occupied -> MoveConflict, nothing touched. The
 *     no-silent-overwrite rule save() keeps, kept here. `COPYFILE_EXCL` below
 *     enforces it a second time at the kernel, so a file that appears between
 *     the check and the copy still cannot be clobbered.
 *  3. Source missing -> refuse.
 *  4. Destination directory created if needed.
 *  5. COPY, then verify the byte length BEFORE anything happens to the
 *     original. A short copy at this point is a thrown error over an intact
 *     source; a short copy after a rename would be the loss this exists to
 *     prevent.
 *  6. Only now is the original moved aside, by rename. Never `unlink`.
 *  7. Journal the move so it can be undone.
 *
 * If any step throws, the original is still exactly where it started. Steps 5
 * and 6 can leave litter — a truncated copy at `to`, or a copy at `to` whose
 * trash rename failed — and litter is the deliberate trade: cleaning it up
 * means deleting a file, and this feature does not delete files.
 *
 * `mkdir()` above is deliberately NOT reused for step 4. Its containment check
 * is reused (`resolveInVault`) and so is its hidden-name rule (see
 * `requireVisible`), but its two remaining behaviours are the exact opposite of
 * what a destination folder needs: it is non-recursive and it lets EEXIST
 * through, both so the "+ Folder" button reports honestly. For a move, a
 * destination folder that already exists is the NORMAL case, and what is left
 * after removing those two behaviours is one `mkdirSync` call.
 *
 * ponytail: files only. A folder move is a walk, N copies and a partial-failure
 * story that has to be journalled per file; build it when something actually
 * asks to file a folder.
 */
export async function move(from: string, to: string, actor: Actor): Promise<MoveRecord> {
  const safeFrom = requirePath(from)
  const safeTo = requirePath(to)
  // Both ends are named in the prompt, because "the agent wants to move a file"
  // is not something a human can judge without knowing where it is going.
  await gate(actor, 'move', [`${safeFrom} -> ${safeTo}`])
  let entry: MoveEntry
  try {
    const fromAbs = resolveInVault(safeFrom)
    const toAbs = resolveInVault(safeTo)
    requireVisible(fromAbs)
    requireVisible(toAbs)

    if (existsSync(toAbs)) throw new MoveConflict(relOf(toAbs))
    const src = statSync(fromAbs, { throwIfNoEntry: false })
    if (!src) throw new Error('vault: there is nothing at that path to move')
    if (!src.isFile()) throw new Error('vault: only a file can be moved')

    mkdirSync(dirname(toAbs), { recursive: true })
    // EXCL, not a plain copy: this call fails rather than overwrites, so the
    // rule survives the gap between the check above and this line.
    copyFileSync(fromAbs, toAbs, constants.COPYFILE_EXCL)
    if (statSync(toAbs).size !== src.size) {
      throw new Error('vault: the copy came out the wrong size, nothing was moved')
    }

    const id = randomUUID()
    // The timestamp keeps repeated moves of one path apart and sorts; the id
    // fragment is what makes that actually true, since two moves inside one
    // millisecond would otherwise land on the same trash name and the second
    // copy would overwrite the first — a delete by another name.
    const trashRel = `${relOf(fromAbs)}.${stamp()}.${id.slice(0, 8)}`
    const trashAbs = resolveInTrash(trashRel)
    mkdirSync(dirname(trashAbs), { recursive: true })
    renameSync(fromAbs, trashAbs)

    entry = { id, from: relOf(fromAbs), to: relOf(toAbs), trash: trashRel, at: Date.now() }
    appendJournal(entry)
  } catch (e) {
    throw fsError(e)
  }
  // A move changes which paths exist, so the memo behind list() and graph()
  // describes a vault that is one note out of date. Same reason save() does it.
  invalidateGraph()
  return { id: entry.id, from: entry.from, to: entry.to, at: entry.at }
}

/**
 * Reverse one move.
 *
 * Authorised entirely from the journal on disk, so it works after a restart and
 * cannot be talked into anything that was never recorded. Refusals, in order:
 * an id that is not in the journal, an id already undone, and an origin that
 * something else now occupies — putting the original back over a newer file
 * would be the silent overwrite this whole feature exists to avoid.
 *
 * The copy at `to` is TRASHED, not deleted. "Remove the file at `to`" is the
 * job; `unlink` is not how it gets done, because an undo of an undo has to be
 * possible and because nothing in this feature deletes.
 *
 * The original goes back FIRST. If the second half then fails the user has two
 * copies, which is recoverable; the other order risks a moment with none.
 */
export async function undoMove(id: string, actor: Actor): Promise<void> {
  const safeId = requirePath(id)
  await gate(actor, 'undo-move', [safeId])
  try {
    const { moves, undone } = readJournal()
    const entry = moves.get(safeId)
    if (!entry) throw new Error('vault: no such move')
    if (undone.has(safeId)) throw new Error('vault: that move has already been undone')

    // The journal is a file in the vault, so its contents are re-guarded rather
    // than trusted: an edited `trash` field would otherwise rename a file from
    // anywhere on disk into the vault.
    const fromAbs = resolveInVault(entry.from)
    const toAbs = resolveInVault(entry.to)
    const trashAbs = resolveInTrash(entry.trash)

    if (existsSync(fromAbs)) throw new MoveConflict(entry.from)
    if (!existsSync(trashAbs)) throw new Error('vault: the original is no longer in the trash')

    // The folder the note came from may have been removed since.
    mkdirSync(dirname(fromAbs), { recursive: true })
    renameSync(trashAbs, fromAbs)

    // Gone already is not a failure — the undo still had work to do and did it.
    if (existsSync(toAbs)) {
      const dest = resolveInTrash(`${entry.to}.${stamp()}.${safeId.slice(0, 8)}`)
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(toAbs, dest)
    }

    appendJournal({ undo: safeId, at: Date.now() })
  } catch (e) {
    throw fsError(e)
  }
  invalidateGraph()
}

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
 *
 * This is also where Obsidian's `userIgnoreFilters` are applied, and applying
 * them HERE is the whole point: `list()` and `graph()` are both built from this
 * walk (see `scan()`), so one filter list cannot disagree with itself. Filtering
 * in scan() instead would hide a note from the database while the explorer still
 * showed it, and leave graph edges pointing at nodes the tree cannot draw.
 */
/**
 * Ceilings on one tree walk, and why they have to exist.
 *
 * The folder picker will accept any directory on the machine, and `tree()` had
 * no bound of any kind — it walked until it ran out of filesystem. Measured by
 * pointing the vault at ten real locations:
 *
 *   C:\Users\Nathan        killed at 30s, never finished
 *   C:\                    27.5s, 44 560 folders, 252 MB
 *   …\AppData\Local\Temp   10.2s, 16 398 folders, 402 levels deep, 880 MB
 *
 * All three are one bad click away in a picker that opens inside the user's own
 * vault, and all three freeze the main process — so the explorer, the database
 * and the graph hang together, with no progress and no way to cancel.
 *
 * The numbers are generous against a real vault and hostile to a wrong one.
 * The Universal Vault is 121 folders at depth 8, so a notes vault would have to
 * be eighty times larger before it noticed these. A truncated walk is REPORTED
 * rather than quietly served — a partial explorer that looks complete is the
 * failure mode this whole file keeps having.
 */
const MAX_TREE_DIRS = 10_000
const MAX_TREE_DEPTH = 16

/** Why the last walk stopped early, or null if it completed. */
let treeTruncated: string | null = null

/** Read by `checkRoots()`. Describes the LAST completed `tree()` call. */
export function getTreeTruncation(): string | null {
  return treeTruncated
}

export async function tree(): Promise<VaultTreeNode> {
  const { readdir, realpath, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')

  let dirsWalked = 0
  let hitDepth = false
  treeTruncated = null

  /**
   * Real paths of directories already walked, so a link that points at an
   * ancestor terminates instead of recursing until the stack gives out. This is
   * the cost of following links at all, and it has to be paid before following
   * them, not after someone reports a hang.
   */
  const visited = new Set<string>()

  /**
   * `filters` is INHERITED and ADDED TO on the way down, never recomputed from
   * the root.
   *
   * Each entry is a path relative to THIS walk's root, so a nested vault's
   * `System/Skill Sources` arrives here as `Universal Vault/System/Skill
   * Sources` and matches. That re-anchoring is the reason the same vault
   * excludes the same folders whether you open it directly or from its parent,
   * which is the whole of "point it anywhere and it works".
   */
  async function walk(
    abs: string,
    rel: string,
    depth: number,
    filters: string[],
  ): Promise<VaultTreeNode[]> {
    const real = await realpath(abs).catch(() => abs)
    if (visited.has(real)) return [] // cycle
    visited.add(real)

    // Checked on ENTRY, so the caps bound the work done rather than the work
    // already done. Both stop descending and neither throws: a vault that is
    // 90% listed is far more useful than an error, provided it says so.
    if (++dirsWalked > MAX_TREE_DIRS) return []
    if (depth >= MAX_TREE_DEPTH) {
      hitDepth = true
      return []
    }

    let entries
    try {
      entries = await readdir(abs, { withFileTypes: true })
    } catch {
      return [] // unreadable directory: show nothing rather than fail the tree
    }

    /**
     * A directory carrying `.obsidian/` IS a vault, so adopt its exclusions.
     *
     * Detected from `entries` rather than with a stat of its own: the readdir
     * has already happened, so recognising a vault costs nothing on the 99% of
     * directories that are not one, and the one file read only happens where
     * there is something to read. At the root this reproduces exactly what the
     * old `ignoreFilters()` did, which is why opening a vault directly is
     * unchanged.
     */
    if (entries.some((e) => e.name === '.obsidian')) {
      const mine = ignoreFilters(abs)
      if (mine.length) filters = [...filters, ...mine.map((f) => (rel ? `${rel}/${f}` : f))]
    }

    const out: VaultTreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || HIDDEN.has(e.name)) continue
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (isIgnored(childRel, filters)) continue
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
          children: await walk(childAbs, childRel, depth + 1, filters),
        })
      } else if (isFile && e.name.toLowerCase().endsWith('.canvas')) {
        // The Canvas view's boards. Kept in the tree so the vault stays the one
        // source of "what is in here" — the canvas list reads this rather than
        // walking the disk a second time — and given their own kind so
        // `buildIndex` cannot mistake JSON for a note. See VaultTreeNode.
        out.push({ name: e.name, path: childRel, kind: 'canvas' })
      } else if (isFile) {
        /**
         * EVERY file is listed now, not only `.md`.
         *
         * The explorer used to drop anything else on the floor, which is the
         * single reason most folders on this machine opened completely empty:
         * measured across ten locations, `Downloads`, `Documents`, `Pictures`,
         * `System32\drivers\etc` and this repo's own `src/` all showed zero
         * files and zero rows while being full of them. "Point it anywhere"
         * cannot be true while the app can only see one extension.
         *
         * `isTextFile` decides whether it can be READ, not whether it is shown.
         * A photograph belongs in the explorer and in the database — it is a
         * thing in the folder — it just has no text to parse and must never
         * reach the editor. See VaultTreeNode.kind.
         */
        out.push({
          name: e.name,
          path: childRel,
          kind: isTextFile(e.name) ? 'note' : 'file',
        })
      }
    }
    return out
  }

  const root: VaultTreeNode = {
    /**
     * The FOLDER's name, not a literal.
     *
     * This was the string `'Universal Vault'`, which meant the app called the
     * vault that no matter which directory it was reading. Point it at
     * Downloads and the explorer root, the first tab and the switcher in the
     * corner all still said Universal Vault — so the single most visible answer
     * to "which vault am I looking at" was hardcoded to one machine's setup and
     * could never be wrong out loud. It is most of why changing the folder
     * looked like it did nothing.
     *
     * A drive root has no basename (`basename('C:\\')` is `''`), so the full
     * path stands in rather than an empty label.
     */
    name: basename(VAULT_DIR) || VAULT_DIR,
    path: '',
    kind: 'folder',
    // Seeded with the enclosing vault's filters, so opening a SUBfolder of a
    // vault is as correct as opening the vault. The walk adds any vault it
    // meets on the way down to this.
    children: await walk(VAULT_DIR, '', 0, enclosingVaultFilters(VAULT_DIR)),
  }

  // Recorded AFTER the walk, so the message reports what actually happened
  // rather than what was configured. Read by checkRoots().
  if (dirsWalked > MAX_TREE_DIRS) {
    treeTruncated =
      `${VAULT_DIR} holds more than ${MAX_TREE_DIRS.toLocaleString()} folders, so only ` +
      `the first ${MAX_TREE_DIRS.toLocaleString()} were indexed. This is almost always a ` +
      `sign the vault folder is pointed at a whole drive or a home directory ` +
      `rather than at a notes folder.`
  } else if (hitDepth) {
    treeTruncated =
      `${VAULT_DIR} nests deeper than ${MAX_TREE_DEPTH} levels; anything below that was ` +
      `not indexed. Notes vaults do not usually nest that far — check the vault folder.`
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
 * Paths the INDEX never counts as notes.
 *
 * THIS LIST USED TO BE ONE PERSON'S VAULT, HARDCODED. It carried
 * `graphify-out/`, `System/Skills/gstack/`, `System/Skills/skill-router/`,
 * `System/Skill Sources/`, `Templates/` and `Inbox/` — ported from a note
 * server's `links.py`, where they had been tuned against a single vault. Point
 * the app at anyone else's folder and it silently dropped every file under a
 * folder called `Templates` or `Inbox`, which are Obsidian's OWN conventions
 * and ship in its default vault. Measured on an ordinary ten-note vault:
 * 4 files invisible, and `checkRoots()` reported no problem at all.
 *
 * A note app that only indexes one particular person's folder layout is not a
 * note app. So the vault-specific entries are gone, and per-vault exclusions
 * come from the mechanism that already exists and that users already control:
 * `.obsidian/app.json` → `userIgnoreFilters`, read by `ignoreFilters()` above,
 * re-anchored per vault. That is the same setting Obsidian's own
 * "Files and links → Excluded files" writes, so the two apps agree without the
 * user configuring anything twice.
 *
 * What is left is the app's OWN directory. `.backups/` is written by save();
 * indexing it would count every historical copy of a note as a separate note.
 * That is true of every vault because this app is what creates it.
 *
 * Trailing slash is load-bearing: a bare prefix also swallows any real note
 * whose name merely starts with it.
 */
const SKIP = ['.backups/']

/**
 * Does this path sit under a skipped prefix — at the root, or under ANY folder
 * in the tree.
 *
 * Matching mid-path rather than only at the root is what lets a vault opened
 * from its PARENT directory still exclude correctly: the moment the real path
 * became `Universal Vault/.backups/…`, a root-anchored prefix stopped matching
 * and every backup poured into the index. `/` on both sides keeps it on a
 * segment boundary, so `.backups/` cannot swallow `.backups-old/`.
 */
function isSkipped(p: string): boolean {
  // Every trailing segment-run of each prefix, so the list also matches when
  // the open root is BELOW where the prefix was written: `System/Skills/gstack/`
  // has to match `Skills/gstack/x.md` for someone who opened `System`. Same
  // failure as the vault's own filters — measured at 1179 notes against 13
  // links opening `Universal Vault\System` — and fixed the same way.
  return SKIP.some((s) => {
    if (p.startsWith(s) || p.includes(`/${s}`)) return true
    const parts = s.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const tail = `${parts.slice(i).join('/')}/`
      if (p.startsWith(tail) || p.includes(`/${tail}`)) return true
    }
    return false
  })
}

/**
 * The PREFERRED place reachability is measured from. `depth` is hops from
 * whichever root is actually chosen — see `pickRoot`.
 *
 * This used to be the only answer, and its absence was silent and total. A
 * vault whose root note is called anything else, or which sits one directory
 * below the configured root, has no `Home.md` at the top level — so the BFS
 * started from a node that is not in the graph, visited nothing, and left
 * every single note with `depth: null` and `orphan: true`. Measured here with
 * `vaultDir` set one level too high: 0 of 1419 notes had a depth and 1419 of
 * 1419 were flagged orphan. The Orphans filter was selecting the whole vault
 * and reporting it as a finding.
 */
const ROOT_NOTE = 'Home.md'

/**
 * Where reachability is measured from, in order of preference:
 *
 *   1. `Home.md` at the vault root — the pinned answer, and still the one the
 *      vault is designed around.
 *   2. the SHALLOWEST `Home.md` anywhere below it. A vault opened from its
 *      parent still has its index note; it is just one directory down now, and
 *      refusing to see it there is how "reachability" became "every note is an
 *      orphan" the moment the root moved up a level.
 *   3. the note with the most inbound links — the empirical hub. A folder
 *      without a declared index still has a note everything points at, and
 *      measuring from it gives a far more useful answer than measuring from
 *      nowhere.
 *   4. null, only when NOTHING links to anything.
 *
 * Ties break on path so the choice is stable between runs; a root that moved
 * every rescan would make `depth` flicker for no visible reason.
 *
 * Exported for the test, which pins the ordering rather than the outcome.
 */
export function pickRoot(
  notes: { path: string }[],
  inbound: Map<string, number>,
): string | null {
  if (notes.some((n) => n.path === ROOT_NOTE)) return ROOT_NOTE

  // Shallowest first, then lexicographic — the same stability rule as the
  // inbound-count fallback below, and for the same reason. Two vaults side by
  // side under one root each have a Home.md; picking by depth means the one
  // nearer the top wins rather than whichever the walk happened to reach first.
  let home: string | null = null
  let homeDepth = Infinity
  for (const n of notes) {
    if (!n.path.endsWith(`/${ROOT_NOTE}`)) continue
    const d = n.path.split('/').length
    if (d < homeDepth || (d === homeDepth && n.path < home!)) {
      home = n.path
      homeDepth = d
    }
  }
  if (home !== null) return home

  let best: string | null = null
  let bestCount = 0
  for (const n of notes) {
    const c = inbound.get(n.path) ?? 0
    if (c > bestCount || (c === bestCount && c > 0 && n.path < best!)) {
      best = n.path
      bestCount = c
    }
  }
  return bestCount > 0 ? best : null
}

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
/**
 * Returns each note's WIKILINK NAMES, not its text, and that is a memory fix
 * rather than a tidy-up.
 *
 * Every note's full text used to be held simultaneously, for the whole of
 * `buildIndex`, because the link pass ran later. The only thing that pass ever
 * did with the text was `parseWikilinks(text)`, so the entire corpus was
 * resident to produce a handful of short strings per file. Pointing the vault
 * at `AppData\Local\Temp` — 12 000 markdown files — peaked at 856 MB in the
 * MAIN process, which on a 6 GB-VRAM, 32 GB machine running Electron plus a
 * model is not a theoretical cost.
 *
 * Extracting at read time and dropping the text keeps peak memory proportional
 * to the LINKS in a vault rather than to its bytes. Nothing downstream wanted
 * the text: `parseFrontmatter` already ran here too.
 */
async function scan(): Promise<{ note: VaultNoteMeta; names: string[] }[]> {
  const { readFile, stat } = await import('node:fs/promises')
  const { join } = await import('node:path')

  // Both kinds: a `file` becomes a row with no text, so a folder of images is
  // a list of images rather than an empty database. Only `note` is read.
  const paths: { path: string; text: boolean }[] = []
  const collect = (n: VaultTreeNode): void => {
    if (n.kind === 'note') paths.push({ path: n.path, text: true })
    else if (n.kind === 'file') paths.push({ path: n.path, text: false })
    n.children?.forEach(collect)
  }
  collect(await tree())
  const keep = paths.filter((p) => !isSkipped(p.path))

  const out: { note: VaultNoteMeta; names: string[] }[] = []
  // Bounded rather than `Promise.all` over every path: a vault in the low
  // thousands opens that many file handles at once and takes EMFILE, which
  // fails the whole index instead of one note. Same worker-pool shape the HTTP
  // version needed, for a different reason.
  const LIMIT = 16
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < keep.length) {
      const { path, text: readable } = keep[cursor++]
      let text = ''
      if (readable) {
        try {
          /**
           * Size checked BEFORE the read, because the read is the thing that
           * hurts. Unknown extensions are treated as text (see BINARY_EXT), so
           * this is what stands between "index any file type" and pulling a
           * 4 GB `.log` or a mislabelled disk image into memory. 2 MB is far
           * above any real note — the largest in the vault is 190 KB — and far
           * below anything that threatens the main process.
           *
           * Oversized files are not skipped, only unread: the row still
           * appears, it simply contributes no links. Vanishing from the
           * explorer is the failure mode this whole change exists to remove.
           */
          const st = await stat(join(VAULT_DIR, path))
          if (st.size <= MAX_TEXT_BYTES) text = await readFile(join(VAULT_DIR, path), 'utf8')
        } catch {
          // Deleted between the walk and the read, or unreadable. A row with no
          // text is still the truth that the file was there; failing the whole
          // index for one bad file never is.
        }
      }
      const fm = parseFrontmatter(text)
      const cut = path.lastIndexOf('/')
      out.push({
        // Parsed HERE so `text` becomes garbage at the end of this iteration
        // instead of living until the index is finished. See the header.
        names: linkTargets(text, path),
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
          tags: parseList(fm.tags ?? ''),
          depth: null, // filled by the BFS in buildIndex
          orphan: false,
          reachRoot: null, // chosen once per index, by pickRoot
          links: 0, // both filled by buildIndex, once the edges are resolved
          backlinks: 0,
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

  /**
   * TWO tiers, and every candidate kept rather than the first one to arrive.
   *
   * This was one flat `Map<string, string>` with a first-wins `add()`, which
   * silently made link resolution depend on scan order. It is fine while names
   * are unique and it falls apart the moment they are not: on this machine 34
   * filename stems are claimed by more than one note and `skill` is claimed by
   * **633** of them, so `[[Skill]]` resolved to whichever `SKILL.md` happened
   * to sort first and every other reference to it was simply wrong. That is
   * why the link count could FALL while the note count rose fivefold.
   *
   * Keeping the candidates lets `resolve()` below pick the way Obsidian does —
   * by proximity to the note doing the linking — instead of by accident. The
   * two tiers preserve the existing rule that a real FILENAME always beats
   * somebody else's frontmatter title.
   */
  const byFile = new Map<string, string[]>()
  const byAlias = new Map<string, string[]>()
  /**
   * THIRD tier: every trailing path segment-run, so a PATH-FORM wikilink still
   * resolves when the vault is opened from above it.
   *
   * `[[Daily/_Template|Daily Template]]` is a path relative to ITS vault's
   * root. Registering only `n.path` means the key is whatever this walk's root
   * makes it — open Universal Vault directly and the key is `daily/_template`
   * and the link resolves; open Desktop and the key becomes
   * `universal vault/daily/_template` while the link still says
   * `daily/_template`, so it matches nothing at all.
   *
   * That was the last root-anchored assumption, and it was expensive precisely
   * because it failed SILENTLY: resolve() returned undefined, the edge was
   * simply not created, and the graph lost 100 of the vault's 657 edges with no
   * error anywhere — including every one of the ~68 skill links out of
   * `Fate/Skills Index.md`. Measured by diffing the two link sets: 100 lost, 0
   * gained, so nothing was being mis-routed, it was being dropped.
   *
   * A SEPARATE tier rather than more keys in `byFile`, and consulted last, so
   * this can only ever ADD a resolution that would otherwise fail. An exact
   * filename and an exact full path both still win first, and no existing link
   * changes where it points — which is what keeps the single-vault numbers
   * identical (657 links either way).
   *
   * Deliberately more permissive than Obsidian, which would only accept the
   * form anchored at its own vault root: we do not know where the user thinks
   * the root is, and a suffix that lands on a segment boundary is a far better
   * guess than nothing. Collisions fall through to `choose()` and resolve by
   * proximity like every other duplicate name.
   */
  const bySuffix = new Map<string, string[]>()
  const add = (into: Map<string, string[]>, key: string, path: string) => {
    const k = norm(key)
    if (!k) return
    const list = into.get(k)
    if (!list) into.set(k, [path])
    else if (!list.includes(path)) list.push(path)
  }
  for (const n of notes) {
    add(byFile, titleOf(n.path), n.path) // "_START HERE"   — the common form
    add(byFile, n.path, n.path) // "Business/…/_START HERE.md" — full path
  }
  // Second pass: frontmatter titles are aliases, and must never shadow a real
  // filename that another note owns — hence a separate tier, not a later
  // insert into the same one.
  for (const n of notes) add(byAlias, n.title, n.path)
  // Third pass. Starts at 1: the whole path is already in `byFile` and the bare
  // filename is both there and meaningless as a "path form".
  for (const n of notes) {
    const parts = n.path.split('/')
    for (let i = 1; i < parts.length - 1; i++) add(bySuffix, parts.slice(i).join('/'), n.path)
  }

  /** The folder a note lives in, `''` at the vault root. */
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1)

  /**
   * Which of several same-named notes a link means.
   *
   * Obsidian's rule, and the only one that is not arbitrary: the nearest note
   * wins. A `[[Skill]]` inside `System/Skills/ponytail/` means the one in that
   * folder, not one of the other 632.
   *
   *   1. same folder as the linking note
   *   2. nearest ANCESTOR folder — a link from deep in a tree to a sibling
   *      index resolves upward before it jumps across the vault
   *   3. shallowest path, then lexicographic, so an unrelatable collision is at
   *      least STABLE. A resolution that reshuffles between rescans would make
   *      the graph rewire itself for no visible reason.
   */
  const choose = (cands: string[], from: string): string => {
    if (cands.length === 1) return cands[0]
    const home = dirOf(from)
    const same = cands.filter((c) => dirOf(c) === home)
    if (same.length) return same.sort()[0]
    // Longest shared prefix that ends on a folder boundary is the nearest
    // common ancestor, so the deepest such match is the closest note.
    let best: string | null = null
    let bestDepth = -1
    for (const c of cands) {
      const d = dirOf(c)
      if (!home.startsWith(d)) continue
      const depth = d.split('/').length
      if (depth > bestDepth || (depth === bestDepth && c < best!)) {
        best = c
        bestDepth = depth
      }
    }
    if (best) return best
    return [...cands].sort(
      (a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1),
    )[0]
  }

  const resolve = (name: string, from: string): string | undefined => {
    const k = norm(name)
    const file = byFile.get(k)
    if (file) return choose(file, from)
    const alias = byAlias.get(k)
    if (alias) return choose(alias, from)
    // Last: a path form that was written against a vault root above or below
    // this walk's root. See `bySuffix`.
    const suffix = bySuffix.get(k)
    return suffix ? choose(suffix, from) : undefined
  }

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
  for (const { note: n, names } of scanned) {
    for (const name of names) {
      // Resolved RELATIVE TO THE LINKING NOTE, so a duplicate filename means
      // the nearest one rather than the first one scanned.
      const target = resolve(name, n.path)
      if (!target || target === n.path) continue
      // `parseWikilinks` already dedups by NAME within a note; this dedups by
      // resolved TARGET, because [[Home]] and [[Home.md]] name one note.
      // Stringifying the pair sidesteps the separator question entirely.
      const key = JSON.stringify([n.path, target])
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      links.push({ from: n.path, to: target, kind: 'content' })
      // Adjacency, kept as the edges are found rather than rebuilt from
      // `links` afterwards, because the BFS below needs it and a second pass
      // over 20k edges to recover what we just computed is waste.
      const adj = out.get(n.path)
      if (adj) adj.push(target)
      else out.set(n.path, [target])
    }
  }

  /**
   * STRUCTURAL edges: the folder tree, as a graph.
   *
   * Everything above needs somebody to have written a link. Most folders on a
   * computer are not vaults and nobody has: measured across ten real locations,
   * `Pictures` gave 26 files and 0 links, `System32\drivers\etc` 5 and 0,
   * `Documents` 2 and 0, and a source tree managed 34 links across 83 files
   * with 81 of them still unreachable. Every one of those rendered as a field
   * of unconnected dots, which is what "the graph is broken everywhere except
   * my vault" actually looked like.
   *
   * The filesystem is the relationship that always exists. Each folder elects
   * one HUB — an index-like file if there is one, otherwise its first file by
   * name — every other file in that folder points at the hub, and each hub
   * points at its parent folder's hub. The result is a spanning tree over
   * whatever is there, so the graph is connected in any location without the
   * user creating a single link.
   *
   * Appended AFTER `inbound`, `depth` and `orphan` are computed from `out`
   * below, and tagged `structure`, so none of them can see these. A note nobody
   * links to is still an orphan and still reports 0 backlinks — it is simply
   * drawn where it lives instead of nowhere.
   */
  const INDEX_NAMES = ['home.md', 'index.md', '_index.md', 'readme.md', 'readme']
  const byFolder = new Map<string, string[]>()
  for (const n of notes) {
    const f = dirOf(n.path) // '' for the root, keeps the trailing slash
    const list = byFolder.get(f)
    if (list) list.push(n.path)
    else byFolder.set(f, [n.path])
  }

  /** The one file that stands for a folder. Deterministic, so it never flickers. */
  const hubOf = (folder: string): string | null => {
    const files = byFolder.get(folder)
    if (!files?.length) return null
    let best = files[0]
    let bestRank = Infinity
    for (const p of files) {
      const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase()
      const rank = INDEX_NAMES.indexOf(base)
      const r = rank === -1 ? INDEX_NAMES.length : rank
      if (r < bestRank || (r === bestRank && p < best)) {
        best = p
        bestRank = r
      }
    }
    return best
  }

  const hubs = new Map<string, string>()
  for (const f of byFolder.keys()) {
    const h = hubOf(f)
    if (h) hubs.set(f, h)
  }

  /**
   * The single file the whole tree hangs from.
   *
   * Without this the spanning tree does not span. `parentHub` walks up looking
   * for an ancestor folder that HOLDS a file, and a folder containing only
   * subfolders holds none — so in a tree like `System/Skills/<name>/SKILL.md`
   * every skill's hub climbed to `Skills/`, found nothing, climbed to the root,
   * found nothing, and gave up. Measured: 259 nodes in 64 disconnected
   * components with only 185 of the needed 258 edges, which on screen is the
   * same field of loose dots the structural edges exist to prevent.
   *
   * Shallowest folder wins, ties broken on name, so the anchor is stable across
   * rescans rather than dependent on Map insertion order.
   */
  let globalHub: string | null = null
  {
    let bestFolder: string | null = null
    for (const f of hubs.keys()) {
      if (
        bestFolder === null ||
        f.split('/').length < bestFolder.split('/').length ||
        (f.split('/').length === bestFolder.split('/').length && f < bestFolder)
      ) {
        bestFolder = f
      }
    }
    globalHub = bestFolder === null ? null : (hubs.get(bestFolder) ?? null)
  }

  /** Nearest ancestor folder that actually holds a file, so empty tiers are skipped. */
  const parentHub = (folder: string): string | null => {
    let f = folder
    while (f) {
      f = f.slice(0, f.lastIndexOf('/', f.length - 2) + 1)
      const h = hubs.get(f)
      if (h) return h
      if (!f) break
    }
    // No ancestor holds a file. Attach to the tree's anchor rather than
    // floating: an unattached hub strands its entire subtree.
    return globalHub
  }

  const structural: VaultGraph['links'] = []
  const addStructural = (from: string, to: string) => {
    if (!to || from === to) return
    const key = JSON.stringify([from, to])
    if (seenEdges.has(key)) return // an author already said this; theirs wins
    seenEdges.add(key)
    structural.push({ from, to, kind: 'structure' })
  }
  for (const [folder, files] of byFolder) {
    const hub = hubs.get(folder)
    if (!hub) continue
    for (const p of files) if (p !== hub) addStructural(p, hub)
    const up = parentHub(folder)
    if (up) addStructural(hub, up)
  }

  /**
   * Inbound edge count. `out` is the outbound half and already exists for the
   * BFS; this is the only thing the relation columns need that is not already
   * built, and it is one pass over `links` rather than a second index.
   *
   * Counts RELATIONSHIPS, not mentions: `links` is deduped by resolved
   * (from, target) pair above, so a note that says [[Home]] twelve times
   * contributes 1 here — the same edge the graph draws.
   *
   * Built BEFORE the BFS now, because `pickRoot` needs it to find the hub when
   * there is no Home.md to start from.
   */
  const inbound = new Map<string, number>()
  for (const l of links) inbound.set(l.to, (inbound.get(l.to) ?? 0) + 1)

  /**
   * R6 reachability: hops from the root, following links outward.
   *
   * Obsidian links are directional but browsing is not — if A links to B a
   * person can get from A to B — so only outbound edges are walked, matching
   * the server's `links.reach()`. `orphan` is the invariant the vault is
   * actually graded on: not reachable from the root within 2 hops.
   *
   * The root is CHOSEN rather than assumed — see `pickRoot`. A null root means
   * nothing links to anything, and then every note genuinely is unreachable;
   * that is the one case where flagging them all is the truth rather than a
   * bug, and `checkRoots()` says so at boot.
   */
  const reachRoot = pickRoot(notes, inbound)
  const depth = new Map<string, number>()
  if (reachRoot !== null) {
    depth.set(reachRoot, 0)
    const queue = [reachRoot]
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]
      for (const next of out.get(cur) ?? []) {
        if (depth.has(next)) continue
        depth.set(next, depth.get(cur)! + 1)
        queue.push(next)
      }
    }
  }

  for (const n of notes) {
    const d = depth.get(n.path)
    n.depth = d ?? null
    n.orphan = d === undefined || d > 2
    n.links = out.get(n.path)?.length ?? 0
    n.backlinks = inbound.get(n.path) ?? 0
    // Carried on every row rather than as a separate call. It is one short
    // string on a payload that already exists, and it is what lets the Orphans
    // control name what it measured from instead of implying a root that may
    // not be there — the same "the wire format did not change, only what we
    // admit is on it" move `folder` and `orphan` already made.
    n.reachRoot = reachRoot
  }

  /**
   * Structural edges join the GRAPH here — after every count above, on purpose.
   *
   * `inbound`, `out`, `depth`, `orphan`, `links` and `backlinks` have all been
   * taken from content edges alone by this point, so adding these changes what
   * is DRAWN and nothing that is measured. Doing it earlier would have quietly
   * emptied the Orphans filter and set every "How linked" bucket to at least
   * one, which is a real feature traded away for a cosmetic win.
   */
  const value: VaultIndex = {
    notes,
    graph: { nodes: notes.map((n) => n.path), links: [...links, ...structural] },
  }
  indexCache = { at: Date.now(), value }
  return value
}

export async function backlinks(path: string): Promise<string[]> {
  const g = await graph()
  return [...new Set(g.links.filter((l) => l.to === path).map((l) => l.from))]
}
