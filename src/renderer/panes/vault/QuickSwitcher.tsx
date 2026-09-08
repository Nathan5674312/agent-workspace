/**
 * QUICK SWITCHER — Ctrl+P, type three letters, Enter, you are in the note.
 *
 * THE OTHER SEARCH, AND DELIBERATELY NOT THE SAME ONE. The Search panel
 * answers "which notes say this?": it reads the vault, it runs on Enter, and
 * its results are lines. This answers "which note is called this?", which the
 * app already knows — `vault.tree()` is in memory, in this process — so it can
 * run on every keystroke without touching the disk, and the answer is a note
 * rather than a line. Two questions, two surfaces; folding them together would
 * make the fast one wait for the slow one.
 *
 * The ranking lives in `shared/quickopen.ts`, where `node --test` can reach it.
 * This file is the box, the list and the keys.
 *
 * NO TIMERS, on purpose and not by accident: `review-s2-vault-pane` bans them
 * across this folder because of the save path, and nothing here wants one. The
 * match runs synchronously against an array of strings that is already in
 * memory, so there is nothing to debounce.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Search as SearchIcon } from 'lucide-react'
import { quickOpen, type QuickHit } from '../../../shared/quickopen.js'
import type { VaultTreeNode } from '../../../shared/ipc.js'
import './quickswitcher.css'

export interface QuickSwitcherProps {
  /** The vault as the explorer already has it. Null while it is still loading. */
  tree: VaultTreeNode | null
  /** Open what was chosen. A `.canvas` is routed by the caller, as everywhere. */
  onOpen: (path: string) => void
}

/** How many rows the palette offers. More than fits is not more useful. */
const LIMIT = 20

/** Every note and board in the vault, as paths, in tree order. */
function collectPaths(node: VaultTreeNode | null): string[] {
  if (!node) return []
  const out: string[] = []
  const walk = (n: VaultTreeNode): void => {
    if (n.kind === 'note' || n.kind === 'canvas') out.push(n.path)
    n.children?.forEach(walk)
  }
  walk(node)
  return out
}

/**
 * One row's label with the matched letters marked.
 *
 * Built by SLICING on the ranges the matcher returned, never by injecting
 * HTML — the same rule the Search panel's rows follow, and what
 * `review-s2-vault-pane` fails this whole folder for.
 */
function Marked({ hit }: { hit: QuickHit }) {
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [start, length] of hit.ranges) {
    if (start > at) parts.push(hit.label.slice(at, start))
    parts.push(
      <mark className="qs-mark" key={start}>
        {hit.label.slice(start, start + length)}
      </mark>,
    )
    at = start + length
  }
  if (at < hit.label.length) parts.push(hit.label.slice(at))
  return <>{parts}</>
}

export function QuickSwitcher({ tree, onOpen }: QuickSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const paths = useMemo(() => collectPaths(tree), [tree])
  const hits = useMemo(() => quickOpen(paths, query, LIMIT), [paths, query])

  /**
   * Ctrl+P and Ctrl+O, both, because both are muscle memory: the first from
   * every editor, the second from Obsidian, which is the app most people
   * arriving here have just come from.
   *
   * Capture phase, so the palette answers even while the editor textarea has
   * focus — a bubbling listener would be reached only after the textarea has
   * had its way with the keystroke.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const chord = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
      if (chord && (e.key === 'p' || e.key === 'o')) {
        e.preventDefault()
        setQuery('')
        setAt(0)
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Focus follows opening. Without this the palette appears and the first
  // letter typed goes to whatever had focus before it, which on this pane is
  // the editor — so opening the switcher would edit the open note.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) return null

  const choose = (hit: QuickHit | undefined): void => {
    if (!hit) return
    setOpen(false)
    onOpen(hit.path)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // Wrapping, so the last row is one press from the first. A list of
      // twenty with a dead end at each end is a list you scroll past twice.
      const next = e.key === 'ArrowDown' ? at + 1 : at - 1 + hits.length
      setAt(hits.length === 0 ? 0 : next % hits.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      choose(hits[at])
    }
  }

  return (
    <div className="qs-scrim" onMouseDown={() => setOpen(false)}>
      {/* Stop the click that lands INSIDE the palette from closing it: the
          scrim is the dismiss surface, the card is not. */}
      <div
        className="qs-card"
        role="dialog"
        aria-modal="true"
        aria-label="Open a note by name"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="qs-field">
          <SearchIcon size={15} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={inputRef}
            className="qs-input"
            type="text"
            placeholder="Open a note by name…"
            value={query}
            spellCheck={false}
            aria-label="Note name"
            onChange={(e) => {
              setQuery(e.target.value)
              setAt(0)
            }}
            onKeyDown={onKeyDown}
          />
        </div>

        {hits.length === 0 ? (
          <p className="qs-empty">No note matches that.</p>
        ) : (
          <ul className="qs-list" role="listbox" aria-label="Matching notes">
            {hits.map((hit, i) => (
              <li key={hit.path}>
                {/* `onClick` first, before any prop holding an arrow function:
                    the pane's own guard matches `<button ...>` with a regex
                    that stops at the first `>`, and `=>` inside an earlier prop
                    hides the handler from it. The guard is worth keeping — it
                    has caught two dead buttons — so this is the cheap side to
                    give way. */}
                <button
                  type="button"
                  onClick={() => choose(hit)}
                  className={i === at ? 'qs-row qs-row--on' : 'qs-row'}
                  role="option"
                  aria-selected={i === at}
                  onMouseEnter={() => setAt(i)}
                  title={hit.path}
                >
                  <span className="qs-row-name">
                    <Marked hit={hit} />
                  </span>
                  {/* The folder, so two notes with one name are told apart.
                      Hidden when the query was about the path, because then
                      the label above already IS the path. */}
                  {hit.label === hit.title && hit.path.includes('/') && (
                    <span className="qs-row-where">
                      {hit.path.slice(0, hit.path.lastIndexOf('/'))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        <p className="qs-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> to move · <kbd>↵</kbd> to open · <kbd>esc</kbd> to dismiss
        </p>
      </div>
    </div>
  )
}
