/**
 * The drag handle between the sidebar and the canvas.
 *
 * THE WIDTH IS NOT REACT STATE, and that is the one design decision here worth
 * defending. It lives in a CSS custom property written straight to the DOM.
 *
 * <VaultPane> owns the edit buffer, so it re-renders on every keystroke in the
 * editor — and a width in its state would re-render the whole pane on every
 * pointermove of a drag, sixty times a second, rebuilding the folder tree and
 * the canvas to move one border. Writing `--vault-sidebar-w` on the layout
 * element instead lets the browser reflow just the two boxes that changed,
 * which is what makes the drag feel attached to the cursor rather than lagging
 * behind it.
 *
 * WINDOW LISTENERS FOR THE DRAG, added on pointerdown and removed on release.
 *
 * `setPointerCapture` is the tidier mechanism and was written here first: it
 * retargets every move to this element, so there is nothing to add and nothing
 * to leak. It was replaced because it could not be VERIFIED. Driving the built
 * app with `webContents.sendInputEvent`, the capturing element received the
 * pointerdown and then not one pointermove, while `document` received all of
 * them — capture does not retarget synthesized input in this Electron build.
 * That leaves no way to prove a drag works other than by hand, and the same
 * gap already shipped one bug this week.
 *
 * So: the mechanism that can be driven wins over the one that reads better.
 * Teardown is a single function held in a ref, called by pointerup, by
 * pointercancel, and by the unmount effect — one path, so a listener cannot
 * outlive the drag that added it. The pane's history of leaked observers is why
 * `test/review-s2-vault-pane.test.mjs` checks for cleanup.
 *
 * Keyboard too: a mouse-only resizer is a control a keyboard user cannot reach,
 * which `docs/ACCESSIBILITY.md` treats the same as a control that does nothing.
 */
import { useEffect, useRef } from 'react'
import './resizer.css'

/** Bounds in px. Below MIN the tree is unreadable; above MAX the canvas is. */
const MIN = 180
const MAX = 720
/** One arrow press. Matches the step a person expects from a slider. */
const STEP = 16

export interface SidebarResizerProps {
  /** The element carrying `--vault-sidebar-w`. Its subtree reads the value. */
  targetRef: React.RefObject<HTMLElement | null>
}

export function SidebarResizer({ targetRef }: SidebarResizerProps) {
  const handleRef = useRef<HTMLDivElement>(null)
  /** Pointer origin and the width at the moment the drag began. */
  const drag = useRef<{ x: number; width: number } | null>(null)
  /** Removes this drag's window listeners. Null when no drag is in flight. */
  const endDrag = useRef<(() => void) | null>(null)

  // A drag in flight when this unmounts would leave two window listeners behind
  // and a ref nobody will ever clear. Same teardown as a normal release.
  useEffect(() => () => endDrag.current?.(), [])

  const currentWidth = (): number => {
    const el = targetRef.current
    if (!el) return MIN
    // Read the sidebar's real box rather than the variable: on the first drag
    // the variable is unset, and parsing "" would start every resize from zero.
    const sidebar = el.querySelector('.vault-sidebar')
    return sidebar ? Math.round(sidebar.getBoundingClientRect().width) : MIN
  }

  const apply = (width: number): void => {
    const clamped = Math.max(MIN, Math.min(MAX, Math.round(width)))
    targetRef.current?.style.setProperty('--vault-sidebar-w', `${clamped}px`)
    // aria-valuenow is set the same way, for the same reason the width is: a
    // screen reader needs the live number, and routing it through React state
    // would reintroduce the per-frame re-render this file exists to avoid.
    handleRef.current?.setAttribute('aria-valuenow', String(clamped))
  }

  return (
    <div
      ref={handleRef}
      className="vault-sidebar-resizer"
      // A separator with a value is the role a resizable split has. Without
      // `tabIndex` it is announced and unreachable, which is worse than silent.
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        // Ignore anything but the primary button: a right-click drag on a
        // resizer is an accident, and a middle-click paste is not a resize.
        if (e.button !== 0) return
        // A second pointerdown without a release (a lost pointerup, a second
        // finger) must not stack a second pair of listeners.
        endDrag.current?.()
        drag.current = { x: e.clientX, width: currentWidth() }

        const onMove = (ev: PointerEvent): void => {
          if (!drag.current) return
          apply(drag.current.width + (ev.clientX - drag.current.x))
        }
        const stop = (): void => {
          drag.current = null
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', stop)
          // `pointercancel` fires when the gesture is taken away — the window
          // losing focus mid-drag. Without it the resizer stays armed and the
          // next stray move resizes from a stale origin.
          window.removeEventListener('pointercancel', stop)
          endDrag.current = null
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
        endDrag.current = stop

        // Stops the drag from selecting the folder tree's text as it passes.
        e.preventDefault()
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') apply(currentWidth() - STEP)
        else if (e.key === 'ArrowRight') apply(currentWidth() + STEP)
        else if (e.key === 'Home') apply(MIN)
        else if (e.key === 'End') apply(MAX)
        else return
        // Only for the keys handled above: Tab and Escape must still do their
        // jobs, and the arrow keys must not also scroll the pane behind.
        e.preventDefault()
      }}
      // Double-click resets, the convention every split pane has.
      onDoubleClick={() => apply(240)}
      title="Drag to resize · double-click to reset"
    />
  )
}
