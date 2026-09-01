/**
 * What "search" MEANS, as pure functions over strings.
 *
 * Lives in `shared/` for the reason `daily.ts` and `templates.ts` give: a `.tsx`
 * module cannot be imported by the `node --test` suite, because type stripping
 * does not handle JSX. The matching rules are the part worth testing, so they
 * live where they can be tested — and both processes need them, because main
 * finds the hits and the renderer highlights them.
 *
 * ── THIS IS A LINEAR SCAN, AND THAT IS A DELIBERATE FIRST VERSION ──
 *
 * `Fate/Roadmap/02 - Search and Retrieval` settles on one SQLite file with FTS5
 * plus `sqlite-vec`, and that is still the right destination. It is also a
 * dependency, a schema, an incremental-update story and a migration, none of
 * which the Search panel needs in order to stop being a placeholder that says
 * "not built yet". Reading the vault per query is what the main process already
 * does on every index build, so the cost is known rather than guessed.
 *
 * ponytail: linear scan, no index. Move to FTS5 when a query on a real vault is
 * slow enough to notice — `searchVault` in src/main/vault.ts is the one place
 * that would change, because everything here is about a single string.
 */

/** One matching line inside one note. */
export type SearchHit = {
  /** 0-based line number, so it can be handed straight to the editor's anchor. */
  line: number
  /** The whole line, trimmed and capped. What the user reads in the results. */
  text: string
  /** Offset of the match INSIDE `text`, for highlighting. -1 for a title-only hit. */
  at: number
  /** Length of the matched run, so highlighting does not re-do the matching. */
  length: number
}

/** Every hit in one note, plus why the note itself matched. */
export type NoteHits = {
  path: string
  title: string
  /** True when the query matched the note's NAME, independent of its body. */
  titleMatch: boolean
  hits: SearchHit[]
  /** Hits found beyond `perNote`, so the UI can say "+7 more" honestly. */
  truncated: number
}

/**
 * How long a result line may be before it is cut.
 *
 * A vault contains generated files, minified payloads and one-line JSON, and a
 * 40 000-character "line" in a results list is not a result, it is a hang. The
 * cut is centred on the match rather than taken from the start, or a hit at
 * column 9 000 would show 200 characters that do not contain it.
 */
export const SNIPPET_MAX = 240

/** Ellipsis characters, counted so the caller need not know the shape. */
const ELLIPSIS = '…'

/**
 * Normalise a query. Empty means "no search", which is different from
 * "searched and found nothing" and the UI renders them differently.
 */
export function normalizeQuery(q: string): string {
  return q.trim()
}

/** Is this query worth running? One character matches most of a vault. */
export function isSearchable(q: string): boolean {
  return normalizeQuery(q).length >= 2
}

/**
 * Case-insensitive index-of, with no regex anywhere.
 *
 * A user's query is not a pattern and must never be compiled as one: `.` and
 * `*` are ordinary characters people type, and `(` alone would throw. Lowercase
 * comparison also keeps the OFFSETS valid against the original string, which a
 * normalising transform (accent folding, NFKD) would not — the offset is what
 * the highlight is drawn from.
 */
function indexOfCI(haystack: string, needle: string, from = 0): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from)
}

/** Does this note's name match? Checked separately so a rename is findable. */
export function titleMatches(title: string, query: string): boolean {
  const q = normalizeQuery(query)
  return q !== '' && indexOfCI(title, q) !== -1
}

/**
 * Cut a long line down to `SNIPPET_MAX`, keeping the match inside it.
 *
 * Returns the new text AND the match's offset within it, because the caller
 * highlights by offset and a naive slice silently invalidates every one.
 */
function snippet(line: string, at: number): { text: string; at: number } {
  if (line.length <= SNIPPET_MAX) return { text: line, at }

  // Keep a third of the window before the match so it has context on both sides.
  const lead = Math.floor(SNIPPET_MAX / 3)
  let start = Math.max(0, at - lead)
  let end = Math.min(line.length, start + SNIPPET_MAX)
  // Ran off the end: pull the window back rather than returning a short one.
  if (end - start < SNIPPET_MAX) start = Math.max(0, end - SNIPPET_MAX)

  const head = start > 0 ? ELLIPSIS : ''
  const tail = end < line.length ? ELLIPSIS : ''
  return { text: head + line.slice(start, end) + tail, at: at - start + head.length }
}

/**
 * Every matching line in one note's text.
 *
 * ONE HIT PER LINE, not per occurrence. A line naming the query four times is
 * one place to go, and four identical rows in the results is noise that pushes
 * the next note off the screen.
 *
 * `perNote` caps how many lines come back; the count beyond it is reported
 * rather than dropped silently, because "3 of 40" and "3" are different facts.
 */
export function searchText(text: string, query: string, perNote = 5): { hits: SearchHit[]; truncated: number } {
  const q = normalizeQuery(query)
  const hits: SearchHit[] = []
  let truncated = 0
  if (q === '') return { hits, truncated }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    // The trailing \r on a CRLF file is not part of the line the user sees.
    const raw = lines[i].replace(/\r$/, '')
    const at = indexOfCI(raw, q)
    if (at === -1) continue
    if (hits.length >= perNote) {
      truncated++
      continue
    }
    // Trim only the LEFT, and shift the offset by what was removed. Trimming
    // both ends is fine for display but the offset has to follow the text.
    const lead = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    const s = snippet(trimmed, at - lead)
    hits.push({ line: i, text: s.text, at: s.at, length: q.length })
  }
  return { hits, truncated }
}

/**
 * Rank notes for display.
 *
 * Title matches first, because a person searching "Roadmap" wants the note
 * called Roadmap before forty notes that mention the word. Then by hit count
 * descending — a note that says it once is weaker evidence than one that says
 * it nine times — and then by path, so the order is stable between identical
 * queries rather than depending on directory-walk timing.
 */
export function rankNotes(notes: NoteHits[]): NoteHits[] {
  return [...notes].sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1
    const an = a.hits.length + a.truncated
    const bn = b.hits.length + b.truncated
    if (an !== bn) return bn - an
    return a.path.localeCompare(b.path)
  })
}

/** Total lines across a result set, for the "N results in M notes" line. */
export function countHits(notes: NoteHits[]): number {
  return notes.reduce((n, x) => n + x.hits.length + x.truncated, 0)
}
