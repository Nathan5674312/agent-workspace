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
import { DEFAULT_THEME } from '../shared/themes.js'

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
  // The founder's palette IS tokens.css, so it sets no attribute and nothing in
  // themes.css matches — the same reason 'system' sets none above. This is what
  // keeps the owner's measured palette from existing in two places.
  attr('data-theme', a.theme === DEFAULT_THEME ? null : a.theme)
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

  paintWindowControls()
}

/**
 * Hand the active palette to the OS, which paints the window controls.
 *
 * The window has no title bar: minimise, maximise and close are drawn by
 * Windows over the app's own top strip. The OS cannot read a CSS variable, and
 * there are seven themes here, one of them light (parchment) — so without this
 * the strip behind those buttons keeps whatever the first frame guessed and is
 * wrong in six of them.
 *
 * READ AFTER the attributes above are set, so `getComputedStyle` resolves the
 * theme that was just applied rather than the one being replaced.
 *
 * Colours rather than a theme name, so the palette has exactly one definition
 * — themes.css — instead of a second copy in the main process that drifts the
 * first time one is retuned.
 */
function paintWindowControls(): void {
  const css = getComputedStyle(document.documentElement)
  const color = hex(css.getPropertyValue('--bg-app'))
  const symbolColor = hex(css.getPropertyValue('--label'))
  if (!color || !symbolColor) return
  // Fire and forget. A window built without the overlay, or a platform that
  // has none, rejects — and a theme change must not fail over the colour of a
  // close button.
  void window.api?.window?.setOverlay(color, symbolColor).catch(() => {})
}

/**
 * `#rrggbb` or nothing.
 *
 * `getComputedStyle` returns whatever the stylesheet wrote for a custom
 * property — these are authored as hex, but a shorthand or an `rgb()` would
 * come back as typed. Main refuses anything that is not six-digit hex, so the
 * conversion happens here where the value is known rather than by loosening
 * the check at the boundary.
 */
function hex(raw: string): string | null {
  const v = raw.trim()
  if (/^#[0-9a-f]{6}$/i.test(v)) return v
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return '#' + [...v.slice(1)].map((c) => c + c).join('')
  }
  const m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i)
  if (!m) return null
  return (
    '#' +
    m
      .slice(1, 4)
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
      .join('')
  )
}
