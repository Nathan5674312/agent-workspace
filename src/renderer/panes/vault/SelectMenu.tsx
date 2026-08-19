/**
 * A select that looks like this app.
 *
 * WHY NOT A `<select>`: the closed control was already themed, but the LIST it
 * opens is drawn by the operating system — white ground, system font, blue
 * highlight — against a dark warm palette. That mismatch is what this replaces,
 * and it is not fixable with CSS here: `<option>` takes almost no styling, and
 * the customizable-select feature that would fix it properly
 * (`appearance: base-select`) landed in Chrome 135. Measured, not assumed —
 * this renderer is Chromium 130 and `CSS.supports('appearance','base-select')`
 * is false.
 *
 * So the list is a themed popover instead, reusing <PaneMenu>: same light
 * dismiss, same Escape, same focus restore, same top layer, all from the
 * platform. Nothing new was invented for this.
 *
 * WHAT IS LOST by not being a real `<select>`, stated plainly: type-ahead (press
 * "s" to jump to the first option starting with s) and the OS's own keyboard
 * conventions. Arrow keys still move through the options because they are
 * buttons in a menu. If these lists ever grow past a screenful, that trade gets
 * worse and a real listbox with type-ahead becomes the right build.
 */
import { ChevronDown } from 'lucide-react'
import { PaneMenu, PaneMenuItem } from './PaneMenu.js'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectMenuProps<T extends string> {
  /**
   * DOM id, and the key its anchor pair is written against in menu.css. Every
   * instance needs its own pair; the suite fails on a menu without one, because
   * an unanchored popover opens in the corner of the window.
   */
  id: string
  /** Accessible name. The visible label beside the control is separate. */
  label: string
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** Class on the trigger, so each caller keeps the styling it already had. */
  className?: string
}

export function SelectMenu<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  className,
}: SelectMenuProps<T>) {
  const current = options.find((o) => o.value === value)

  return (
    <PaneMenu
      id={id}
      className={className ? `select-menu ${className}` : 'select-menu'}
      label={label}
      // The current value IS the trigger's text, the way a select reads. Falling
      // back to the label rather than to empty: a control showing nothing looks
      // broken, and a value outside the option list is a caller bug worth seeing.
      text={current?.label ?? label}
      icon={<ChevronDown size={12} aria-hidden="true" />}
      panelClass="pane-menu--start"
    >
      {options.map((o) => (
        <PaneMenuItem key={o.value} onClick={() => onChange(o.value)}>
          {/* aria-current, not a tick glyph: the check would need a column of
              its own at every row to stop the labels shifting, and the state is
              already carried for assistive tech this way. */}
          <span aria-current={o.value === value}>{o.label}</span>
        </PaneMenuItem>
      ))}
    </PaneMenu>
  )
}
