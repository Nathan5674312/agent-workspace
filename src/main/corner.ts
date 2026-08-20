/**
 * SECTION 3 — Agent corner, main-process half.
 *
 * The ONE consent surface in the app. Everything consequential asks here:
 * agent tool calls, agent-originated vault mutations (via src/main/consent.ts),
 * vault syncs over the network, anything that leaves the machine.
 *
 * Note what is NOT here: a user-originated vault write. The person clicked or
 * typed, so there is nobody left to ask — see the actor rule in
 * src/shared/ipc.ts. Prompting for those is what makes a consent surface
 * background noise, and background noise is what gets clicked through.
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
type PendingConsent = {
  resolver: (allow: boolean) => void
  /**
   * The scope the human picked, stamped by decide() in the instant BEFORE it
   * resolves. It travels on this object rather than through the resolver on
   * purpose: the resolver stays `(allow: boolean)` so decide() can keep calling
   * it as literally `resolver(decision.allow === true)`, which is the audited
   * invariant that nothing but a human's explicit true ever grants permission.
   * Widening the resolver to carry a decision object would have blurred that
   * line for a field that only matters once the answer is already "allow".
   */
  scope: 'once' | 'session'
}

const pending = new Map<string, PendingConsent>()

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
 * Called by other main-process modules (notably the network sync path
 * and anything added later). Resolves true ONLY when a human clicks allow.
 * Deny and dismiss both resolve false. Ignoring the prompt resolves nothing —
 * the caller waits, which is the safe direction.
 *
 * This form takes no timeout, so for these callers there is still no elapsed
 * time after which the prompt settles at all. And no timeout anywhere resolves
 * TRUE: expiry is a denial. There remains no code path that grants permission
 * without a human answer.
 */
export function requestConsent(
  item: Omit<Extract<CornerItem, { kind: 'consent' }>, 'id' | 'at' | 'kind'>,
): Promise<boolean> {
  return requestConsentOutcome(item).then((outcome) => outcome !== 'deny')
}

/**
 * What a human's answer authorises. 'deny' also covers dismissal and every
 * malformed reply — there is no fourth value and no value that means "assume".
 */
export type ConsentOutcome = 'deny' | 'once' | 'session'

/**
 * As requestConsent, but reports WHETHER the allowance was for this one action
 * or for the rest of the session. src/main/consent.ts needs that distinction
 * to record a session-scoped allowance; claude.ts does not care and uses the
 * boolean wrapper above. One code path, two views of it.
 *
 * Everything the boolean form promises still holds here: no path that settles
 * without a human EXCEPT an expired `timeoutMs`, and denial is the value every
 * non-answer takes — including that expiry.
 *
 * `timeoutMs` is opt-in and omitted by default, so a caller that says nothing
 * still waits forever, exactly as before. When it is given, expiry runs the
 * same `dismiss()` path a human's dismissal runs: the item leaves the corner,
 * the renderer is told, and the caller is answered DENY. Never allow — an
 * unattended prompt is the one case where assuming consent would hand an agent
 * the vault precisely because nobody was watching. The same reasoning as
 * network.ts: if we cannot determine the answer, treat it as untrusted.
 */
export function requestConsentOutcome(
  item: Omit<Extract<CornerItem, { kind: 'consent' }>, 'id' | 'at' | 'kind'>,
  timeoutMs?: number,
): Promise<ConsentOutcome> {
  // Seeded with 'once' so a reply that names no scope narrows rather than
  // widens, and so the field is never read before decide() has written it.
  const entry: PendingConsent = { resolver: () => {}, scope: 'once' }
  let timer: ReturnType<typeof setTimeout> | undefined

  const answered = new Promise<boolean>((resolve) => {
    // Collision here means one human answer resolves a DIFFERENT tool call, so
    // this is not a place for Math.random().
    const id = randomUUID()
    const consent: CornerItem = {
      kind: 'consent',
      id,
      ...item,
      at: Date.now(),
    }

    entry.resolver = resolve
    pending.set(id, entry)
    items.push(consent)
    push(consent)

    // Anything that is not a usable positive duration means "no timeout",
    // rather than an immediate or a NaN-length one.
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => dismiss(id), timeoutMs)
    }
  })

  return answered.then((allowed) => {
    // A human beat the clock; do not leave a timer that would later dismiss a
    // consent this promise has already settled.
    clearTimeout(timer)
    return allowed ? entry.scope : 'deny'
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

  // Stamped before resolving, so the waiting caller reads a settled value.
  // Only the exact string 'session' widens the answer; anything else — absent,
  // misspelt, a truthy non-string — stays 'once', for the same reason
  // `allow` is compared against literal true below.
  pending_item.scope = decision.scope === 'session' ? 'session' : 'once'

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
