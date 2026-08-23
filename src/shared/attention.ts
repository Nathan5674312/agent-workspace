/**
 * WHICH BOARDS NEED SOMETHING DOING, AND BY WHOM.
 *
 * `run.ts` records what happened. This answers what should happen now, and it
 * exists because three separate things were all blocked on the same missing
 * piece: a pipeline that advances without somebody asking it to. The maintenance
 * board on `Home.canvas` is supposed to run periodically. A board parked on a
 * question is supposed to resume when the answer arrives. A dashboard is
 * supposed to update when the thing it displays changes. None of them can, while
 * the only way a board moves is a person saying "run it".
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a scheduler, and adding one would be
 * a mistake. Something must be running for anything to fire, which is exactly
 * what the app is not allowed to require — the product works while the app is
 * closed, so a timer inside an Electron process cannot be where this lives.
 * Whatever is already running on the machine does the firing: Task Scheduler,
 * cron, an agent's own loop, or a person. What was missing was never the timer.
 * It was a cheap, honest answer to "is there anything to do", so that a thing
 * which wakes up every ten minutes can find out in a few file reads.
 *
 * THE SPLIT THAT MAKES IT CHEAP. A board says when it wants running in PROSE,
 * because "every morning" is what a person drawing a board would write and
 * inventing a cron syntax would put a manual in front of them. Reading prose
 * needs a model. Comparing two numbers does not. So an agent interprets the
 * words ONCE and writes a timestamp into `run.wakeAt`, and every check after
 * that is arithmetic. The expensive step happens on a schedule change; the cheap
 * one happens all day.
 *
 * WHO, NOT JUST WHAT. Every result says whether an agent can act on it or
 * whether it needs a person, because those go to different places. Waking an
 * agent for something only Nathan can answer burns a turn and changes nothing;
 * pinging Nathan for something an agent could just do is the notification noise
 * that gets a tool muted.
 *
 * Pure. No clock — `now` is passed in, so a test can sit at any instant.
 */
import type { Plan, Step } from './pipeline.js'
import type { Run } from './run.js'
import type { BoardStamp } from './brief.js'
import { ready, awaiting, isComplete, stateOf } from './run.js'
import { staleAgainst } from './brief.js'

/**
 * One reason a board wants attention.
 *
 * `by` is the routing decision and it is part of the finding rather than
 * something the caller works out afterwards, so that the two cannot drift.
 */
export type Attention =
  | { kind: 'work'; by: 'agent'; steps: Step[]; detail: string }
  | { kind: 'question'; by: 'human'; steps: Step[]; detail: string }
  | { kind: 'due'; by: 'agent'; at: number; detail: string }
  | { kind: 'stale'; by: 'agent'; detail: string }
  | { kind: 'held'; by: 'nobody'; until: number; detail: string }

/** Is somebody already working this board, as far as anyone can tell? */
export function heldBy(run: Run, now: number): string | null {
  const c = run.claim
  return c && c.until > now ? c.by : null
}

/**
 * Take a board, if it is free.
 *
 * Returns null rather than throwing when someone else holds it, because "I did
 * not get it" is an ordinary outcome in a race and not an error condition. The
 * caller checks for null and goes and does something else.
 *
 * `until` is an absolute time and the caller chooses it. Short leases mean a
 * dead agent frees the board quickly; long ones mean a slow agent does not lose
 * it mid-step. There is no correct value here that does not depend on the work,
 * so this does not invent one.
 */
export function claim(run: Run, by: string, until: number, now: number): Run | null {
  const holder = heldBy(run, now)
  // Re-claiming your own board is an extension, not a conflict: an agent part
  // way through long work renewing its lease is the normal case.
  if (holder !== null && holder !== by) return null
  return { ...run, claim: { by, until } }
}

/** Give the board back. Safe to call when you never held it. */
export function release(run: Run, by: string, now: number): Run {
  if (heldBy(run, now) !== by) return run
  const { claim: _dropped, ...rest } = run
  return rest as Run
}

/**
 * Record when this board should next be looked at.
 *
 * Separate from `record()` in run.ts because it is about the board rather than
 * about any step, and because it is the one write a scheduler makes without
 * doing any of the work.
 */
export function wakeAt(run: Run, at: number): Run {
  return { ...run, wakeAt: at }
}

/**
 * Everything this board wants, most actionable first.
 *
 * Order is the point: a caller that only looks at the first result should be
 * looking at the thing most likely to move the board along. Work an agent can do
 * outranks a question, because the question may well be answerable by finishing
 * the work first; both outrank a schedule, which is only a suggestion that
 * somebody look.
 *
 * An empty array means genuinely nothing to do, and callers may rely on that:
 * a completed board, a board held by someone else, and a board mid-flight with
 * every branch blocked all come back empty rather than with a placeholder.
 */
export function attention(
  plan: Plan,
  run: Run,
  boardStamp: BoardStamp,
  now: number,
  brief?: { board?: { stamp?: BoardStamp } } | null,
): Attention[] {
  const holder = heldBy(run, now)
  if (holder !== null) {
    return [
      {
        kind: 'held',
        by: 'nobody',
        until: run.claim!.until,
        detail: `${holder} is working this board until ${new Date(run.claim!.until).toISOString()}. Leave it alone; the claim expires on its own if they stop.`,
      },
    ]
  }

  // Staleness first and on its own. Every other answer below is computed FROM
  // the plan, so if the plan no longer describes the board on disk then those
  // answers are about a board that does not exist any more. Reporting them
  // alongside would invite acting on them.
  const stampToCheck = brief ?? { board: { stamp: run.boardStamp } }
  if (staleAgainst(stampToCheck as never, boardStamp)) {
    return [
      {
        kind: 'stale',
        by: 'agent',
        detail:
          'The board has changed since this plan was made, so the plan is describing something that is no longer there. Recompile it before doing anything else. The finished steps stay finished; their ids do not move unless a card was deleted.',
      },
    ]
  }

  if (isComplete(plan, run)) return []

  const out: Attention[] = []

  const work = ready(plan, run)
  if (work.length > 0) {
    out.push({
      kind: 'work',
      by: 'agent',
      steps: work,
      detail: `${work.length} step${work.length === 1 ? '' : 's'} can be done now. Claim the board first so nothing else picks up the same one.`,
    })
  }

  const asked = awaiting(plan, run)
  if (asked.length > 0) {
    out.push({
      kind: 'question',
      by: 'human',
      steps: asked,
      detail: `${asked.length} step${asked.length === 1 ? ' is' : 's are'} waiting on an answer from a person. An agent cannot clear this by working harder.`,
    })
  }

  // Last, and only when there is nothing else. A wake time is a request that
  // somebody look; if there is already work or a question then looking has
  // happened and saying so again is noise.
  if (out.length === 0 && typeof run.wakeAt === 'number' && run.wakeAt <= now) {
    out.push({
      kind: 'due',
      by: 'agent',
      at: run.wakeAt,
      detail:
        'This board asked to be looked at by now and has nothing obviously ready, which usually means the first step is a check rather than an action. Read it and decide.',
    })
  }

  return out
}

/**
 * Does anything here want a PERSON?
 *
 * Its own function because this is the one question worth pushing at somebody.
 * Everything else can wait for an agent to come round again.
 */
export function needsHuman(items: Attention[]): boolean {
  return items.some((i) => i.by === 'human')
}

/**
 * A single line a person can read on a phone.
 *
 * Deliberately not a template with slots: the whole value is that it says
 * something true and specific without the reader opening anything. A
 * notification that says "1 item needs attention" is a notification that trains
 * people to ignore notifications.
 */
export function summarise(boardName: string, plan: Plan, run: Run, items: Attention[]): string {
  const q = items.find((i) => i.kind === 'question')
  if (q && q.kind === 'question') {
    const first = q.steps[0]
    const asked = run.steps[first.id]?.question
    return `${boardName}: ${asked ?? first.text}`
  }
  const stale = items.find((i) => i.kind === 'stale')
  if (stale) return `${boardName}: the board changed, the plan needs rebuilding`
  const held = items.find((i) => i.kind === 'held')
  if (held && held.kind === 'held') return `${boardName}: already being worked on`
  const work = items.find((i) => i.kind === 'work')
  if (work && work.kind === 'work') {
    const total = plan.steps.length
    const left = plan.steps.filter((s) => stateOf(run, s.id) !== 'done').length
    return `${boardName}: ${total - left} of ${total} done, ${work.steps.length} ready`
  }
  if (items.length === 0) return `${boardName}: nothing to do`
  return `${boardName}: due for a look`
}
