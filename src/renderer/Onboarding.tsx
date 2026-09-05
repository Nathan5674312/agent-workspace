import { useEffect, useState } from 'react'
import { Frame, Waypoints } from 'lucide-react'
import type { AppSettings } from '../shared/ipc.js'
import { applyAppearance } from './appearance.js'
import { ThemePicker } from './panes/vault/ThemePicker.js'
import './Onboarding.css'

/**
 * THE FIRST RUN, WHICH UNTIL NOW WAS AN ERROR MESSAGE.
 *
 * What a new install actually did: open on a red banner reading "vault:
 * ...\Documents\Fate is not a readable directory. Set
 * AGENT_WORKSPACE_VAULT_DIR or fix the vault path in settings." That folder
 * does not exist and is not created, so the first thing the product ever said
 * to anyone was the name of an environment variable. There was no tour, no
 * prompt, and no path from that banner to a working vault.
 *
 * Three steps, in Nathan's order:
 *
 *   1. WHERE THE BIG TWO ARE. Graph and Canvas. This step lifts the real
 *      ribbon out of the scrim rather than drawing a picture of it, so what is
 *      pointed at is the thing itself — see `body[data-onboarding='surfaces']`
 *      in Onboarding.css. A screenshot of a control goes stale; the control
 *      does not.
 *   2. THE VAULT FOLDER. The step that answers the banner. It opens the real
 *      OS picker through `pickVaultDir()`, which is the only way a folder can
 *      be chosen here — the renderer may never name a directory, so there is
 *      no text field to type one into and this is not a limitation of the tour.
 *   3. THE THEME, through the same visual picker Settings uses. Not a second
 *      copy of it: the component is imported.
 *
 * THE VAULT IS APPLIED LAST, ONCE, AND NOT WHEN IT IS PICKED. `applyVaultDir()`
 * reloads the window — that is its design, because swapping the vault live
 * would have to invalidate the graph memo, the tree, the buffer and the nav
 * trail atomically. A reload in the middle of step 2 would take the tour with
 * it and drop the person back where they started, so the pick only persists as
 * pending and the reload happens on Finish.
 */

/**
 * Whether the tour has been completed on this machine.
 *
 * localStorage, NOT settings.json, and the distinction is what it is for. The
 * things in settings.json are decisions the app must honour — a vault path, a
 * refusal to be notified — and main enforces them. "I have seen the tour" is
 * neither; it is progress through a UI, per profile, and nothing outside this
 * component reads it.
 *
 * It also fails in the safe direction. Cleared storage, a fresh profile or a
 * browser refusing to store anything at all means the tour runs again, which
 * costs three clicks. The opposite default — assuming it has been seen —
 * silently restores the red banner as the product's first sentence.
 */
const SEEN_KEY = 'fate.onboarded.v1'

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    // Storage can throw outright, not merely return null. Treat it as "not
    // seen": see the note above on which direction is safe.
    return false
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* The tour will run again. That is the acceptable failure. */
  }
}

type Step = 'surfaces' | 'vault' | 'theme'
const STEPS: Step[] = ['surfaces', 'vault', 'theme']

export function Onboarding(): React.ReactElement | null {
  const [open, setOpen] = useState(() => !seen())
  const [step, setStep] = useState<Step>('surfaces')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    void window.api.settings
      .get()
      .then((s) => {
        if (live) setSettings(s)
      })
      .catch(() => {
        /* The tour still runs. It just cannot show the current folder. */
      })
    return () => {
      live = false
    }
  }, [open])

  /**
   * The step, published to the document so CSS can lift the real ribbon out of
   * the scrim on step one.
   *
   * An attribute rather than a prop threaded into LeftRibbon: what is being
   * highlighted is a fact about the window during this tour, and the ribbon
   * should not have to know a tour exists to be pointed at.
   */
  useEffect(() => {
    if (!open) {
      delete document.body.dataset.onboarding
      return
    }
    document.body.dataset.onboarding = step
    return () => {
      delete document.body.dataset.onboarding
    }
  }, [open, step])

  if (!open) return null

  const at = STEPS.indexOf(step)

  const finish = () => {
    markSeen()
    setOpen(false)
    // Last, and only if they chose one. This reloads the window, so nothing
    // after it runs — which is why it is the last thing that happens.
    if (settings?.pendingVaultDir) {
      void window.api.settings.applyVaultDir().catch(() => {
        /* Silent: they still get the app, on the folder they had. */
      })
    }
  }

  const pick = () => {
    setPicking(true)
    void window.api.settings
      .pickVaultDir()
      .then((s) => setSettings(s))
      .catch(() => {
        /* Cancelled or refused. The step simply stays as it was. */
      })
      .finally(() => setPicking(false))
  }

  /**
   * The folder they have actually chosen, or null.
   *
   * NOT simply `vaultDir`. On a first run that value is a fallback nobody
   * picked — `...\Documents\Fate`, which does not exist and is not created —
   * and showing it made the step offer to "choose a DIFFERENT folder" for a
   * folder the app had already failed to read. `rootMismatch` is main's own
   * verdict on whether the live path works, and it is exactly the message that
   * used to be the red banner this step replaces.
   */
  const chosen = settings?.pendingVaultDir ?? (settings?.rootMismatch ? null : settings?.vaultDir)
  const folder = chosen ?? null

  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-labelledby="onboard-title">
      <div className="onboard-card">
        <p className="onboard-eyebrow">Welcome to Fate</p>

        {step === 'surfaces' && (
          <>
            <h1 className="onboard-title" id="onboard-title">
              Two surfaces do most of the work
            </h1>
            <p className="onboard-body">
              They are in the rail on the left, which is lit up now. Everything
              else in the app is a way of getting to a note; these two are ways
              of seeing all of them at once.
            </p>
            <ul className="onboard-list">
              <li>
                <Waypoints size={18} strokeWidth={1.75} aria-hidden="true" />
                <div>
                  <strong>Graph</strong>
                  <span>
                    Every note and every link between them. Drag one note onto
                    another to write the link into the Markdown.
                  </span>
                </div>
              </li>
              <li>
                <Frame size={18} strokeWidth={1.75} aria-hidden="true" />
                <div>
                  <strong>Canvas</strong>
                  <span>
                    Boards of cards, where a card is a file and an edge is the
                    order an agent walks them.
                  </span>
                </div>
              </li>
            </ul>
          </>
        )}

        {step === 'vault' && (
          <>
            <h1 className="onboard-title" id="onboard-title">
              Point Fate at your notes
            </h1>
            <p className="onboard-body">
              Pick a folder of Markdown files — an Obsidian vault works as it
              is, and both apps can use it at once. Nothing in it is moved,
              rewritten or copied out; Fate reads and writes the files in place.
            </p>
            <div className="onboard-folder">
              <button type="button" className="onboard-pick" onClick={pick} disabled={picking}>
                {picking ? 'Choosing…' : folder ? 'Choose a different folder' : 'Choose folder'}
              </button>
              {folder && <code className="onboard-path">{folder}</code>}
            </div>
            <p className="onboard-note">
              {settings?.pendingVaultDir
                ? 'Fate will open on this folder when you finish.'
                : folder
                  ? 'This is the folder Fate is reading now. You can change it here or later in Settings.'
                  : 'You can change this later in Settings, and skipping is fine — nothing is read until you choose one.'}
            </p>
          </>
        )}

        {step === 'theme' && (
          <>
            <h1 className="onboard-title" id="onboard-title">
              Make it yours
            </h1>
            <p className="onboard-body">
              Seven palettes. Each card is this window in that theme, so you can
              choose by looking rather than by applying one and undoing it.
            </p>
            {settings && (
              <ThemePicker
                value={settings.appearance.theme}
                onPick={(id) => {
                  const next = { ...settings.appearance, theme: id }
                  /**
                   * BOTH HALVES, and the second is the one that repaints.
                   *
                   * `setAppearance` persists; `applyAppearance` writes the
                   * `data-theme` attribute on <html>, which is what every
                   * palette in themes.css actually answers to. Doing only the
                   * first stored the choice and left the window in the old
                   * theme, so the tour's whole claim — choose by looking —
                   * silently did not hold. Same order SettingsDialog uses:
                   * paint optimistically, then repaint from what main
                   * sanitised and returned.
                   */
                  applyAppearance(next)
                  setSettings({ ...settings, appearance: next })
                  void window.api.settings
                    .setAppearance(next)
                    .then((s) => {
                      setSettings(s)
                      applyAppearance(s.appearance)
                    })
                    .catch(() => {
                      applyAppearance(settings.appearance)
                    })
                }}
              />
            )}
          </>
        )}

        <div className="onboard-foot">
          <span className="onboard-dots" aria-hidden="true">
            {STEPS.map((s) => (
              <i key={s} className={s === step ? 'onboard-dot onboard-dot--on' : 'onboard-dot'} />
            ))}
          </span>
          {/* Skipping is a real option and is not hidden behind a corner X.
              Somebody reinstalling has done this before. */}
          <button type="button" className="onboard-skip" onClick={finish}>
            Skip
          </button>
          {at > 0 && (
            <button
              type="button"
              className="onboard-back"
              onClick={() => setStep(STEPS[at - 1])}
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="onboard-next"
            onClick={() => (at === STEPS.length - 1 ? finish() : setStep(STEPS[at + 1]))}
          >
            {at === STEPS.length - 1 ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
