import { useState } from 'react'
import type { VaultNoteBody } from '../../../shared/ipc.js'
import { isSaveConflict, parseWikilinks } from './helpers.js'

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
  onOpenWikilink: (name: string) => void
  discarded: { label: string; text: string } | null
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
}: EditorProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    return <div className="vault-editor-empty">No note selected</div>
  }

  const wikilinks = parseWikilinks(text)

  return (
    <div className="vault-editor">
      <div className="vault-editor-actions">
        <button
          className="vault-editor-save"
          onClick={handleSave}
          disabled={!isDirty || saving}
        >
          {saving ? 'Saving...' : isDirty ? 'Save' : 'Saved'}
        </button>
        <span className="vault-editor-status" data-dirty={isDirty}>
          {isDirty ? 'Unsaved changes' : 'Up to date'}
        </span>
        {error && <div className="vault-editor-error">{error}</div>}
      </div>

      <textarea
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
              {wikilinks.map((name) => (
                <li key={name} className="vault-editor-link">
                  <button
                    className="vault-editor-link-button"
                    onClick={() => onOpenWikilink(name)}
                  >
                    {name}
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
      </div>
    </div>
  )
}
