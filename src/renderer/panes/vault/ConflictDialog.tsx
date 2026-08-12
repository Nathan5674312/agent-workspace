import { MERGE_SEPARATOR, mergeVersions } from './helpers.js'

/**
 * Conflict dialog — when save fails due to concurrent edits.
 * Shows both versions side-by-side so the user can merge or choose.
 * Never silently overwrites — the hardest rule.
 *
 * `bufferText` must be the LIVE editor buffer, not a snapshot taken when the
 * conflict was raised. A snapshot is how "Keep my version" ends up writing the
 * text the note had before the user edited it.
 *
 * There is no close/cancel/backdrop-dismiss control on purpose: every exit from
 * this dialog is one of the three explicit choices below.
 */
export interface ConflictDialogProps {
  isOpen: boolean
  diskText: string
  bufferText: string
  /** Why the last choice failed to save. Null when there is nothing to report. */
  error: string | null
  onKeepBuffer: () => void
  onKeepDisk: () => void
  onMerge: (merged: string) => void
}

export function ConflictDialog({
  isOpen,
  diskText,
  bufferText,
  error,
  onKeepBuffer,
  onKeepDisk,
  onMerge,
}: ConflictDialogProps) {
  if (!isOpen) return null

  return (
    <div className="vault-conflict-dialog-overlay">
      <div className="vault-conflict-dialog">
        <h2 className="vault-conflict-title">Note changed on disk</h2>
        <p className="vault-conflict-message">
          This note was edited elsewhere while you had it open. Choose which
          version to keep or merge them.
        </p>

        <div className="vault-conflict-versions">
          <div className="vault-conflict-version">
            <h3 className="vault-conflict-subtitle">Your version</h3>
            <textarea
              className="vault-conflict-textarea"
              value={bufferText}
              readOnly
            />
          </div>

          <div className="vault-conflict-version">
            <h3 className="vault-conflict-subtitle">Disk version</h3>
            <textarea
              className="vault-conflict-textarea"
              value={diskText}
              readOnly
            />
          </div>
        </div>

        {error && (
          <p className="vault-conflict-error" role="alert">
            {error} — nothing was written and both versions above are still
            intact.
          </p>
        )}

        <div className="vault-conflict-actions">
          <button
            className="vault-conflict-button vault-conflict-keep-buffer"
            onClick={onKeepBuffer}
          >
            Keep my version
          </button>
          <button
            className="vault-conflict-button vault-conflict-keep-disk"
            onClick={onKeepDisk}
          >
            Keep disk version
          </button>
          <button
            className="vault-conflict-button vault-conflict-merge"
            onClick={() => onMerge(mergeVersions(bufferText, diskText))}
          >
            Merge both
          </button>
        </div>
        <p className="vault-conflict-merge-note">
          Merge keeps both sides in full, separated by
          <code className="vault-conflict-separator">{MERGE_SEPARATOR.trim()}</code>
        </p>
      </div>
    </div>
  )
}
