/**
 * Left icon ribbon — the surface you are working in, and nothing else.
 *
 * THE RULE THIS FILE NOW OBEYS: the ribbon picks the SURFACE; the sidebar
 * finds what you open in it. Nothing appears in both.
 *
 * It did not obey one before, and that was the app's largest structural
 * problem rather than a detail. There were three navigation systems — this
 * ribbon, a second unlabelled strip of text buttons inside the main area
 * (`vault-view-controls` in MainCanvas), and the tabs — and no rule said which
 * one a destination belonged to. The result, on screen at the same time:
 *
 *   - Graph and Canvas appeared in BOTH the ribbon and the main strip, four
 *     inches apart, styled as an icon column and as bare text, so the two
 *     controls for one destination did not look related.
 *   - Versions and Graph were ribbon icons that changed the MAIN view and left
 *     the sidebar alone. Calendar changed both. The other four changed only the
 *     sidebar. Three of eight icons did not do what the icon beside them did.
 *   - Database, Inbox and Roadmap had no ribbon entry at all and were reachable
 *     only from the strip you could not see until you were already there.
 *
 * The tell was in the state: <VaultPane> held `activeRibbon` AND `ribbonPressed`
 * — two variables for one selection, because "which icon is lit" and "which
 * panel is showing" had stopped being the same question. One list with one rule
 * is why that pair is now a single value.
 *
 * Icons are Lucide SVGs stroked with `currentColor`. They replace the emoji
 * placeholders, which could not be themed at all: an emoji is an OS-supplied
 * colour raster, so it ignores `color`, takes no stroke weight, and sits on its
 * own baseline. No stylesheet could ever have made them match.
 */
import {
  Calendar,
  FileText,
  Frame,
  History,
  Inbox,
  SquareTerminal,
  Table2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'

import type { MainView } from './MainCanvas.js'

export interface LeftRibbonProps {
  /** The surface the active tab is on. One value, one lit icon. */
  surface: MainView
  onSurfaceChange: (surface: MainView) => void
  /**
   * How many items are waiting in the inbox, or null before it has looked.
   *
   * The badge came with the Inbox when it moved out of the deleted strip, and
   * it had to: "the count is the point of a queue -- it has to be legible
   * without opening the tab, or nobody opens the tab". Promoting the surface
   * and leaving the count behind would have been a feature regression wearing
   * a refactor's clothes.
   *
   * `null` rather than 0 while unknown, for the reason the old strip gave: a
   * badge reading 0 before anything has looked is a false all-clear.
   */
  inboxCount: number | null
}

/**
 * Every surface the app has, in the order they are reached for, in three
 * groups separated by a rule.
 *
 * `group` is the only reason this is not a flat array: nine icons in an
 * undifferentiated column is a list you read rather than a shape you learn,
 * and the third group is not about the vault at all.
 *
 *   vault    what your notes are, seen six ways
 *   tools    things you do to a note rather than views of the vault
 *
 * ROADMAP IS NOT HERE, and it is the second icon removed rather than moved.
 * Fate is a notes app with an agent in it, so this column is about YOUR NOTES;
 * the roadmap is the app grading itself, which is a question you ask from the
 * help dialog rather than a place you go to work. The VIEW still exists and is
 * unchanged — `HelpDialog` opens it — so what left the ribbon is an entry
 * point, not a feature. A column where eight icons are about your vault and
 * one is about the software is the same category error, one icon wide, that
 * the second navigation strip was.
 *
 * EDITOR HAS AN ICON NOW. The old main strip deliberately omitted one, on the
 * grounds that "a button that only ever showed the note you already opened was
 * a row of pixels doing nothing". That was true of a control sitting next to
 * the note; it is false of this one. From the graph or the database there was
 * no way back to the note you were reading except to find it again, so the
 * omission cost a way home to save a button.
 *
 * PLUGINS IS STILL ABSENT, and it is the one icon deleted rather than moved.
 * The roadmap's own entry is the reason: "the agent is the plugin system and
 * the canvas is the render target. Building a JS plugin host would be choosing
 * Obsidian's supply-chain risk on purpose." It was not an unbuilt feature
 * waiting its turn, it was a promise the product had already decided not to
 * keep — and an icon that opens a panel saying "not built yet" for something
 * that will never be built is the inert control this ribbon exists to forbid.
 */
const SURFACES: {
  id: MainView
  label: string
  Icon: LucideIcon
  group: 'vault' | 'tools'
}[] = [
  { id: 'editor', label: 'Note', Icon: FileText, group: 'vault' },
  { id: 'graph', label: 'Graph', Icon: Waypoints, group: 'vault' },
  { id: 'canvas', label: 'Canvas', Icon: Frame, group: 'vault' },
  { id: 'database', label: 'Database', Icon: Table2, group: 'vault' },
  { id: 'planner', label: 'Planner', Icon: Calendar, group: 'vault' },
  { id: 'inbox', label: 'Inbox', Icon: Inbox, group: 'vault' },
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal, group: 'tools' },
  { id: 'versions', label: 'Versions', Icon: History, group: 'tools' },
]

/** Exported so the pane's test can assert every surface has exactly one icon. */
export const RIBBON_SURFACES = SURFACES.map((s) => s.id)

export function LeftRibbon({
  surface,
  onSurfaceChange,
  inboxCount,
}: LeftRibbonProps) {
  return (
    <nav className="vault-ribbon" aria-label="Surfaces">
      {SURFACES.map(({ id, label, Icon, group }, i) => (
        <div
          key={id}
          className={
            // A separator BEFORE the first icon of a new group, drawn on the
            // wrapper rather than as its own element so the flex column has no
            // child that is not a control.
            i > 0 && SURFACES[i - 1].group !== group
              ? 'vault-ribbon-slot vault-ribbon-slot--group'
              : 'vault-ribbon-slot'
          }
        >
          <button
            className={`vault-ribbon-icon ${surface === id ? 'vault-ribbon-icon--active' : ''}`}
            onClick={() => onSurfaceChange(id)}
            // The button carries the accessible name; the icon is decorative and
            // must not announce itself twice.
            aria-label={
              id === 'inbox' && inboxCount !== null && inboxCount > 0
                ? `${label}, ${inboxCount} waiting`
                : label
            }
            aria-pressed={surface === id}
            title={label}
          >
            <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
            {id === 'inbox' && inboxCount !== null && inboxCount > 0 && (
              /* aria-hidden: the count is already in the button's accessible
                 name below, and a screen reader reading the number twice is
                 worse than not drawing it. */
              <span className="vault-ribbon-badge" aria-hidden="true">
                {inboxCount}
              </span>
            )}
          </button>
        </div>
      ))}
    </nav>
  )
}
