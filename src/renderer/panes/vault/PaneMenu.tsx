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
  /**
   * Visible text in the trigger, before the icon. Icon-only menus leave this
   * out; a select-style menu shows its current value here, which is the whole
   * difference between the two shapes.
   */
  text?: string
  /** Extra class on the PANEL, for alignment variants. See menu.css. */
  panelClass?: string
  /** True when there is nothing for the menu to act on at all. */
  disabled?: boolean
  children: ReactNode
}

export function PaneMenu({
  id,
  className,
  label,
  icon,
  text,
  panelClass,
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
        {text}
        {icon}
      </button>
      <div
        id={id}
        popover="auto"
        className={panelClass ? `pane-menu ${panelClass}` : 'pane-menu'}
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
  onClick,
  disabled,
  reason,
  children,
}: PaneMenuItemProps) {
  return (
    <button
      className="pane-menu-item"
      role="menuitem"
      /**
       * CLOSE FIRST, THEN ACT — and close imperatively, not with
       * `popovertargetaction="hide"`.
       *
       * The declarative form was here and was wrong in a way that only a human
       * clicking the thing would find. `popovertargetaction` is an ACTIVATION
       * BEHAVIOUR, which the browser runs AFTER the click event has finished
       * dispatching. React handles the click first and, for a discrete event,
       * flushes the re-render synchronously. So a row whose own action disables
       * it — "Close this tab" on the second-to-last tab, which leaves one tab
       * and one disabled row — was already `disabled` by the time the browser
       * got round to the hide. A disabled button has no activation behaviour,
       * the hide was skipped in silence, and the menu sat open in the top layer
       * over a screen that had already changed.
       *
       * That also cost the NEXT click: a `popover=auto` left open swallows one
       * click anywhere outside it as its light-dismiss, so pressing "+" after
       * this appeared to do nothing at all.
       *
       * Hiding here runs during dispatch, while the button is still enabled and
       * mounted, so no re-render can race it. `hidePopover()` restores focus to
       * the invoker exactly as the declarative form did.
       */
      onClick={(e) => {
        const panel = e.currentTarget.closest('[popover]')
        if (panel instanceof HTMLElement && panel.matches(':popover-open')) {
          panel.hidePopover()
        }
        onClick()
      }}
      disabled={disabled}
      title={disabled ? reason : undefined}
    >
      {children}
    </button>
  )
}
