/**
 * A dropdown menu hung off an icon button. Three callers: the tab-list chevron,
 * the tab actions ellipsis, and the note header's "More options".
 *
 * BUILT ON THE NATIVE POPOVER API, which is the reason this file is short. The
 * renderer is always Chromium (Electron 33 → Chromium 130), so the four things
 * a hand-rolled dropdown always gets wrong are the platform's job here:
 *
 *   - light dismiss: a click anywhere outside closes it, with no document-level
 *     listener to add and therefore none to leak on unmount;
 *   - Escape closes it;
 *   - focus returns to the invoking button on close;
 *   - it renders in the TOP LAYER, so no z-index and no clipping by an
 *     ancestor's `overflow`.
 *
 * Same reasoning SettingsDialog.tsx applies to <dialog> + showModal(), one
 * component over. This pane bans timers outright, and every JS dropdown ends up
 * wanting one for its close animation; the native one has nothing to schedule.
 *
 * Positioning is CSS anchor positioning in ./menu.css, so nothing here measures
 * a rect. It is not free of bookkeeping, though: the spec makes a popover's
 * invoker its implicit anchor, and Chromium 130 does not apply that yet, so
 * every menu needs an explicit `anchor-name` / `position-anchor` pair keyed on
 * the `id` below. Adding a menu without one puts it in the corner of the
 * window; the test suite fails on that rather than letting it be discovered.
 */
import { useState, type ReactNode } from 'react'
import './menu.css'

export interface PaneMenuProps {
  /**
   * DOM id of the popover, and the value each item's `menu` prop must carry.
   * Passed in rather than taken from `useId()` because it is also written into
   * `popovertarget`, and a debuggable literal beats React's generated form when
   * someone is looking at the element in devtools.
   */
  id: string
  /** Class on the BUTTON. The existing control keeps its class and its styling. */
  className: string
  /** Accessible name and tooltip. Icon-only buttons have nothing else. */
  label: string
  icon: ReactNode
  /** True when there is nothing for the menu to act on at all. */
  disabled?: boolean
  children: ReactNode
}

export function PaneMenu({
  id,
  className,
  label,
  icon,
  disabled,
  children,
}: PaneMenuProps) {
  /**
   * Mirrors the popover's own state for `aria-expanded` only. The popover does
   * not need React to know whether it is open — this is the one fact the
   * platform will not announce for us, because `aria-expanded` lives on the
   * button and the state lives on the panel.
   */
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        className={className}
        popoverTarget={id}
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        title={label}
      >
        {icon}
      </button>
      <div
        id={id}
        popover="auto"
        className="pane-menu"
        role="menu"
        aria-label={label}
        onToggle={(e) => setOpen(e.currentTarget.matches(':popover-open'))}
      >
        {children}
      </div>
    </>
  )
}

export interface PaneMenuItemProps {
  /** The owning `PaneMenu`'s `id`. This is what closes the menu on click. */
  menu: string
  onClick: () => void
  /**
   * Set when the action exists but cannot run right now (no note open, only one
   * tab). `reason` then becomes the tooltip. An item that can NEVER act does
   * not belong on the menu at all — a dead row is the same lie as a dead
   * button, one level deeper.
   */
  disabled?: boolean
  reason?: string
  children: ReactNode
}

export function PaneMenuItem({
  menu,
  onClick,
  disabled,
  reason,
  children,
}: PaneMenuItemProps) {
  return (
    <button
      className="pane-menu-item"
      role="menuitem"
      // Closing is declarative: the same click that runs the action also hides
      // the popover, so there is no state to flip and no way for the menu to be
      // left open over a screen that has already changed underneath it.
      popoverTarget={menu}
      popoverTargetAction="hide"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? reason : undefined}
    >
      {children}
    </button>
  )
}
