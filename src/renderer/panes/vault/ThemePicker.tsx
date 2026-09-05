import { Check } from 'lucide-react'
import { THEMES, type ThemeId } from '../../../shared/themes.js'

/**
 * PICK A THEME BY LOOKING AT IT.
 *
 * What this replaced was a `<select>`: open Settings, choose a name, close
 * everything, look at the app, and go back if you disliked it. Nathan's words
 * for that loop — "you open a list, pick one, then click all the way out, and
 * if you like it keep it, but if not go all the way back" — are a description
 * of a control that cannot answer the only question being asked. A palette is
 * not a setting you reason about. It is one you see.
 *
 * EACH CARD IS THE APP, not a row of colour chips. Chips would be easier and
 * they answer the wrong question: nobody wants to know that Nord contains
 * #81a1c1, they want to know what a window of their notes looks like in it. So
 * the mockup carries the same parts in the same places as the real window —
 * ribbon, sidebar with note rows, a main pane with a title, body lines and one
 * accent — at a size where the relationship between them is what reads.
 *
 * THE COLOURS ARE NOT IN THIS FILE, and that is the whole reason this could be
 * built at all. `themes.css` declares every palette for a bare `[data-theme]`
 * as well as for `:root`, so a card simply carries the attribute and everything
 * inside it resolves to that palette — the same tokens the real window uses,
 * from the one file that defines them. A hex value here would be the second
 * source of truth that `shared/themes.ts` opens by refusing to be: retune a
 * palette and its own swatch would quietly stop matching it.
 *
 * `founders` has no attribute on <html> — the default sets none — so tokens.css
 * names it there. Without that, the Founder's card inside a Midnight window
 * would inherit Midnight and be the one swatch that lies.
 */
export function ThemePicker({
  value,
  disabled,
  onPick,
}: {
  value: ThemeId
  disabled?: boolean
  onPick: (id: ThemeId) => void
}) {
  const hint = THEMES.find((t) => t.id === value)?.hint ?? ''
  return (
    <div className="theme-picker">
      {/* A radiogroup, not a list of buttons: exactly one is chosen, and arrow
          keys should move between them the way they do in the OS. */}
      <div className="theme-grid" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => {
          const on = t.id === value
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              // The name and the hint, so a screen reader gets what the picture
              // gives everyone else. The mockup itself is decorative.
              aria-label={`${t.label}. ${t.hint}`}
              className={`theme-card${on ? ' theme-card--on' : ''}`}
              disabled={disabled}
              onClick={() => onPick(t.id)}
            >
              <span className="theme-mock" data-theme={t.id} aria-hidden="true">
                <span className="theme-mock-ribbon">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-mock-side">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-mock-main">
                  <i className="theme-mock-title" />
                  <i />
                  <i />
                  <i className="theme-mock-accent" />
                </span>
              </span>
              <span className="theme-card-foot">
                <span className="theme-card-name">{t.label}</span>
                {on && <Check size={13} strokeWidth={2.5} aria-hidden="true" />}
              </span>
            </button>
          )
        })}
      </div>
      {/* Kept from the <select> this replaced. The picture says what a palette
          looks like; the hint says what it is FOR, which is the half a picture
          of six dark themes cannot carry on its own. */}
      <p className="theme-picker-hint">{hint}</p>
    </div>
  )
}
