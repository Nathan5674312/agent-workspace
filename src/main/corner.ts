/**
 * SECTION 3 — Agent corner, main-process half.
 *
 * The ONE consent surface in the app. Everything consequential asks here:
 * Claude Code tool permissions, vault syncs over the network, anything that
 * leaves the machine.
 *
 * Design rules that are not up for negotiation:
 *   - Silence is the default. If the common path is not "nothing happened",
 *     it is wrong. Known device on a trusted network => no prompt at all.
 *   - Never a bare yes/no. Every consent states what happens, to which device,
 *     over which network.
 *   - Never silently overwrite. This pane is where a human gets to stop it.
 *   - Artifacts are a VIEW of a file on disk, never the only copy. Dismissing
 *     an item must not lose anything.
 */
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Handle } from './ipc.js'
import { CH, EV, type CornerItem, type ConsentDecision } from '../shared/ipc.js'

/**
 * Pending consents, keyed by generated ID. Resolve when the renderer answers
 * on CH.cornerDecide. A consent that is never answered never resolves.
 */
const pending = new Map<
  string,
  {
    resolver: (allow: boolean) => void
  }
>()

/**
 * Send an event to EVERY window, not just the focused one.
 *
 * `getFocusedWindow()` returns null whenever the app is in the background —
 * which is the normal state while an agent is working. Addressing only the
 * focused window silently dropped consent prompts on the floor: the tool call
 * blocked forever with nothing on screen.
 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * All items currently in the corner (artifacts and consents). Sent to the
 * renderer on request and pushed incrementally as they arrive.
 */
const items: CornerItem[] = []

/**
 * Called by other main-process modules (notably claude.ts permission callbacks
 * and any future sync path). Resolves true ONLY when a human clicks allow.
 * Deny and dismiss both resolve false. Ignoring the prompt resolves nothing —
 * the caller waits, which is the safe direction.
 *
 * Timeouts are explicitly not implemented. There is no elapsed time after
 * which this resolves true, and no code path that resolves true without a
 * human answer.
 */
export function requestConsent(
  item: Omit<Extract<CornerItem, { kind: 'consent' }>, 'id' | 'at' | 'kind'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Collision here means one human answer resolves a DIFFERENT tool call, so
    // this is not a place for Math.random().
    const id = randomUUID()
    const consent: CornerItem = {
      kind: 'consent',
      id,
      ...item,
      at: Date.now(),
    }

    pending.set(id, { resolver: resolve })
    items.push(consent)
    push(consent)
  })
}

/**
 * Send an artifact or notice to the renderer immediately.
 * Artifacts are views of files on disk, not the only copy.
 */
export function push(item: CornerItem): void {
  // Add to tracking if not already there (consent is added in requestConsent).
  if (!items.some((i) => i.id === item.id)) {
    items.push(item)
  }

  broadcast(EV.cornerPush, item)
}

/**
 * Remove an item from the corner and tell the renderer it is gone.
 *
 * Dismissing a CONSENT denies it. It used to leave the promise pending
 * forever: the item vanished from `items` (so no remount could resurface it)
 * while the caller's tool call blocked with nothing on screen and no way to
 * recover. Worse, the entry stayed in `pending`, so a later message carrying
 * the same id still resolved it TRUE — a dismissed prompt could be allowed
 * after the fact. Denying is the only reading of "dismiss" that is safe: the
 * action does not happen, the caller gets an answer, and the human can ask
 * again. Silence must never be consent, but it must also never be a deadlock.
 *
 * Dismissing an artifact only removes the view. The file on disk is untouched.
 */
function dismiss(id: string): void {
  const idx = items.findIndex((i) => i.id === id)
  if (idx >= 0) {
    items.splice(idx, 1)
  }

  const waiting = pending.get(id)
  if (waiting) {
    pending.delete(id)
    waiting.resolver(false)
  }

  broadcast(EV.cornerResolved, id)
}

/**
 * Decide a consent. The renderer sends this when the human chooses allow/deny.
 * Anything that is not literally `true` is a denial — a malformed or truthy
 * non-boolean payload must never read as permission.
 */
function decide(decision: ConsentDecision): void {
  if (!decision || typeof decision.id !== 'string') return

  const pending_item = pending.get(decision.id)
  if (!pending_item) return

  pending.delete(decision.id)

  const idx = items.findIndex((i) => i.id === decision.id)
  if (idx >= 0) items.splice(idx, 1)

  pending_item.resolver(decision.allow === true)

  // Notify the renderer that this item has been resolved so it can update its UI.
  broadcast(EV.cornerResolved, decision.id)
}

export function register(handle: Handle): void {
  handle(CH.cornerItems, () => items)

  handle(CH.cornerDecide, (decision: ConsentDecision) => {
    decide(decision)
  })

  handle(CH.cornerDismiss, (id: string) => {
    dismiss(id)
  })
}
