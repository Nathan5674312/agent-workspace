/**
 * The Search sidebar panel — the first thing the Search ribbon icon has ever
 * shown other than a note saying it was not built.
 *
 * WHAT IT IS: a query box and a grouped result list. Notes with the query in
 * their NAME come first, then notes ranked by how many lines matched. Clicking
 * a line opens that note and lands on that line.
 *
 * IT SEARCHES ON SUBMIT, NOT AS YOU TYPE, and that is this pane's rule rather
 * than a shortcut. `review-s2-vault-pane` bans `setTimeout` outright across
 * every file here — the guard exists for the save path, but it is absolute on
 * purpose, and weakening a real guard so new code can pass it is how a guard
 * stops being one. A search box without a timer is a search box you press
 * Enter in, and for a query that reads the whole vault that is the honest
 * interaction anyway: one deliberate read per question, rather than one per
 * pause in typing.
 *
 * `vault.search` reads the vault per query — see the header of
 * `src/shared/search.ts` for why that is the right first version and what
 * replaces it. The two-character floor is `isSearchable`, shared with the main
 * process so the two cannot disagree about what is worth running.
 */
import { useEffect, useRef, useState } from 'react'
import { Search as SearchIcon, X } from 'lucide-react'
import { countHits, isSearchable, type NoteHits, type SearchHit } from '../../../shared/search.js'
import './search.css'

export interface SearchViewProps {
  /** Open a note and land on a line. `line` is 0-based, as the hit reports it. */
  onOpenHit: (path: string, line: number) => void
}

/**
 * One result line, with the matched run marked.
 *
 * Built by SLICING, never by injecting HTML. `at` and `length` come from the
 * matcher, so the highlight is drawn from where the match actually was rather
 * than by searching the string a second time in the renderer — and note text
 * reaching innerHTML is what review-s2 fails the whole pane for.
 */
function HitLine({ hit, onOpen }: { hit: SearchHit; onOpen: () => void }) {
  const before = hit.text.slice(0, hit.at)
  const match = hit.text.slice(hit.at, hit.at + hit.length)
  const after = hit.text.slice(hit.at + hit.length)
  return (
    /* The row is ONE clipped line, so the tooltip has to carry the text — the
       stylesheet says as much and this used to show only the line number,
       which meant a clipped row had nowhere to reveal what it had matched. */
    <button
      className="search-hit"
      onClick={onOpen}
      title={`Line ${hit.line + 1}: ${hit.text}`}
    >
      <span className="search-hit-line">{hit.line + 1}</span>
      <span className="search-hit-text">
        {before}
        <mark className="search-hit-mark">{match}</mark>
        {after}
      </span>
    </button>
  )
}

export function SearchView({ onOpenHit }: SearchViewProps) {
  const [query, setQuery] = useState('')
  /** The query the RESULTS are for, which is not the one being typed. */
  const [ran, setRan] = useState('')
  const [results, setResults] = useState<NoteHits[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /**
   * A run counter, so a slow query cannot overwrite a newer one.
   *
   * The usual `let live = true` cleanup belongs to an effect; this runs from a
   * handler, which has no cleanup. A ref that only ever goes up does the same
   * job: the answer is dropped unless it is still the newest question. Without
   * it, pressing Enter twice quickly can paint the first answer over the
   * second, which looks exactly like search returning the wrong results.
   */
  const runId = useRef(0)

  /** Focus on mount: the icon was pressed to type, so nothing else should have it. */
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = () => {
    const q = query
    if (!isSearchable(q)) return
    const id = ++runId.current
    setBusy(true)
    setRan(q)
    window.api.vault
      .search(q)
      .then((r) => {
        if (id !== runId.current) return
        setResults(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if (id !== runId.current) return
        setResults([])
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (id === runId.current) setBusy(false)
      })
  }

  const clear = () => {
    runId.current++
    setQuery('')
    setRan('')
    setResults(null)
    setError(null)
    setBusy(false)
    inputRef.current?.focus()
  }

  const total = results ? countHits(results) : 0
  /** Typed past the results: say so, rather than showing a stale count as live. */
  const stale = results !== null && query !== ran

  return (
    <div className="search-panel">
      {/* No <form>. Enter is handled on the input and the icon is a real button
          with its own onClick — implicit form submission does not fire reliably
          under synthesised input, and every control in this pane has to be
          verifiable by driving it. */}
      <div className="search-field">
        <button className="search-go" onClick={run} aria-label="Search" title="Search (Enter)">
          <SearchIcon size={14} aria-hidden="true" />
        </button>
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder="Search notes"
          aria-label="Search the vault"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run()
            if (e.key === 'Escape' && query !== '') clear()
          }}
        />
        {query !== '' && (
          <button className="search-clear" aria-label="Clear search" onClick={clear}>
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Five states, and they are genuinely different things to say. An empty
          box is not "no results", a short query is not a failed search, and a
          count from the previous query is not the count for this one. */}
      <p className="search-status" role="status">
        {error
          ? error
          : busy
            ? 'Searching…'
            : !isSearchable(query)
              ? query === ''
                ? 'Type a query and press Enter.'
                : 'Keep typing — two characters minimum.'
              : stale
                ? 'Press Enter to search.'
                : results === null
                  ? 'Press Enter to search.'
                  : results.length > 0
                    ? `${total} ${total === 1 ? 'result' : 'results'} in ${results.length} ${results.length === 1 ? 'note' : 'notes'}`
                    : 'No matches.'}
      </p>

      <div className="search-results">
        {results?.map((note) => (
          <section className="search-note" key={note.path}>
            {/* The note header opens the note at its top — a title match often
                IS the result, and then there is no line to land on. */}
            <button
              className="search-note-head"
              onClick={() => onOpenHit(note.path, 0)}
              title={note.path}
            >
              <span className="search-note-title">
                {note.title}
                {note.titleMatch && <span className="search-note-badge">name</span>}
              </span>
              <span className="search-note-path">{note.path}</span>
            </button>
            {note.hits.map((hit) => (
              <HitLine key={hit.line} hit={hit} onOpen={() => onOpenHit(note.path, hit.line)} />
            ))}
            {note.truncated > 0 && (
              <p className="search-note-more">+{note.truncated} more in this note</p>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
