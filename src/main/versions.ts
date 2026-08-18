/**
 * Version history: the pre-edit copies `save()` already leaves behind.
 *
 * This file only READS. It creates nothing, prunes nothing and restores
 * nothing — restore is a SAVE of an old text and belongs to `vault.save()`,
 * where the lost-update guard and the backup-before-overwrite rule live. A
 * "restore" implemented here as a file copy would bypass both, and would be the
 * one write in the app that can destroy a note with no backup and no conflict.
 *
 * Two on-disk layouts have to be listed, because the vault contains both:
 *
 *   NEW   `.backups/<vault-relative path>.<ISO stamp>`
 *         written by `backup()` in vault.ts — the directory tree is mirrored
 *         and a filesystem-safe ISO stamp is appended.
 *         e.g. `.backups/Projects/AI.md.2026-08-16T09-12-33-104Z`
 *
 *   OLD   `.backups/<stamp>__<path with / as __>`
 *         written by the retired Python note server — FLAT, stamp first,
 *         separators flattened.
 *         e.g. `.backups/20260815-183917-896552__Projects__Task Queue.md`
 *
 * vault.ts says the copies the old server left are "still where they were", and
 * they are, but not under the new NAME — a lister that knew only the new shape
 * would show an empty history for the notes with the longest one. Both are
 * matched here; neither can match the other's pattern, so nothing is listed
 * twice.
 *
 * The timestamp is the backup file's own `mtimeMs`, not the stamp parsed out of
 * its name. `copyFileSync` does not preserve times, so the copy's mtime IS the
 * moment the copy was taken — verified against the two legacy backups in the
 * real vault, whose mtimes match their stamps to the second. That is one key
 * both layouts can be sorted on, and it avoids guessing whether the old
 * server's stamp was UTC or local (its source is gone; the name carries no
 * zone).
 *
 * MAIN process only, like everything in vault.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
// `.ts`, not `.js`: this is a runtime import of a VALUE, and the test suite
// imports this module under `node --experimental-strip-types`, where `.js`
// names a file that does not exist. Same reason vault.ts imports wikilink.ts.
import { getVaultDir } from './vault.ts'
import type { NoteVersion } from '../shared/ipc.js'

/** Mirrors the literal in vault.ts `backup()` and in its SKIP list. */
const BACKUPS = '.backups'

function requirePath(path: unknown): string {
  if (typeof path !== 'string' || path === '') {
    throw new Error('vault: path must be a non-empty string')
  }
  return path
}

/**
 * Containment, against `.backups/` rather than the vault root.
 *
 * Same lexical rule as `resolveInVault()` in vault.ts and duplicated for the
 * same reason that one exists: the argument comes from the renderer, which is
 * untrusted, and nothing downstream re-checks it. It is not imported because
 * vault.ts does not export it and that file is off limits this hour — fold this
 * into a shared exported guard when it is free.
 *
 * Scoped tighter than the vault root on purpose: `versionText()` must be able
 * to read a backup and nothing else. Pointed at the root it would be a way to
 * read any note by a path the tree never offered.
 */
function resolveInBackups(rel: string): string {
  const root = resolve(getVaultDir(), BACKUPS)
  const abs = resolve(root, rel)
  const inside = relative(root, abs)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('vault: path escapes the backups directory')
  }
  return abs
}

/**
 * Every backup of one note, newest first.
 *
 * A missing `.backups/` is not an error — it is a vault nothing has been saved
 * in yet, and the honest answer is an empty history. Only a note that has never
 * been overwritten has none.
 */
export async function versions(path: string): Promise<NoteVersion[]> {
  const rel = requirePath(path)
  // Refuse a climbing path here, before it is turned into two name patterns.
  resolveInBackups(rel)
  const root = resolve(getVaultDir(), BACKUPS)

  const out: NoteVersion[] = []
  const file = basename(rel)
  const flat = `__${rel.split('/').join('__')}`
  collect(join(root, dirname(rel)), (n) => n.startsWith(`${file}.`), root, out)
  collect(root, (n) => n.endsWith(flat), root, out)

  // Newest first. `at` is the sort key both layouts share; the id breaks ties
  // so the order is stable when two copies land in the same millisecond.
  out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
  return out
}

function collect(
  dir: string,
  match: (name: string) => boolean,
  root: string,
  out: NoteVersion[],
): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // No `.backups/`, or no mirrored folder for this note yet. Both mean "no
    // versions", and neither is worth failing the panel over.
    return
  }
  for (const e of entries) {
    if (!e.isFile() || !match(e.name)) continue
    const abs = join(dir, e.name)
    const st = statSync(abs, { throwIfNoEntry: false })
    if (!st) continue // deleted between the readdir and the stat
    out.push({
      // Forward slashes, so the id is the same string on every platform and can
      // be handed back over IPC unchanged.
      id: relative(root, abs).split(sep).join('/'),
      at: st.mtimeMs,
      size: st.size,
    })
  }
}

/**
 * The text of one backup, by the id `versions()` gave out.
 *
 * Errors are replaced rather than forwarded: `node:fs` puts the ABSOLUTE path
 * in every message and this one crosses IPC to the renderer, which is the leak
 * `scrub()` exists to stop in vault.ts. Nothing here needs the detail — there
 * is exactly one interesting failure and it is "that copy is gone".
 */
export async function versionText(id: string): Promise<string> {
  const abs = resolveInBackups(requirePath(id))
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    throw new Error('vault: that version could not be read')
  }
}
