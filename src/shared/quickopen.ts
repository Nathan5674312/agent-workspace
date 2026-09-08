/**
 * QUICK OPEN: finding a note by its NAME, as fast as you can type it.
 *
 * This is the other half of search and it is a different question. `search()`
 * in vault.ts answers "which notes say this?" and reads the vault to do it.
 * This answers "which note is called this?", which the app already knows —
 * `vault.tree()` is in memory in the renderer — so it runs on every keystroke
 * without touching the disk, and that is the whole reason it is a separate
 * thing rather than a mode of the search panel.
 *
 * SUBSEQUENCE, NOT SUBSTRING. Nobody types "Roadmap States" to reach
 * `roadmapStates`; they type "rmst". A subsequence match is what makes an
 * initialism work, and the scoring below is what stops it turning the vault
 * into noise: a letter that starts a word is worth far more than a letter in
 * the middle of one, and a run of adjacent letters is worth more than the same
 * letters scattered.
 *
 * Lives in `shared/` for the reason `search.ts` gives — `node --test` cannot
 * import a `.tsx`, and the ranking is the part worth testing.
 *
 * ponytail: no index, no dependency, no fuzzy library. It is a scan of the
 * note names already in memory, capped at `limit`, and a vault would need to
 * be very large indeed before that is the slow part of a keystroke.
 */

/** One note offered by quick open, with what matched, for highlighting. */
export type QuickHit = {
  path: string
  /** The note's name without its extension. What the row shows in bold. */
  title: string
  /** Higher is better. Only meaningful for comparing hits of one query. */
  score: number
  /**
   * Matched character positions, as [start, length] runs over `label`.
   * Runs rather than indices so the renderer draws one <mark> per run instead
   * of one per letter.
   */
  ranges: [number, number][]
  /**
   * What the ranges index into: the title, or the whole path when the query
   * contains a slash and is therefore about where the note lives.
   */
  label: string
}

/** `Fate/Roadmap/12 - Website.md` -> `12 - Website`. */
export function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Is a character the start of a word, given the one before it? */
function isBoundary(prev: string | undefined, ch: string): boolean {
  if (prev === undefined) return true
  if (/[\s\-_/.[\]()]/.test(prev)) return true
  // camelCase and PascalCase: a capital after a lower-case letter starts a word.
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase()
}

/**
 * Score one candidate against one query, or null when the query's letters do
 * not appear in order at all.
 *
 * The numbers are ordinal, not physical: what matters is that a boundary hit
 * outweighs any number of interior hits, so `rmst` puts `roadmapStates` above
 * a note whose name merely contains r, m, s and t somewhere.
 */
function scoreOne(
  candidate: string,
  query: string,
  preferBoundary: boolean,
): { score: number; ranges: [number, number][] } | null {
  const hay = candidate.toLowerCase()
  const needle = query.toLowerCase()
  if (needle === '') return { score: 0, ranges: [] }

  const ranges: [number, number][] = []
  let score = 0
  let from = 0
  let previousEnd = -1

  for (let qi = 0; qi < needle.length; qi++) {
    let at = hay.indexOf(needle[qi], from)
    if (at === -1) return null
    /**
     * TAKE THE LETTER THAT STARTS A WORD, not merely the next one.
     *
     * MEASURED on the real vault: `wad` ranked `USB WiFi Adapter Problem`
     * above `12 - Website and Domain`, which is the note whose initials those
     * literally are. The earliest `d` after `Website and` is the one at the end
     * of `and`, so the third letter scored as an interior hit and the
     * initialism lost to a coincidence. Looking ahead for a boundary `d` finds
     * `Domain`.
     *
     * Greedy either way, so this is run as a SECOND pass rather than as the
     * rule: skipping ahead can strand a later letter that only existed in the
     * part just skipped. `quickOpen` keeps whichever pass scores higher, so the
     * bias can only improve a result, never lose one.
     */
    if (preferBoundary && !isBoundary(candidate[at - 1], candidate[at])) {
      for (let j = at + 1; j < candidate.length; j++) {
        if (hay[j] !== needle[qi]) continue
        if (isBoundary(candidate[j - 1], candidate[j])) {
          at = j
          break
        }
      }
    }

    const boundary = isBoundary(candidate[at - 1], candidate[at])
    const adjacent = at === previousEnd
    score += boundary ? 12 : 1
    if (adjacent) score += 6
    // Early in the name beats late in it, gently: a tie-break, not a rule.
    if (at < 4) score += 2

    if (adjacent && ranges.length > 0) ranges[ranges.length - 1][1]++
    else ranges.push([at, 1])

    previousEnd = at + 1
    from = at + 1
  }

  // The whole name, exactly. Worth more than any accumulation of parts.
  if (hay === needle) score += 100
  else if (hay.startsWith(needle)) score += 40

  // A shorter name containing the same letters is the more specific answer.
  score -= Math.min(candidate.length, 60) / 10

  return { score, ranges }
}

/**
 * The notes worth offering for `query`, best first.
 *
 * A query containing `/` is about the PATH — "roadmap/12" — so it is matched
 * against the whole path and the row highlights the path. Otherwise only the
 * note's name is considered, because matching the path silently would rank
 * every note in a folder called `fate` above the note actually named `Fate`.
 *
 * An empty query returns the first `limit` paths in the order given, which is
 * tree order: the palette opens with something in it rather than a blank box.
 */
export function quickOpen(paths: string[], query: string, limit = 20): QuickHit[] {
  const q = query.trim()
  const byPath = q.includes('/')

  if (q === '') {
    return paths.slice(0, limit).map((path) => ({
      path,
      title: titleOf(path),
      score: 0,
      ranges: [],
      label: titleOf(path),
    }))
  }

  const hits: QuickHit[] = []
  for (const path of paths) {
    const title = titleOf(path)
    const label = byPath ? path : title
    // Both passes, best wins: see the note in scoreOne on why the
    // boundary-preferring one cannot simply replace the plain one.
    const plain = scoreOne(label, q, false)
    const boundary = scoreOne(label, q, true)
    const scored =
      plain && boundary ? (boundary.score > plain.score ? boundary : plain) : (plain ?? boundary)
    if (!scored) continue
    hits.push({ path, title, score: scored.score, ranges: scored.ranges, label })
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return hits.slice(0, limit)
}
