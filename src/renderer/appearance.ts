/**
 * The one place appearance settings reach the DOM.
 *
 * Two callers: main.tsx at boot (before the first render, so nothing paints in
 * the wrong mode) and SettingsDialog on every change (so a control is felt the
 * instant it moves, not on the next launch).
 *
 * Everything it does is on <html>, because that is where the CSS in
 * appearance.css and the custom properties in tokens.css both live.
 */
import { ARTWORK_OPACITY_MAX, type Appearance } from '../shared/ipc.js'

/**
 * `null` REMOVES the attribute, and that is the whole design rather than a
 * convenience: an absent attribute is what lets the `@media` blocks in app.css
 * keep running. Writing `data-motion="system"` instead would leave a selector
 * for someone to later attach "system" styles to, which is precisely the
 * mistake this shape makes unavailable.
 */
function attr(name: string, value: string | null): void {
  if (value === null) document.documentElement.removeAttribute(name)
  else document.documentElement.setAttribute(name, value)
}

export function applyAppearance(a: Appearance): void {
  // The union members ARE the attribute values, so there is no mapping table to
  // fall out of sync with appearance.css — only the 'system' case to drop.
  // No data-contrast: the in-app contrast override was removed, and
  // `@media (prefers-contrast: more)` in app.css covers it from the OS.
  attr('data-transparency', a.transparency === 'system' ? null : a.transparency)
  attr('data-motion', a.motion === 'system' ? null : a.motion)
  attr('data-artwork', a.artwork ? null : 'off')

  // Continuous, so it cannot be an enumerable attribute in the stylesheet.
  // Clamped here as well as in main because the dialog applies optimistically
  // while the slider moves: main's clamp has not run yet at that moment, and
  // the ceiling in tokens.css must not be exceeded for even one frame.
  document.documentElement.style.setProperty(
    '--canvas-art-opacity',
    String(Math.min(Math.max(a.artworkOpacity, 0), ARTWORK_OPACITY_MAX)),
  )
}
