import { useEffect, useRef, useState } from 'react'
import type { VaultNoteBody } from '../../../shared/ipc.js'
import type { WikilinkRef } from './helpers.js'
import {
  anchorLine,
  ensureBlockId,
  isSaveConflict,
  lineOfOffset,
  lineRange,
  parseWikilinkRefs,
} from './helpers.js'

/**
 * Plain <textarea> editor for notes.
 * v1 features: read, edit, save, wikilinks, backlinks, conflict detection.
 * No live preview, no CodeMirror, no plugins.
 *
 * The buffer is a CONTROLLED prop owned by <VaultPane>. This component must not
 * hold the text itself — it unmounts when the canvas switches to the graph, and
 * a buffer that dies with it is silent data loss. There is no auto-save here:
 * the only call to onSave is the Save button's onClick.
 */
export interface EditorProps {
  note: VaultNoteBody | null
  text: string
  onTextChange: (text: string) => void
  isDirty: boolean
  onSave: (text: string, mtime: number) => Promise<void>
  onConflict: (diskMtime: number, diskText: string) => void
  backlinks: string[]
  onOpenNote: (path: string) => void
  onOpenWikilink: (link: WikilinkRef) => void
  discarded: { label: string; text: string } | null
  /**
   * Where in the open note to land, from the `#…` of the link that opened it.
   *
   * The `nonce` is not decoration. Following the same reference twice is a real
   * thing to do — you scrolled away and want to go back — and on a bare string
   * the effect below would not re-run, because neither the note nor the
   * fragment changed. The nonce is what makes "again" a different value.
   */
  anchor: { fragment?: string; line?: number; nonce: number } | null
}

export function Editor({
  note,
  text,
  onTextChange,
  isDirty,
  onSave,
  onConflict,
  backlinks,
  onOpenNote,
  onOpenWikilink,
  discarded,
  anchor,
}: EditorProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * One line of feedback for the two block-reference actions, because both can
   * decline and a control that silently does nothing is the defect this pane
   * has already been reviewed for once. Not an `error` — neither of these is a
   * failure, they are answers.
   */
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Land on the referenced line: select it, and let the browser scroll to the
   * selection. Selecting rather than only scrolling is deliberate — it says
   * WHICH line the reference meant, which a scroll position cannot.
   *
   * Depends on `anchor` alone. `text` is deliberately not a dependency: the
   * user typing must not yank the view back to the block they arrived at, and
   * by the time this runs after a navigation the buffer is already the new
   * note's — `openNote` sets the buffer and the anchor in one continuation, so
   * React renders them together.
   */
  useEffect(() => {
    setNotice(null)
    if (!anchor) return
    /**
     * TWO WAYS TO NAME A LINE, and only one of them can fail.
     *
     * A wikilink names a `#heading` or `#^block-id`, which has to be RESOLVED
     * against the text and may match nothing — that is the notice below. A
     * search hit already knows the line number, because the main process found
     * it there, so it is used directly. Resolving it a second time here would
     * mean re-running the match in the renderer and getting a different answer
     * whenever the file changed underneath.
     *
     * Clamped, not trusted: the note can have been edited between the search
     * and the click, and `setSelectionRange` past the end selects nothing at
     * all, which reads as the click having done nothing.
     */
    let line: number | null
    if (anchor.line !== undefined) {
      line = Math.min(Math.max(anchor.line, 0), text.split('\n').length - 1)
    } else if (anchor.fragment !== undefined) {
      line = anchorLine(text, anchor.fragment)
      if (line === null) {
        setNotice(`Nothing in this note is marked #${anchor.fragment}.`)
        return
      }
    } else {
      return
    }
    const textarea = textareaRef.current
    if (!textarea) return
    const { start, end } = lineRange(text, line)
    textarea.focus()
    textarea.setSelectionRange(start, end)
  }, [anchor])

  /**
   * Put `[[This note#^id]]` on the clipboard for the line the caret is on,
   * marking that line with an id if it has none.
   *
   * THIS IS THE FIRST THING IN THE APP THAT WRITES INTO A NOTE'S PROSE, and it
   * writes it into the BUFFER, not to disk. The marker lands under the same
   * Save button, the same mtime guard and the same backup as any typed edit —
   * an id appearing in a file the user never saved would be this feature
   * editing the vault behind them.
   */
  const handleCopyBlockRef = async () => {
    const textarea = textareaRef.current
    if (!textarea || !note) return
    const result = ensureBlockId(text, lineOfOffset(text, textarea.selectionStart))
    if (!result.ok) {
      setNotice(result.refusal)
      return
    }
    const link = `[[${note.title}#^${result.id}]]`
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      setNotice(`Could not reach the clipboard. The reference is ${link}`)
      return
    }
    if (result.text === text) {
      setNotice(`Copied ${link}`)
      return
    }
    onTextChange(result.text)
    setNotice(`Copied ${link} — save to keep the marker`)
  }

  const handleSave = async () => {
    if (!note || !isDirty || saving) return
    try {
      setSaving(true)
      setError(null)
      await onSave(text, note.mtime)
    } catch (e) {
      const message = String(e)
      // SaveConflict is raised in the main process and crosses IPC as a plain
      // Error, so only its message survives — `currentMtime` does not. Re-read
      // the note to get both the disk mtime and the disk text. The buffer is
      // untouched on every branch here; a failed save never costs the user text.
      if (isSaveConflict(message)) {
        try {
          const diskNote = await window.api.vault.read(note.path)
          onConflict(diskNote.mtime, diskNote.text)
        } catch (readErr) {
          setError(`Conflict: could not read disk version: ${readErr}`)
        }
      } else {
        setError(message)
      }
    } finally {
      setSaving(false)
    }
  }

  if (!note) {
    /**
     * The one place the empty state is stated, and it says what to do next.
     *
     * It used to be the words "No note selected" alone, with the note-title
     * strip above saying them a second time. A first launch is almost entirely
     * this view, so it is the screen the app is mostly made of — which makes
     * "there is nothing here" an expensive thing for it to be the only thing
     * saying.
     */
    return (
      <div className="vault-editor-empty">
        <p className="vault-editor-empty-title">No note open</p>
        <p className="vault-editor-empty-hint">
          Pick one from the sidebar, or press <kbd>+ Note</kbd> above the tree to
          start a new one.
        </p>
      </div>
    )
  }

  const wikilinks = parseWikilinkRefs(text)

  return (
    <div className="vault-editor">
      {/* The button is the ACTION and the span is the STATE. They used to say the
          same word twice — a button reading "Saved" beside a label reading "Up to
          date" is one fact wearing two hats, and neither told you what clicking
          would do. */}
      <div className="vault-editor-actions">
        <button
          className="vault-editor-save"
          onClick={handleSave}
          disabled={!isDirty || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {/* Secondary to Save on purpose: it is the one thing worth doing when
            there is something to save, and this must not compete with it. */}
        <button
          className="vault-editor-blockref"
          onClick={() => void handleCopyBlockRef()}
          title="Copy a [[link#^id]] to the line the caret is on"
        >
          Copy block ref
        </button>
        <span className="vault-editor-status" data-dirty={isDirty} aria-live="polite">
          {isDirty ? 'Unsaved changes' : 'Saved'}
        </span>
      </div>

      {notice && (
        <div className="vault-editor-notice" aria-live="polite">
          {notice}
        </div>
      )}

      {/* Out of the actions row: an error is a banner about the last attempt, not
          a third control sitting beside the button. Inside the flex row it was
          squeezed onto one line next to the status. */}
      {error && (
        <div className="vault-editor-error" role="alert">
          {error}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="vault-editor-textarea"
        value={text}
        onChange={(e) => onTextChange(e.currentTarget.value)}
        placeholder="No content yet"
      />

      <div className="vault-editor-links">
        <div className="vault-editor-wikilinks">
          <h3 className="vault-editor-links-title">Links</h3>
          {wikilinks.length === 0 ? (
            <div className="vault-editor-links-empty">No wikilinks</div>
          ) : (
            <ul className="vault-editor-links-list">
              {wikilinks.map((link) => (
                /* The fragment is IN the label, not stripped off it. A list
                   showing three identical "Note" rows for three different
                   blocks is the same loss the parser used to have, moved into
                   the view. `target || 'this note'` names the same-note form
                   rather than rendering a row that starts with `#`. */
                <li
                  key={`${link.target} ${link.fragment ?? ''}`}
                  className="vault-editor-link"
                >
                  <button
                    className="vault-editor-link-button"
                    onClick={() => onOpenWikilink(link)}
                  >
                    {link.target || 'this note'}
                    {link.fragment && (
                      <span className="vault-editor-link-fragment">
                        #{link.fragment}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="vault-editor-backlinks">
          <h3 className="vault-editor-links-title">Backlinks</h3>
          {backlinks.length === 0 ? (
            <div className="vault-editor-links-empty">No backlinks</div>
          ) : (
            <ul className="vault-editor-links-list">
              {backlinks.map((path) => (
                <li key={path} className="vault-editor-backlink">
                  <button
                    className="vault-editor-link-button"
                    onClick={() => onOpenNote(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {discarded && (
        <details className="vault-editor-discarded">
          <summary className="vault-editor-discarded-summary">
            {discarded.label} — recoverable until you open another note
          </summary>
          <textarea
            className="vault-editor-discarded-text"
            value={discarded.text}
            readOnly
          />
        </details>
      )}

      <div className="vault-editor-hints">
        <div className="vault-editor-hint">Wikilinks: [[note name]]</div>
        <div className="vault-editor-hint">Blocks: [[note#heading]] · [[note#^id]]</div>
      </div>
    </div>
  )
}
