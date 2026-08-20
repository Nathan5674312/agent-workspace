/**
 * Settings — the vault folder, the appearance overrides, and the approvals
 * policy that governs what the agent may do to the vault unattended.
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
 *
 * Sectioned, with a left nav, ahead of the settings docs/SETTINGS-RESEARCH.md §4
 * lines up rather than after them: retrofitting nav onto a modal that has
 * already grown is the more expensive order. Two mutually exclusive panes is a
 * TABLIST, so it is written as one — roving tabindex, arrows move selection —
 * and the inactive panel is `hidden` rather than unmounted, so aria-controls
 * always resolves and the dialog's tab order still never contains it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ARTWORK_OPACITY_MAX,
  DEFAULT_APPEARANCE,
  DEFAULT_APPROVALS,
  type Appearance,
  type Approvals,
  type AppSettings,
} from '../../../shared/ipc.js'
import { applyAppearance } from '../../appearance.js'
import './settings.css'

/**
 * One appearance control: System, or the single named override.
 *
 * Generic over the override so each call site keeps its own literal type, with
 * no cast anywhere. Both remaining rows are `'system' | 'reduced'` now that the
 * contrast row (the one `'system' | 'more'` caller) is gone, so the generic is
 * currently carrying one type — kept because the next override will not be
 * `'reduced'` either, and widening it back is worse than leaving it. A `<select>`
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

/**
 * The sections, in nav order. The split is docs/SETTINGS-RESEARCH.md §5's, and
 * it is the reason it is a list and not two hard-coded buttons: Editor, Agent
 * and About are named there as the next arrivals, and each is one row here.
 */
const SECTIONS = [
  { id: 'vault', label: 'Vault' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agent', label: 'Agent' },
] as const

/**
 * The timeout offered, in minutes. A `<select>` of durations rather than a
 * number box: the value is milliseconds in the gate, and a free-text field over
 * a millisecond field invites "30" meaning half a minute to someone and 30ms to
 * the machine. Off is first because it is the default and the status quo.
 */
const TIMEOUTS = [
  { label: 'Never expires', ms: undefined },
  { label: 'After 1 minute', ms: 60_000 },
  { label: 'After 5 minutes', ms: 300_000 },
  { label: 'After 15 minutes', ms: 900_000 },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  /**
   * Whether the editor holds unsaved text.
   *
   * This dialog used to need nothing from the pane, and VaultPane's comment at
   * its call site said so: Settings "cannot reach the buffer, so it needs no
   * dirty guard". Switching the vault folder reloads the window, which destroys
   * the buffer — so that stopped being true, and the guard has to come with the
   * capability rather than after someone loses a note to it.
   */
  isDirty: boolean
}

export function SettingsDialog({ isOpen, onClose, isDirty }: SettingsDialogProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** True while the native picker is up, so a second click cannot open two. */
  const [picking, setPicking] = useState(false)
  /** Never cleared on success: the window reloads out from under it. */
  const [switching, setSwitching] = useState(false)
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
  /**
   * Which section is showing. Component state and nothing more — no route, no
   * deep link, no persisted "last tab". A settings pane that reopens where you
   * left it is a feature nobody asked for and a migration nobody wants.
   */
  const [section, setSection] = useState<SectionId>('vault')
  const dialogRef = useRef<HTMLDialogElement>(null)
  /** The tablist, so an arrow key can focus the tab it just selected. */
  const navRef = useRef<HTMLDivElement>(null)
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
   * Switch to the picked folder now.
   *
   * There is no optimistic update and no `setSettings` on the happy path,
   * because there is no "after" to render in this window: main reloads the
   * renderer, and this component goes with it. The catch matters more than
   * usual for the same reason — if the switch fails, this dialog is still on
   * screen and is the only thing that can say so.
   */
  const handleSwitchNow = async () => {
    if (isDirty) return
    setSwitching(true)
    try {
      setError(null)
      await window.api.settings.applyVaultDir()
    } catch (e) {
      setError(String(e))
      setSwitching(false)
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

  /**
   * The approvals policy, on the same apply-then-render-the-result contract as
   * `update()` — but with NO optimistic apply, deliberately. Appearance is a CSS
   * attribute this process owns, so painting it early is free and reversible.
   * This is a security control enforced in the main process: showing "strict"
   * before the gate has accepted it would be telling the user they are protected
   * during the window where they are not.
   *
   * Main normalises, so what comes back may not be what went out — an unknown
   * mode returns as 'manual'. Rendering the reply rather than the argument is
   * what makes that visible instead of silent.
   */
  const approvals = settings?.approvals ?? DEFAULT_APPROVALS

  const updateApprovals = async (patch: Partial<Approvals>) => {
    try {
      setSettings(await window.api.settings.setApprovals({ ...approvals, ...patch }))
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  /** End of a drag or an arrow-key nudge: one write, for the value it landed on. */
  const commitArtworkOpacity = () => {
    if (artworkDraft === null) return
    void update({ artworkOpacity: artworkDraft }).finally(() => setArtworkDraft(null))
  }

  /**
   * Roving focus, on the tablist rather than on each tab because the keydown
   * bubbles and one handler is one handler. Selection follows focus — with two
   * cheap panes there is nothing to load, so the manual-activation variant
   * would only be an extra keystroke. Vertical nav, so Up/Down and Home/End;
   * Left/Right belong to a horizontal tablist and are deliberately not here.
   */
  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = SECTIONS.findIndex((s) => s.id === section)
    const n = SECTIONS.length
    const to =
      e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowUp' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1
    if (to < 0) return
    e.preventDefault()
    setSection(SECTIONS[to].id)
    navRef.current?.querySelectorAll('button')[to]?.focus()
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

        <div className="settings-body">
          <div
            className="settings-nav"
            ref={navRef}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onNavKeyDown}
          >
            {SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                className={`settings-nav-item${section === id ? ' settings-nav-item--active' : ''}`}
                aria-selected={section === id}
                aria-controls={`settings-panel-${id}`}
                // Roving tabindex: one stop for the whole nav, so Tab reaches
                // the section list and then leaves it for the controls.
                tabIndex={section === id ? 0 : -1}
                onClick={() => setSection(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* `hidden`, not unmounted: aria-controls stays resolvable, and the
              UA's own `display: none` takes the whole pane out of the dialog's
              focus order without a second mechanism to keep in sync. */}
          <div
            className="settings-panel"
            id="settings-panel-vault"
            role="tabpanel"
            aria-labelledby="settings-tab-vault"
            hidden={section !== 'vault'}
          >
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
                <div className="settings-pending" role="status">
                  <p>
                    Picked{' '}
                    <span className="settings-path-inline">{settings.pendingVaultDir}</span>. The
                    folder above is still the one in use.
                  </p>
                  {/* The whole point of the fix: something in the app can now
                      actually perform the switch it was telling you to wait
                      for. Disabled rather than hidden while the buffer is
                      dirty, with the reason next to it — a control that
                      vanishes reads as a bug, and this one destroys unsaved
                      text if it runs. */}
                  <button
                    type="button"
                    className="settings-switch-now"
                    onClick={() => void handleSwitchNow()}
                    disabled={isDirty || switching}
                  >
                    {switching ? 'Switching…' : 'Switch now'}
                  </button>
                  {isDirty && (
                    <span className="settings-hint">
                      Save or discard your open note first — switching reloads the window.
                    </span>
                  )}
                </div>
              ) : (
                <p className="settings-hint">
                  Choose a folder to switch vaults. Your notes are not moved or changed.
                </p>
              )}
            </div>

            {/* Read-only, and only when the boot check actually found something.
                It is about the vault folder, so it lives with it. */}
            {settings?.rootMismatch && (
              <p className="settings-mismatch" role="alert">
                {settings.rootMismatch}
              </p>
            )}
          </div>

          <div
            className="settings-panel"
            id="settings-panel-appearance"
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
            hidden={section !== 'appearance'}
          >
            {/* "System" is not a third styling — it is the ABSENCE of an override,
                which leaves the OS preference and the @media blocks in charge. */}
            <p className="settings-hint">
              System follows your OS accessibility settings. Changes apply immediately.
            </p>

            {/* No role="group" and no heading of its own any more: the tabpanel
                IS the group, named by its tab, and a second "Appearance" label
                would only repeat the nav item that leads here. */}
            <div className="settings-appearance-grid">
              {/* No Contrast row. `@media (prefers-contrast: more)` in app.css
                  still answers the OS preference; the in-app High override was
                  removed because it was a second copy of those values. */}
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

          <div
            className="settings-panel"
            id="settings-panel-agent"
            role="tabpanel"
            aria-labelledby="settings-tab-agent"
            hidden={section !== 'agent'}
          >
            <div className="settings-field">
              <span className="settings-label" id="settings-approvals-title">
                Approvals
              </span>
              {/* States the floor, not just the controls. Neither of these can
                  turn the gate off — there is no such mode — and someone reading
                  a security setting should be told what it cannot do. */}
              <p className="settings-hint">
                Anything the agent does to the vault on its own is asked about first.
                These settings can only make it ask more often. Changes apply immediately.
              </p>

              <div
                className="settings-appearance-grid"
                role="group"
                aria-labelledby="settings-approvals-title"
              >
                {/* NOT <Choice>: that component's base value is the literal
                    'system', because for appearance the base case is "no
                    override, the OS decides". There is no OS preference for
                    this and no such thing as no policy — the base case is
                    'manual', which is itself a policy. Reusing Choice would
                    have rendered a select whose value matched no option. */}
                <div className="settings-appearance-row">
                  <div className="settings-appearance-text">
                    <label className="settings-appearance-label" htmlFor="settings-approvals-mode">
                      When you have already approved
                    </label>
                    <span className="settings-appearance-hint">
                      Always ask re-asks every time, ignoring “allow for this session”.
                    </span>
                  </div>
                  <select
                    id="settings-approvals-mode"
                    className="settings-appearance-select"
                    value={approvals.mode}
                    disabled={!settings}
                    onChange={(e) =>
                      void updateApprovals({
                        mode: e.target.value === 'strict' ? 'strict' : 'manual',
                      })
                    }
                  >
                    <option value="manual">Remember for the session</option>
                    <option value="strict">Always ask</option>
                  </select>
                </div>

                <div className="settings-appearance-row">
                  <div className="settings-appearance-text">
                    <label
                      className="settings-appearance-label"
                      htmlFor="settings-approvals-timeout"
                    >
                      Unanswered prompt
                    </label>
                    {/* Says which way it fails. This is the one number here that
                        could plausibly be read as "then it goes ahead". */}
                    <span className="settings-appearance-hint">
                      A prompt nobody answers is treated as a refusal, never as approval.
                    </span>
                  </div>
                  <select
                    id="settings-approvals-timeout"
                    className="settings-appearance-select"
                    value={String(approvals.timeoutMs ?? '')}
                    disabled={!settings}
                    onChange={(e) =>
                      void updateApprovals({
                        timeoutMs: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  >
                    {TIMEOUTS.map((t) => (
                      <option key={t.label} value={String(t.ms ?? '')}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Not inside a panel: an error can come from either half, and hiding
            the report of a failed write behind the tab you have just left is
            how someone walks away believing the change took. */}
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
