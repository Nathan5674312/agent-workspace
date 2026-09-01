import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { applyAppearance } from './appearance.js'
import { DEFAULT_APPEARANCE } from '../shared/ipc.js'
import './tokens.css'
import './base.css'
import './app.css'
// After tokens.css on purpose: these selectors override token defaults, and a
// tie is settled by source order.
import './appearance.css'
// Same rule, and it must stay after app.css too: a theme redefines the colour
// tokens, and app.css reads them rather than restating them, so a palette swap
// needs no change there.
import './themes.css'

/**
 * Appearance is read and applied BEFORE the first render, not in an effect.
 *
 * An effect runs after React has already painted, so a user with high contrast
 * or artwork off would see one frame of the default appearance every launch.
 * The settings live in main, so reading them is a promise no matter what; the
 * honest fix is to hold the render for that one IPC round trip rather than to
 * paint something we know is wrong.
 *
 * The failure path still renders. Losing the appearance override is a bad
 * launch; a blank window because settings.json could not be read is a broken
 * one.
 */
window.api.settings
  .get()
  .then((s) => applyAppearance(s.appearance))
  .catch(() => applyAppearance(DEFAULT_APPEARANCE))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
