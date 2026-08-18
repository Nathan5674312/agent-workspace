/**
 * Help — what this app actually does, for the "?" in the vault switcher.
 *
 * EVERY SENTENCE HERE IS CHECKED AGAINST THE CODE, and that is the only rule
 * this file has. A help dialog describing behaviour the app does not have is
 * worse than the disabled button it replaced: the button was merely useless,
 * and this would be confidently wrong. Two things in particular are easy to get
 * stale and are called out where they appear — there is no auto-save, and the
 * app no longer talks to a note server.
 *
 * No shortcuts section. Grep `onKeyDown` in this directory: the only handlers
 * are Escape and Tab inside dialogs. There are no app-level shortcuts, and
 * inventing a table of them would be the same defect one level up.
 *
 * A real <dialog> + showModal(), copied from SettingsDialog.tsx rather than
 * generalised out of it — two callers is not a <Modal> abstraction. What the
 * platform gives: focus in, Tab trapped, Escape, focus back to the "?" on
 * close, top layer. What it does not: backdrop-click dismissal.
 */
import { useEffect, useRef } from 'react'
import './help.css'

export interface HelpDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function HelpDialog({ isOpen, onClose }: HelpDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  /** Whether the press in flight began on the backdrop. A ref: the mouseup that
   *  reads it must not repaint anything in between. */
  const downOnBackdrop = useRef(false)

  /**
   * The element stays in the document when closed — a closed <dialog> is
   * `display: none` by UA rule, and close() is what hands focus back to the
   * button that opened this, which it can only do while still mounted.
   */
  useEffect(() => {
    if (!isOpen) return
    const el = dialogRef.current
    el?.showModal()
    return () => el?.close()
  }, [isOpen])

  return (
    <dialog
      className="help-overlay"
      ref={dialogRef}
      aria-labelledby="help-title"
      // The <dialog> IS the backdrop hit area; the panel is a child. Both ends
      // of the press must land on it, or a text selection dragged out of the
      // panel would dismiss the thing it was dragged out of.
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      }}
      // Escape arrives as `cancel`. preventDefault leaves the effect above as
      // the only thing that calls close(), so the element cannot drift out of
      // step with `isOpen`.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // `cancel` does not consume the keydown that produced it, and nothing
      // behind this dialog may act on the same Escape.
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <div className="help-panel">
        <h2 className="help-title" id="help-title">
          How this works
        </h2>

        <section className="help-section">
          <h3 className="help-heading">Saving</h3>
          <p className="help-text">
            There is no auto-save. Nothing is written to disk until you click
            Save. Closing a note, switching tabs or opening the graph will ask
            before discarding unsaved text, and the text you chose to discard
            stays recoverable below the editor until you open another note.
          </p>
        </section>

        <section className="help-section">
          <h3 className="help-heading">If a note changed underneath you</h3>
          <p className="help-text">
            Save refuses rather than overwrite. You are offered your version,
            the version on disk, or both concatenated with a marker between
            them. Whichever side loses is kept in “Discarded version” under the
            editor until you open a different note.
          </p>
        </section>

        <section className="help-section">
          <h3 className="help-heading">Links</h3>
          <p className="help-text">
            Write <code className="help-code">[[note name]]</code> to link a
            note. Matching ignores case and a trailing{' '}
            <code className="help-code">.md</code>, and both{' '}
            <code className="help-code">[[Name|what to call it]]</code> and{' '}
            <code className="help-code">[[Name#Heading]]</code> resolve to the
            note itself. Links out and links in are listed under the editor.
          </p>
        </section>

        <section className="help-section">
          <h3 className="help-heading">The six views</h3>
          <ul className="help-list">
            <li>
              <strong>Editor</strong> — the note's text, as plain markdown. No
              live preview.
            </li>
            <li>
              <strong>Versions</strong> — every pre-edit copy of the open note.
              Restoring one is a save, so it is itself undoable.
            </li>
            <li>
              <strong>Graph</strong> — notes as nodes, wikilinks as edges.
            </li>
            <li>
              <strong>Database</strong> — every note as a row, grouped and
              sorted by its frontmatter.
            </li>
            <li>
              <strong>Inbox</strong> — what agents captured but did not file.
            </li>
            <li>
              <strong>Roadmap</strong> — what is built, partial, and planned.
            </li>
          </ul>
        </section>

        <section className="help-section">
          <h3 className="help-heading">Where your notes are</h3>
          <p className="help-text">
            In the vault folder named in Settings, as ordinary markdown files
            this app reads and writes directly. Nothing is uploaded and no
            server is involved. Every overwrite leaves the previous text in a{' '}
            <code className="help-code">.backups</code> folder beside your
            notes, which is what the Versions view lists.
          </p>
        </section>

        <section className="help-section">
          <h3 className="help-heading">More detail</h3>
          <p className="help-text">
            The <code className="help-code">docs</code> folder in this project
            holds <code className="help-code">ACCESSIBILITY.md</code>,{' '}
            <code className="help-code">PRIVACY.md</code>,{' '}
            <code className="help-code">TERMS.md</code> and{' '}
            <code className="help-code">ARTWORK.md</code>. They are files on
            disk — there is no channel that opens one from in here.
          </p>
        </section>

        <div className="help-actions">
          <button className="help-close" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}
