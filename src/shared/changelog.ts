/**
 * What changed between the running version and the one on offer.
 *
 * Pure, like `update.ts` beside it: this takes an already-parsed value and the
 * fetch, the JSON.parse and their failures belong to the caller. Everything is
 * checked, because this is data pulled off the public internet and the update
 * panel renders it next to a button that installs software.
 */

/** One file, and how much of it moved. `path` is the "location" a user reads. */
export type FileChange = { path: string; added: number; removed: number }

export type Changelog = {
  /** Subject lines, newest first — the order GitHub returns them in reverse. */
  commits: string[]
  files: FileChange[]
  added: number
  removed: number
  /**
   * GitHub caps a comparison at 250 commits and 300 files, and says so nowhere
   * in the payload except by omission. The panel promises a log of ALL the
   * changes, so it has to be able to say "and more" rather than quietly
   * present a prefix as the whole story.
   */
  truncated: boolean
}

/** Where the comparison lives. One line to repoint, for the same reason `UPDATE_FEED` is. */
export const compareUrl = (base: string, head: string): string =>
  `https://api.github.com/repos/Nathan5674312/agent-workspace/compare/${base}...${head}`

/** GitHub's own ceilings. Reaching one means the answer is a prefix. */
const MAX_COMMITS = 250
const MAX_FILES = 300

/** A commit subject longer than this is not a subject. Trimmed, never dropped. */
const SUBJECT_MAX = 120

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * The comparison, or null if it was not one.
 *
 * TOTALS ARE SUMMED FROM THE FILES RATHER THAN TRUSTED. The payload has no
 * total-lines field, and a per-file number that fails `isCount` is dropped, so
 * a total taken from anywhere else could disagree with the list printed under
 * it. A user reading "+40" above two files adding 15 each would be right to
 * distrust the rest of the panel.
 */
export function parseCompare(raw: unknown): Changelog | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>

  const rawCommits = Array.isArray(rec.commits) ? rec.commits : []
  const rawFiles = Array.isArray(rec.files) ? rec.files : []

  const commits: string[] = []
  for (const c of rawCommits) {
    const message = (c as { commit?: { message?: unknown } })?.commit?.message
    if (typeof message !== 'string') continue
    const subject = message.split('\n', 1)[0].trim()
    if (subject) commits.push(subject.slice(0, SUBJECT_MAX))
  }

  const files: FileChange[] = []
  let added = 0
  let removed = 0
  for (const f of rawFiles) {
    const rf = f as Record<string, unknown>
    if (typeof rf?.filename !== 'string' || !rf.filename) continue
    if (!isCount(rf.additions) || !isCount(rf.deletions)) continue
    files.push({ path: rf.filename, added: rf.additions, removed: rf.deletions })
    added += rf.additions
    removed += rf.deletions
  }

  // `total_commits` counts the whole range; `commits` stops at 250.
  const total = isCount(rec.total_commits) ? rec.total_commits : rawCommits.length
  const truncated =
    total > rawCommits.length || rawCommits.length >= MAX_COMMITS || rawFiles.length >= MAX_FILES

  // A comparison with nothing in it is not a changelog to show. `status: identical`
  // lands here too, which is right: there is no update to describe.
  if (commits.length === 0 && files.length === 0) return null

  return { commits, files, added, removed, truncated }
}
