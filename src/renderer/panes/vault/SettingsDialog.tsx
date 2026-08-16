/**
 * Settings — ONE setting: the vault folder.
 *
 * A modal rendered from VaultPane alongside the conflict dialog, deliberately
 * NOT a fifth entry in the view switcher: settings are not a way of looking at
 * the vault, and putting them there would mean the editor's unsaved buffer can
 * be navigated away from by opening preferences.
 *
 * The vault directory is chosen through the OS folder picker in the main
 * process, so nothing here ever constructs or sends a path.
 */
import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/ipc.js'
import './settings.css'

/**
 * Tab-cycle members. `:not(:disabled)` matters — the help `?` button is not in
 * here, but a disabled "Change…" during a pick would otherwise be a focus stop
 * that does nothing.
 */
const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** True while the native picker is up, so a second click cannot open two. */
  const [picking, setPicking] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  /**
   * Read on every open rather than once. The settings live in the main process
   * and this dialog is cheap to open; caching them here would show a stale
   * vault path after any change made outside this render tree.
   */
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    window.api.settings
      .get()
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  /**
   * Focus in on open, back to the gear on close.
   *
   * `document.activeElement` is captured rather than taking a ref to the gear
   * button: the gear lives two components away, and reading what actually had
   * focus is both shorter and correct if the dialog is ever opened from
   * somewhere else. The dialog wrapper takes focus itself (tabIndex -1) so a
   * screen reader lands inside the dialog instead of staying behind it, and so
   * the Tab trap below always has a known starting point.
   */
  useEffect(() => {
    if (!isOpen) return
    const returnTo = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (returnTo instanceof HTMLElement) returnTo.focus()
    }
  }, [isOpen])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return

    const items = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    )
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement

    // Only the two edges are handled; everything in between is the browser's
    // own tab order and does not need help. The wrapper counts as the leading
    // edge because focus starts there — without that, the first Shift+Tab of
    // the dialog's life walks straight out into the page behind it.
    if (e.shiftKey ? active === first || active === dialogRef.current : active === last) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    }
  }

  const handleChange = async () => {
    setPicking(true)
    try {
      setSettings(await window.api.settings.pickVaultDir())
      setError(null)
    } catch (e) {
      // A failed pick must say so. Silently leaving the old path on screen is
      // how someone walks away believing the vault moved.
      setError(String(e))
    } finally {
      setPicking(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="settings-overlay"
      // mousedown, not click: a click that STARTS inside the dialog and ends on
      // the backdrop (a drag off the end of a selection) is not a dismissal.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <h2 className="settings-title" id="settings-title">
          Settings
        </h2>

        <div className="settings-field">
          <div className="settings-field-head">
            <span className="settings-label">Vault folder</span>
            <button
              className="settings-change"
              onClick={() => void handleChange()}
              disabled={picking}
            >
              {picking ? 'Choosing…' : 'Change…'}
            </button>
          </div>
          <div className="settings-path" title={settings?.vaultDir ?? ''}>
            {settings?.vaultDir ?? 'Reading…'}
          </div>
          {settings?.pendingVaultDir ? (
            <p className="settings-pending" role="status">
              Restart to open <span className="settings-path-inline">{settings.pendingVaultDir}</span>.
              The folder above is still the one in use.
            </p>
          ) : (
            <p className="settings-hint">Changing this applies when the app restarts.</p>
          )}
        </div>

        {/* Read-only, and only when the boot check actually found something. */}
        {settings?.rootMismatch && (
          <p className="settings-mismatch" role="alert">
            {settings.rootMismatch}
          </p>
        )}

        {error && (
          <p className="settings-error" role="alert">
            {error} — nothing was changed.
          </p>
        )}

        <div className="settings-actions">
          <button className="settings-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
