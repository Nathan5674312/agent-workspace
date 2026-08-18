import { useEffect, useRef, useState } from 'react'
import type { NoteVersion, VaultNoteBody } from '../../../shared/ipc.js'
import { isSaveConflict } from './helpers.js'
import './versions.css'

/**
 * Version history for the open note: every pre-edit copy in `.backups/`,
 * newest first, with a preview and a restore.
 *
 * RESTORE IS A SAVE. This component never asks main to copy a file back over a
 * note — it hands the old text to the same `save()` every keystroke-edit goes
 * through, so the mtime lost-update guard still runs, the current text is still
 * backed up before it is replaced, and a note someone else changed meanwhile
 * still raises SaveConflict. A restore that skipped that path would be the only
 * write in the app that can lose a note silently, and it would lose it to a
 * button labelled "restore".
 *
 * The buffer is NOT owned here — `onRestore` belongs to <VaultPane>, which owns
 * it, because a restore that wrote the file and left the editor showing the old
 * text would read as unsaved changes that were in fact already on disk.
 */
export interface VersionsViewProps {
  note: VaultNoteBody | null
  /**
   * Save `text` over the open note. Resolves false when the user declined the
   * unsaved-edits prompt, and REJECTS when the save failed — including
   * SaveConflict, which is handled below.
   */
  onRestore: (text: string) => Promise<boolean>
}

const when = (at: number) => new Date(at).toLocaleString()

export function VersionsView({ note, onRestore }: VersionsViewProps) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null)
  const [selected, setSelected] = useState<NoteVersion | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Bumped after a restore: that save just created a version of its own. */
  const [reload, setReload] = useState(0)

  const path = note?.path ?? null

  useEffect(() => {
    if (!path) {
      setVersions(null)
      return
    }
    // Cancelled on note change so a slow list cannot land under a newer note —
    // the same guard the backlinks effect in <VaultPane> needs.
    let cancelled = false
    setVersions(null)
    setSelected(null)
    setPreview(null)
    setStatus(null)
    window.api.vault
      .versions(path)
      .then((v) => {
        if (cancelled) return
        setVersions(v)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setVersions([])
        setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [path, reload])

  /**
   * Which preview request is the current one. Two clicks in a row resolve in
   * whatever order the disk feels like, and without this the slower of them
   * paints its text under the other one's highlighted row — the worst possible
   * lie to tell right next to a Restore button.
   */
  const seq = useRef(0)

  const openVersion = async (v: NoteVersion) => {
    const mine = ++seq.current
    setSelected(v)
    setPreview(null)
    setStatus(null)
    setError(null)
    try {
      const text = await window.api.vault.versionText(v.id)
      if (seq.current === mine) setPreview(text)
    } catch (e) {
      if (seq.current === mine) setError(String(e))
    }
  }

  const restore = async () => {
    if (!selected || preview === null || busy) return
    setBusy(true)
    setStatus(null)
    setError(null)
    try {
      if (await onRestore(preview)) {
        setStatus(`Restored the version from ${when(selected.at)}.`)
        setReload((n) => n + 1)
      }
    } catch (e) {
      const message = String(e)
      // The guard did its job. There is no useful merge to offer here — the
      // conflict dialog is about the edit buffer, and the user asked for a file
      // from the past, not for their own text — so say what happened and what
      // clears it.
      setError(
        isSaveConflict(message)
          ? 'This note changed on disk after it was opened, so nothing was written. Reopen the note, then restore again.'
          : message,
      )
    } finally {
      setBusy(false)
    }
  }

  if (!note) {
    return <div className="vault-versions-empty">No note selected</div>
  }

  return (
    <div className="vault-versions">
      <div className="vault-versions-list-pane">
        <h3 className="vault-versions-title">Versions of {note.title}</h3>
        {/* A copy is taken BEFORE each overwrite, so the newest entry is the
            note as it was before the last save — not the note as it is now.
            Saying so stops the top row reading as a duplicate of the editor. */}
        <p className="vault-versions-note">
          Each entry is the note as it was before one save. The current text is in
          the editor.
        </p>

        {versions === null ? (
          <div className="vault-versions-loading">Loading…</div>
        ) : versions.length === 0 ? (
          <div className="vault-versions-loading">
            No earlier versions. One is kept every time this note is saved.
          </div>
        ) : (
          <ul className="vault-versions-list">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  className="vault-version-button"
                  onClick={() => void openVersion(v)}
                  aria-pressed={selected?.id === v.id}
                  data-selected={selected?.id === v.id}
                >
                  <span className="vault-version-when">{when(v.at)}</span>
                  <span className="vault-version-size">{v.size} bytes</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="vault-versions-preview-pane">
        {error && (
          <div className="vault-versions-error" role="alert">
            {error}
          </div>
        )}
        {status && (
          <div className="vault-versions-status" role="status">
            {status}
          </div>
        )}

        {!selected ? (
          <div className="vault-versions-loading">
            Select a version to preview it.
          </div>
        ) : preview === null ? (
          <div className="vault-versions-loading">Loading version…</div>
        ) : (
          <>
            <div className="vault-versions-actions">
              <button
                className="vault-versions-restore"
                onClick={() => void restore()}
                disabled={busy}
              >
                {busy ? 'Restoring…' : 'Restore this version'}
              </button>
              <span className="vault-versions-hint">
                Saves this text over the note. The current text is backed up first.
              </span>
            </div>
            <textarea
              className="vault-versions-preview"
              value={preview}
              readOnly
              aria-label={`Contents of the version from ${when(selected.at)}`}
            />
          </>
        )}
      </div>
    </div>
  )
}
