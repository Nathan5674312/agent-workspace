import { useEffect, useRef, useState } from 'react'
import './namedialog.css'

/**
 * Ask for a single name.
 *
 * THIS EXISTS BECAUSE `window.prompt` DOES NOT WORK IN ELECTRON. It is present
 * on `window` and it is a function, so nothing type-checks or greps as wrong —
 * it throws `prompt() is not supported.` the moment it is called. Verified on
 * the Electron 33 binary this app ships, not inferred:
 *
 *   typeof window.prompt  -> 'function'
 *   window.prompt('x')    -> throws  prompt() is not supported.
 *   window.confirm('x')   -> opens a real modal and blocks
 *
 * That asymmetry is the whole trap. "+ Folder" reasoned that because this pane
 * already asks with `window.confirm`, a native prompt was an established idiom
 * here — but `confirm` is implemented and `prompt` never has been. The throw
 * landed on the first line of the handler, before its own try/catch, and the
 * caller invoked it as `void handleNewFolder()`, so the rejection went nowhere.
 * The button did nothing at all, silently, which is the exact failure the
 * explorer header's own comment says this app refuses to ship.
 *
 * A real <dialog> + showModal(), copied from HelpDialog.tsx — which copied
 * SettingsDialog.tsx — rather than a shared modal component. Two dialogs is not
 * a design system; three is not either. The focus trap, Escape, the focus
 * restore on close and the top layer all come from the platform.
 */
export interface NameDialogProps {
  isOpen: boolean
  /** Heading. Also the accessible name of the dialog. */
  title: string
  /** Label above the field. Say where the thing will be created. */
  label: string
  placeholder?: string
  confirmLabel: string
  /**
   * Reject a name BEFORE anything is created, returning why. Runs on every
   * keystroke, so the reason is on screen while the name is still wrong rather
   * than in a banner after the fact.
   *
   * Not a containment check and no substitute for one — that lives in main,
   * where a renderer cannot skip it.
   */
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}

export function NameDialog({
  isOpen,
  title,
  label,
  placeholder,
  confirmLabel,
  validate,
  onSubmit,
  onCancel,
}: NameDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  /** Whether the press in flight began on the backdrop. A ref: the mouseup that
   *  reads it must not repaint anything in between. */
  const downOnBackdrop = useRef(false)

  /**
   * The element stays in the document when closed — a closed <dialog> is
   * `display: none` by UA rule, and close() is what hands focus back to the
   * button that opened this, which it can only do while still mounted.
   */
  useEffect(() => {
    if (!isOpen) return
    const el = dialogRef.current
    el?.showModal()
    // Cleared on OPEN rather than on close: a name left behind from last time
    // is the first thing Enter would submit.
    setValue('')
    inputRef.current?.focus()
    return () => el?.close()
  }, [isOpen])

  const trimmed = value.trim()
  // Empty is not an error to display — the field simply is not ready yet, and
  // shouting "required" at someone who has not typed anything is noise.
  const error = trimmed && validate ? validate(trimmed) : null
  const canSubmit = trimmed.length > 0 && !error

  return (
    <dialog
      className="name-overlay"
      ref={dialogRef}
      aria-labelledby="name-dialog-title"
      // The <dialog> IS the backdrop hit area; the panel is a child. Both ends
      // of the press must land on it, or a selection dragged out of the field
      // would dismiss the thing it was dragged out of.
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onCancel()
      }}
      // Escape arrives as `cancel`. preventDefault leaves the effect above as
      // the only thing that calls close(), so the element cannot drift out of
      // step with `isOpen`.
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
      // `cancel` does not consume the keydown that produced it, and nothing
      // behind this dialog may act on the same Escape.
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      {/* A real <form>, so Enter submits. Hand-wiring Enter onto the input is
          the usual way this ends up ignoring the disabled state. */}
      <form
        className="name-panel"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) onSubmit(trimmed)
        }}
      >
        <h2 className="name-title" id="name-dialog-title">
          {title}
        </h2>

        <label className="name-label" htmlFor="name-dialog-input">
          {label}
        </label>
        <input
          id="name-dialog-input"
          className="name-input"
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'name-dialog-error' : undefined}
        />

        {/* Reserved whether or not it is filled, so the panel does not jump a
            line taller the moment a name goes wrong. */}
        <p className="name-error" id="name-dialog-error" role="alert">
          {error ?? ' '}
        </p>

        <div className="name-actions">
          <button type="button" className="name-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="name-confirm" disabled={!canSubmit}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}
