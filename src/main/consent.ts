/**
 * THE CONSENT GATE — who may mutate the vault, and when a human gets asked.
 *
 * src/shared/ipc.ts used to state the rule as "anything that mutates the vault
 * is a consent-gated call". Nothing implemented it, and implementing it as
 * written would have been worse than leaving it fictional: gating save() means
 * prompting the user for permission to save the file they are typing. That is
 * approval fatigue, and a human who has learned to click through a prompt is in
 * a worse position than one who was never prompted at all.
 *
 * So the axis is WHO, not WHAT:
 *
 *   user-originated   the person clicked or typed. They ARE the consent.
 *                     Proceeds silently. No prompt, ever.
 *   agent-originated  something autonomous decided. Gated. Does not happen
 *                     until a human answers, and the agent's stated reason is
 *                     put in front of them.
 *
 * The IPC boundary separates the two for free, which is what makes this
 * enforceable rather than aspirational: everything arriving over IPC came from
 * the renderer, and the renderer contains no agent. An agent is main-process
 * code calling vault.ts directly. So src/main/ipc.ts hard-codes
 * `{ kind: 'user' }` and an agent has to construct its own Actor — there is no
 * channel it could send one over, and no way for renderer input to forge one.
 *
 * This is the SECOND layer, not a replacement for the first. `.trash/` and
 * moves.jsonl mean a mistake is reversible; consent means fewer mistakes get
 * made unattended. Neither one makes the other unnecessary.
 */
import type { Actor } from '../shared/ipc.js'
import { requestConsentOutcome } from './corner.js'

/**
 * The mutating operations. Allowances are keyed per kind, so approving a run of
 * moves never quietly also approves writes.
 */
export type OpKind = 'save' | 'mkdir' | 'move' | 'undo-move'

/** How each kind is described to the human being asked. */
const LABEL: Record<OpKind, string> = {
  save: 'write to',
  mkdir: 'create the folder',
  move: 'move',
  'undo-move': 'undo the move of',
}

/**
 * A human said no, or dismissed the prompt.
 *
 * A distinct class for the same reason SaveConflict and MoveConflict are ones:
 * a caller has to be able to tell "refused" apart from "failed", and it cannot
 * do that by matching on a message. Refused means NOTHING HAPPENED — the gate
 * runs before the first filesystem call in every function that uses it, so a
 * ConsentDenied is a guarantee about the disk, not merely about control flow.
 *
 * Fields are declared and assigned explicitly rather than as TS parameter
 * properties, matching SaveConflict and MoveConflict: this module is imported
 * directly by `node --test` under type stripping, which erases parameter
 * properties and would leave the fields undefined at runtime.
 */
export class ConsentDenied extends Error {
  kind: OpKind
  constructor(kind: OpKind) {
    super('The action was not allowed.')
    this.name = 'ConsentDenied'
    this.kind = kind
  }
}

/**
 * Session-scoped allowances: `sessionId \0 kind` -> credits remaining.
 *
 * ONE structure for both lifetimes, because they differ only in how many
 * operations they cover:
 *   - `Infinity`  the human chose "allow for this session". Lasts until the
 *                 process ends.
 *   - a finite n  a batch grant. Covers exactly the n operations that were
 *                 listed in the prompt, then expires.
 *
 * A plain module-level Map is the whole persistence story, deliberately. This
 * must NOT survive a restart: an allowance that outlives the session that
 * earned it is permission the user granted to one piece of work being spent on
 * another, with no prompt to notice it by. Writing it to disk would be a
 * feature request, not a fix.
 *
 * Keyed by sessionId first, so one agent session can never spend another's
 * credit. The separator is NUL, which cannot occur in either component.
 */
const allowances = new Map<string, { remaining: number }>()

function keyOf(sessionId: string, kind: OpKind): string {
  return `${sessionId}\u0000${kind}`
}

/**
 * Spend one credit. Returns true if this operation is already covered.
 *
 * Exactly one credit per gated operation, never one per path named: a move
 * mentions two paths and is still one thing to approve. Getting that wrong
 * would let a 20-move grant be drained by 10 moves.
 */
function consume(key: string): boolean {
  const allowance = allowances.get(key)
  if (!allowance) return false
  if (allowance.remaining === Infinity) return true
  if (allowance.remaining < 1) return false
  allowance.remaining -= 1
  if (allowance.remaining === 0) allowances.delete(key)
  return true
}

/**
 * Validate the actor, and refuse anything that is not clearly one.
 *
 * This runs for USER actors too. The question is not "is this an agent" but
 * "did the caller say who it is at all" — a forgotten argument arrives here as
 * `undefined`, because type annotations are erased at runtime, and the honest
 * answer to an absent "who is doing this?" is to refuse rather than to assume
 * the benign case.
 */
function requireActor(actor: Actor): void {
  // Deliberately typed as unknown fields rather than as a Partial<Actor>: the
  // whole point is to check values the type system has already been told are
  // fine, because the annotation is erased at runtime and the argument may have
  // come from JavaScript that never saw it.
  const a = actor as { kind?: unknown; sessionId?: unknown; reason?: unknown } | undefined | null

  if (!a || typeof a !== 'object') {
    throw new Error('consent: this call requires an actor saying who is mutating the vault')
  }
  if (a.kind === 'user') return
  if (a.kind !== 'agent') {
    throw new Error('consent: an actor must be { kind: "user" } or { kind: "agent", ... }')
  }
  if (typeof a.sessionId !== 'string' || a.sessionId.trim() === '') {
    throw new Error('consent: an agent actor needs a sessionId')
  }
  // The reason is not decoration. It is the only thing the human has to judge
  // by, so a blank one reduces the prompt to a bare yes/no — which the corner's
  // own design rules forbid. An agent that cannot say why does not get to act.
  if (typeof a.reason !== 'string' || a.reason.trim() === '') {
    throw new Error('consent: an agent actor needs a non-empty reason')
  }
}

/** At most ten paths in the sentence; the rest are counted, not listed. */
function summarise(what: readonly string[]): string {
  if (what.length <= 10) return what.join(' · ')
  return `${what.slice(0, 10).join(' · ')} · +${what.length - 10} more`
}

/**
 * Ask once, for one or many operations. Returns true if they may proceed.
 *
 * `count` is how many operations the answer covers, and it is what a granted
 * batch is bounded by — an agent that declares 20 gets credit for 20, not for
 * the rest of the run. "Allow for this session" is the only answer that lifts
 * the bound, and only for this sessionId and this kind.
 */
async function ask(
  actor: Extract<Actor, { kind: 'agent' }>,
  kind: OpKind,
  what: readonly string[],
  count: number,
): Promise<boolean> {
  const outcome = await requestConsentOutcome({
    title:
      count === 1
        ? `Agent wants to ${LABEL[kind]} a file in your vault`
        : `Agent wants to ${LABEL[kind]} ${count} files in your vault`,
    // Every clause earns its place: what is about to happen, the agent's own
    // stated reason, the exact paths, and which session is asking.
    detail:
      `An agent wants to ${LABEL[kind]} ${count === 1 ? 'this' : `these ${count}`}: ` +
      `${summarise(what)}. Its reason: "${actor.reason.trim()}". ` +
      `Session ${actor.sessionId}. Nothing is deleted — the original goes to the ` +
      `vault's trash and can be put back.`,
    // 'warn', not 'info': an autonomous process is changing the user's files,
    // which is the case the corner's warn styling exists for.
    severity: 'warn',
  })

  if (outcome === 'deny') return false
  if (outcome === 'session') {
    allowances.set(keyOf(actor.sessionId, kind), { remaining: Infinity })
  }
  return true
}

/**
 * The gate every mutating vault call passes through, BEFORE it touches disk.
 *
 * `what` is the paths involved, for the human to read. It does not affect the
 * accounting — one call is one operation regardless of how many paths it names.
 */
export async function gate(actor: Actor, kind: OpKind, what: readonly string[]): Promise<void> {
  requireActor(actor)
  if (actor.kind === 'user') return

  if (consume(keyOf(actor.sessionId, kind))) return
  if (!(await ask(actor, kind, what, 1))) throw new ConsentDenied(kind)
}

/**
 * Run a batch of operations behind ONE consent.
 *
 * Filing twenty notes must be one prompt listing twenty notes, not twenty
 * prompts. Twenty prompts is not twenty times the safety; it is a person
 * holding down the allow button, after which the twenty-first prompt — the one
 * that mattered — is allowed too.
 *
 * `operations` is one human-readable line per operation, so its length is both
 * what the prompt states and what the grant is bounded by. Inside `run`, calls
 * to `gate()` with the same actor and kind spend that grant instead of asking
 * again; anything of a DIFFERENT kind still asks, because that is not what was
 * approved.
 *
 * The grant is torn down in a `finally`, so credits declared and not used
 * cannot leak into later work. A session-scoped allowance granted from inside
 * is deliberately left standing — the human widened it on purpose.
 */
export async function withBatchConsent<T>(
  actor: Actor,
  kind: OpKind,
  operations: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  requireActor(actor)
  if (actor.kind === 'user') return run()

  const key = keyOf(actor.sessionId, kind)

  // Already trusted for the session: there is nothing left to ask.
  if (allowances.get(key)?.remaining === Infinity) return run()

  if (!(await ask(actor, kind, operations, operations.length))) throw new ConsentDenied(kind)

  // 'session' already installed an unbounded allowance; do not narrow it.
  if (allowances.get(key)?.remaining !== Infinity) {
    allowances.set(key, { remaining: operations.length })
  }

  try {
    return await run()
  } finally {
    if (allowances.get(key)?.remaining !== Infinity) allowances.delete(key)
  }
}

/**
 * Drop every allowance. For tests, which must not inherit each other's grants —
 * the same reason vault.ts exposes `_setVaultDirForTest`.
 */
export function _resetAllowancesForTest(): void {
  allowances.clear()
}
