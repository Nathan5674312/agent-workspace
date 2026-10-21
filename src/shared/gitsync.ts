/**
 * THE RULES OF KEEPING A VAULT AND ITS GITHUB REPO THE SAME, as pure functions.
 *
 * main/vaultSync.ts runs git; this decides. Kept apart so the decisions are
 * tested without a repository, and so the one rule that matters cannot drift:
 * NOTHING IS EVER LOST. The vault's own design note for sync (20 - Local
 * Network Sync) sets it, and so does the 2026-08-08 rule it cites — never
 * silently overwrite:
 *   - Both sides changed a note: ours stays, theirs is kept beside it as
 *     `note (conflict 2026-10-21 github).md`. Ugly at worst, never lossy.
 *   - One side deleted, the other edited: the edit survives. A deletion is the
 *     one change that is never allowed to win a conflict.
 *   - Never order by mtime across machines. Git's history orders; mtime is used
 *     for exactly one thing, on this machine only: "is someone still typing?"
 */

/** Commit local changes only when no changed file was touched for this long. */
export const QUIET_MS = 30_000

/** How often a running app pulls and pushes. */
export const INTERVAL_MS = 120_000

/** What the Settings dialog shows. */
export type SyncStatus = {
  enabled: boolean
  /** null until the first run has looked. */
  available: boolean | null
  /** Why sync cannot run here, in a sentence. Set when `available` is false. */
  why: string | null
  running: boolean
  lastAt: number | null
  lastError: string | null
  /** What the last successful run did, in words. */
  lastSummary: string | null
  /** Conflict copies the last run wrote, vault-relative. */
  conflicts: string[]
}

export const IDLE: SyncStatus = {
  enabled: false,
  available: null,
  why: null,
  running: false,
  lastAt: null,
  lastError: null,
  lastSummary: null,
  conflicts: [],
}

/**
 * `Notes/Plan.md` -> `Notes/Plan (conflict 2026-10-21 github).md`. A second
 * conflict on the same note the same day counts up rather than overwriting the
 * first copy, which would lose exactly what this exists to keep.
 */
export function conflictName(path: string, date: string, taken: (p: string) => boolean = () => false): string {
  const cut = path.lastIndexOf('/')
  const dir = cut === -1 ? '' : path.slice(0, cut + 1)
  const file = path.slice(cut + 1)
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot) : ''
  for (let n = 1; ; n++) {
    const p = `${dir}${stem} (conflict ${date} github${n === 1 ? '' : ` ${n}`})${ext}`
    if (!taken(p)) return p
  }
}

/**
 * Paths out of `git status --porcelain=v1 -z`. NUL-separated so a note named
 * with spaces, quotes or non-ASCII arrives intact; a rename carries its old
 * path as the next field, which is skipped.
 */
export function changedPaths(porcelainZ: string): string[] {
  const parts = porcelainZ.split('\0')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  return out
}

/**
 * Which side of a conflicted path survives, from which index stages exist.
 * Stage 2 is ours, stage 3 is theirs; a missing stage is a deletion.
 */
export function resolution(stages: { ours: boolean; theirs: boolean }): 'keep-both' | 'keep-ours' | 'keep-theirs' {
  if (stages.ours && stages.theirs) return 'keep-both'
  return stages.ours ? 'keep-ours' : 'keep-theirs'
}

/** One line for the status, from what a run did. */
export function summarise(r: { committed: number; pulled: number; pushed: number; conflicts: string[]; waiting: boolean }): string {
  const bits: string[] = []
  if (r.committed) bits.push(`committed ${r.committed} change${r.committed === 1 ? '' : 's'}`)
  if (r.pulled) bits.push(`pulled ${r.pulled} commit${r.pulled === 1 ? '' : 's'}`)
  if (r.pushed) bits.push(`pushed ${r.pushed} commit${r.pushed === 1 ? '' : 's'}`)
  if (r.conflicts.length) bits.push(`kept both sides of ${r.conflicts.length} conflict${r.conflicts.length === 1 ? '' : 's'}`)
  if (r.waiting) bits.push('waiting for edits to settle before committing')
  return bits.length ? `${bits.join(', ')}.` : 'Already in sync.'
}
