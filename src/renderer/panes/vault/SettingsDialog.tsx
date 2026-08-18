/**
 * Settings — the vault folder, and the appearance overrides.
 *
 * A modal rendered from VaultPane alongside the conflict dialog, deliberately
 * NOT a fifth entry in the view switcher: settings are not a way of looking at
 * the vault, and putting them there would mean the editor's unsaved buffer can
 * be navigated away from by opening preferences.
 *
 * The vault directory is chosen through the OS folder picker in the main
 * process, so nothing here ever constructs or sends a path.
 *
 * The two halves apply on OPPOSITE schedules and the copy says so: the vault
 * folder waits for a restart because a live swap would have to invalidate the
 * graph memo, the tree, the open buffer and the nav trail atomically. The
 * appearance overrides are CSS attributes on <html>, so they apply as they are
 * touched — there is nothing to rebuild and nothing to lose.
 *
 * A real <dialog> + showModal(), not a div pretending to be one. The renderer is
 * always Chromium, so the focus trap, Escape, the focus restore on close and the
 * top layer are all the platform's job. What is NOT native, and so is still
 * written out below: dismissing on a backdrop click.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ARTWORK_OPACITY_MAX,
  DEFAULT_APPEARANCE,
  type Appearance,
  type AppSettings,
} from '../../../shared/ipc.js'
import { applyAppearance } from '../../appearance.js'
import './settings.css'

/**
 * One appearance control: System, or the single named override.
 *
 * Generic over the override so each call site keeps its own literal type —
 * `value` and `onChange` are `'system' | 'more'` at the contrast row and
 * `'system' | 'reduced'` at the other two, with no cast anywhere. A `<select>`
 * rather than a segmented control because it is two mutually exclusive options
 * with a label, which is the element's job: keyboard, screen reader and the
 * dialog's own tab order all come free.
 */
function Choice<T extends string>({
  id,
  label,
  value,
  override,
  overrideLabel,
  hint,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: 'system' | T
  override: T
  overrideLabel: string
  hint: string
  disabled: boolean
  onChange: (v: 'system' | T) => void
}) {
  return (
    <div className="settings-appearance-row">
      <div className="settings-appearance-text">
        <label className="settings-appearance-label" htmlFor={id}>
          {label}
        </label>
        <span className="settings-appearance-hint">{hint}</span>
      </div>
      <select
        id={id}
        className="settings-appearance-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === 'system' ? 'system' : override)}
      >
        <option value="system">System</option>
        <option value={override}>{overrideLabel}</option>
      </select>
    </div>
  )
}

export interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** True while the native picker is up, so a second click cannot open two. */
  const [picking, setPicking] = useState(false)
  /**
   * The opacity under the thumb WHILE dragging, null when not dragging.
   *
   * Not an optimisation. A range input bound straight to the persisted value
   * would be a controlled input driven by an async round trip: every pixel of a
   * drag fires a change, the replies can land out of order, and a stale one
   * yanks the thumb backwards under the finger. The draft owns the value until
   * the drag ends, and only then is one value persisted.
   */
  const [artworkDraft, setArtworkDraft] = useState<number | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  /**
   * Whether the mousedown currently in flight started on the backdrop.
   *
   * A ref, not state: it is read by the mouseup that follows and must not
   * repaint anything in between.
   */
  const downOnBackdrop = useRef(false)

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
   * The whole of the modal behaviour: focus in, Tab trapped, Escape, focus back
   * to the gear on close, and the top layer. showModal() does all of it.
   *
   * The element is rendered whether or not it is open — a closed <dialog> is
   * `display: none` by UA rule, so its contents are neither visible nor
   * focusable — because close() is what restores focus to whatever opened this,
   * and it can only run on an element that is still in the document. Returning
   * null on close would tear the node out first and drop focus to <body>.
   */
  useEffect(() => {
    if (!isOpen) return
    const el = dialogRef.current
    el?.showModal()
    return () => el?.close()
  }, [isOpen])

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

  /**
   * Defaults only cover the gap before the first read lands, and the controls
   * are disabled for exactly that long — so a click can never persist a default
   * over a setting that simply had not arrived yet.
   */
  const appearance = settings?.appearance ?? DEFAULT_APPEARANCE
  const artworkOpacity = artworkDraft ?? appearance.artworkOpacity

  /**
   * Apply first, then persist, then re-apply what main sends back.
   *
   * The first apply is what makes a control feel connected instead of laggy.
   * The re-apply is not redundant: main validates and CLAMPS, so the settings
   * that come back may not equal the ones that went out, and the contract says
   * to render the result rather than the argument. A failed write puts the last
   * known-good appearance back on screen, because the alternative is an error
   * message under a screen that looks like the change took.
   */
  const update = async (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch }
    applyAppearance(next)
    try {
      const s = await window.api.settings.setAppearance(next)
      setSettings(s)
      applyAppearance(s.appearance)
      setError(null)
    } catch (e) {
      applyAppearance(appearance)
      setError(String(e))
    }
  }

  /** End of a drag or an arrow-key nudge: one write, for the value it landed on. */
  const commitArtworkOpacity = () => {
    if (artworkDraft === null) return
    void update({ artworkOpacity: artworkDraft }).finally(() => setArtworkDraft(null))
  }

  return (
    <dialog
      className="settings-overlay"
      ref={dialogRef}
      aria-labelledby="settings-title"
      // The <dialog> IS the backdrop hit area: it fills the viewport and the
      // panel is a child of it, so a press on the scrim targets the dialog
      // itself. ::backdrop paints but cannot be hit-tested, which is why this
      // one behaviour stays hand-rolled.
      //
      // Both ends of the press must be on it. Down-only would dismiss a
      // selection dragged INTO the dialog; up-only (a plain click) would
      // dismiss one dragged OUT of it, which is the more common accident.
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      }}
      // Escape's native close arrives as `cancel`. preventDefault leaves React
      // the only thing that closes this: the effect above owns close(), so the
      // element's open state cannot drift from `isOpen`.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // `cancel` does not consume the keydown that produced it, and the app
      // behind must not act on the same Escape.
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <div className="settings-dialog">
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

        <div className="settings-field">
          <span className="settings-label" id="settings-appearance-title">
            Appearance
          </span>
          {/* "System" is not a third styling — it is the ABSENCE of an override,
              which leaves the OS preference and the @media blocks in charge. */}
          <p className="settings-hint">
            System follows your OS accessibility settings. Changes apply immediately.
          </p>

          <div
            className="settings-appearance-grid"
            role="group"
            aria-labelledby="settings-appearance-title"
          >
            <Choice
              id="settings-contrast"
              label="Contrast"
              hint="Lighter labels and solid borders."
              value={appearance.contrast}
              override="more"
              overrideLabel="High"
              disabled={!settings}
              onChange={(v) => void update({ contrast: v })}
            />
            <Choice
              id="settings-transparency"
              label="Transparency"
              hint="Frosted panels become solid."
              value={appearance.transparency}
              override="reduced"
              overrideLabel="Reduced"
              disabled={!settings}
              onChange={(v) => void update({ transparency: v })}
            />
            <Choice
              id="settings-motion"
              label="Motion"
              hint="Animations end where they would have finished."
              value={appearance.motion}
              override="reduced"
              overrideLabel="Reduced"
              disabled={!settings}
              onChange={(v) => void update({ motion: v })}
            />

            <div className="settings-appearance-row">
              <div className="settings-appearance-text">
                <label className="settings-appearance-label" htmlFor="settings-artwork">
                  Background artwork
                </label>
                <span className="settings-appearance-hint">
                  The canvas image behind the vault.
                </span>
              </div>
              <input
                id="settings-artwork"
                className="settings-appearance-toggle"
                type="checkbox"
                checked={appearance.artwork}
                disabled={!settings}
                onChange={(e) => void update({ artwork: e.target.checked })}
              />
            </div>

            <div className="settings-appearance-row">
              <div className="settings-appearance-text">
                <label className="settings-appearance-label" htmlFor="settings-artwork-opacity">
                  Artwork opacity
                </label>
                {/* The ceiling is stated because it is a real limit, not a
                    preference: above it the artwork lightens the ground the
                    palette's contrast ratios were measured against. */}
                <span className="settings-appearance-hint">
                  Stops at {ARTWORK_OPACITY_MAX.toFixed(2)} to protect text contrast.
                </span>
              </div>
              <input
                id="settings-artwork-opacity"
                className="settings-appearance-slider"
                type="range"
                min={0}
                max={ARTWORK_OPACITY_MAX}
                step={0.01}
                value={artworkOpacity}
                // Off means there is nothing for it to act on, so it is disabled
                // rather than left live over an invisible layer. Disabled also
                // takes it out of the dialog's tab order for free.
                disabled={!settings || !appearance.artwork}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setArtworkDraft(v)
                  applyAppearance({ ...appearance, artworkOpacity: v })
                }}
                onPointerUp={commitArtworkOpacity}
                onKeyUp={commitArtworkOpacity}
                // A drag the browser takes away (window deactivated, touch
                // interrupted) fires neither of the above. NOT onBlur: the pane
                // bans blur handlers outright as a save path, and that guard is
                // worth more than this net. A no-op when the value was already
                // committed, because the draft is null by then.
                onPointerCancel={commitArtworkOpacity}
              />
              <output className="settings-appearance-value" htmlFor="settings-artwork-opacity">
                {artworkOpacity.toFixed(2)}
              </output>
            </div>
          </div>
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
    </dialog>
  )
}
