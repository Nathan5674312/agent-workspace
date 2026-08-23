/**
 * WHERE A PIPELINE HAS GOT TO.
 *
 * `pipeline.ts` compiles a board into an order. `brief.ts` writes that order
 * down for a reader with no eyes on the screen. Neither of them remembers
 * anything, and that is the gap this file closes: a plan says what the steps
 * are, a RUN says which of them have happened.
 *
 * This is the piece ComfyUI calls the queue, and it is the difference between a
 * diagram and a program. Without it an agent can read a board and act on it once
 * in a single sitting; with it an agent can do step one on Tuesday, ask a human
 * a question, go away, come back on Wednesday and know exactly where it stopped.
 * The long-running case is the whole point — the person who drew the board is at
 * work, or asleep, or at school, and the run has to survive their absence.
 *
 * THREE DECISIONS WORTH THE ARGUMENT.
 *
 * 1. A STEP WAITING ON A HUMAN BLOCKS ITS DEPENDENTS, NOT THE RUN. Independent
 *    branches keep going while one of them waits. A pipeline that stops dead
 *    because one card needs an answer wastes the entire time the human is away,
 *    which on this project is measured in school days.
 *
 * 2. A STEP IS READY WHEN EVERY DEPENDENCY IS RESOLVED AND AT LEAST ONE IS DONE.
 *    Flowcharts branch, and the spec's edge labels are how they say so:
 *    `a --"if yes"--> b` beside `a --"if no"--> c` means one of b or c happens.
 *    Requiring every dependency DONE would deadlock the join after a branch;
 *    requiring only one would fire a join before its other input arrived. The
 *    rule above does both: the taken path proceeds, the untaken one is skipped,
 *    and a step whose every dependency was skipped is skipped in turn rather
 *    than hanging forever.
 *
 * 3. UPDATES RETURN A NEW RUN. A half-applied state change here is an agent
 *    that believes a step both did and did not happen, and the failure surfaces
 *    hours later in a branch nobody was watching. Copying an object this small
 *    costs nothing worth measuring.
 *
 * Pure, and in `shared/` for the reason the rest of this layer is: the app when
 * it is open, a CLI agent when it is closed, and `node --test` must all compute
 * the same answer to "what happens next".
 */
import type { Plan, Step } from './pipeline.js'
import type { BoardStamp } from './brief.js'

export const RUN_VERSION = 1

/**
 * What has happened to one step.
 *
 * `blocked` is deliberately absent. A step that cannot proceed is either waiting
 * on a dependency — which is `pending`, and derivable from the plan rather than
 * stored — or waiting on a person, which is `awaiting-human`. Storing a third,
 * computed state would let it disagree with the plan it was computed from.
 */
export type StepState = 'pending' | 'running' | 'awaiting-human' | 'done' | 'skipped' | 'failed'

export type StepRecord = {
  state: StepState
  /** What the step produced, in whatever words the agent chose. */
  output?: string
  /** `awaiting-human`: what to ask. The agent writes it; a person answers it. */
  question?: string
  /** The person's reply, once there is one. */
  answer?: string
  /** `failed`: what went wrong, for a human to read. */
  error?: string
  /** When this record last changed. */
  at?: number
}

export type Run = {
  readThisFirst: string
  version: number
  /** The board this run belongs to, and what it looked like when the run began. */
  board: string
  boardStamp: BoardStamp
  startedAt: number
  /** Keyed by step id. A step with no entry has not started. */
  steps: Record<string, StepRecord>
  /**
   * When this board next wants looking at, as a timestamp.
   *
   * The board says WHEN in prose — "every morning", "after each post" — because
   * a schedule is a thing the person drawing it should be able to write in
   * words. Reading that prose needs a model; comparing two numbers does not. So
   * an agent interprets it ONCE and leaves a timestamp here, and after that any
   * dumb scheduler can answer "is this due" without loading anything.
   *
   * Absent means nobody has said, which is not the same as "never" and is why
   * this is optional rather than defaulted to zero.
   */
  wakeAt?: number
  /**
   * Who is working this board, and until when.
   *
   * Two agents on one pipeline is the same failure as two agents in one file,
   * and it is not hypothetical on this machine — there are two Claude sessions
   * and they have collided before. An EXPIRY rather than a flag, because the
   * common ending for an agent is not "releases the claim", it is "stops
   * existing", and a lock nothing can clear is worse than no lock.
   */
  claim?: { by: string; until: number }
}

/**
 * Start a run.
 *
 * The board's stamp is captured now so that a run can later be checked against
 * the board it was actually planned from. A person redrawing the board mid-run
 * is not an error, but continuing as though nothing changed would be.
 */
export function beginRun(board: string, boardStamp: BoardStamp, startedAt: number): Run {
  return {
    readThisFirst:
      'This file records how far through a board someone has got. Each key under ' +
      '"steps" is a step id from the plan beside it. A step with no entry here ' +
      'has not been started. Read it together with the plan; on its own it is ' +
      'only half the picture. It is safe to delete if you want to start over.',
    version: RUN_VERSION,
    board,
    boardStamp,
    startedAt,
    steps: {},
  }
}

/** The state of one step, defaulting to `pending` for anything not yet recorded. */
export function stateOf(run: Run, id: string): StepState {
  return run.steps[id]?.state ?? 'pending'
}

/** Has this step reached a state nothing will move it out of? */
const settled = (s: StepState): boolean => s === 'done' || s === 'skipped' || s === 'failed'

/**
 * Record something about a step, returning a new run.
 *
 * Merges rather than replaces, so recording an answer does not wipe the question
 * it answers, and an agent that writes `{ state: 'done' }` after writing an
 * output keeps the output.
 */
export function record(run: Run, id: string, patch: Partial<StepRecord>, at: number): Run {
  const prev = run.steps[id] ?? { state: 'pending' as StepState }
  return { ...run, steps: { ...run.steps, [id]: { ...prev, ...patch, at } } }
}

/**
 * The steps that could be worked on right now.
 *
 * Rule 2 from the header, applied: every dependency settled, and at least one of
 * them actually done. A step with no dependencies at all is ready from the
 * start, which is what makes `plan.entry` the place a run begins.
 *
 * Returned in plan order, so an agent taking the first of them is taking the one
 * the person drawing the board would have pointed at.
 */
export function ready(plan: Plan, run: Run): Step[] {
  return plan.steps.filter((s) => {
    if (stateOf(run, s.id) !== 'pending') return false
    if (s.after.length === 0) return true
    if (!s.after.every((d) => settled(stateOf(run, d)))) return false
    return s.after.some((d) => stateOf(run, d) === 'done')
  })
}

/**
 * Steps that will never run, because every path into them was skipped or failed.
 *
 * Kept separate from `ready` rather than folded into it, because marking these
 * is a WRITE and an agent asking "what can I do" should not silently mutate the
 * run. The caller decides when to settle them; `settleUnreachable` does it.
 */
export function unreachable(plan: Plan, run: Run): Step[] {
  return plan.steps.filter((s) => {
    if (stateOf(run, s.id) !== 'pending') return false
    if (s.after.length === 0) return false
    if (!s.after.every((d) => settled(stateOf(run, d)))) return false
    return !s.after.some((d) => stateOf(run, d) === 'done')
  })
}

/**
 * Mark every currently-unreachable step as skipped, repeatedly, until no more
 * appear.
 *
 * Skipping propagates: skip one step and everything downstream of only that step
 * becomes unreachable too. Looping until it settles is what stops a run sitting
 * at 90% forever with a tail of steps that can never happen. The loop is bounded
 * by the step count because each pass settles at least one step or stops.
 */
export function settleUnreachable(plan: Plan, run: Run, at: number): Run {
  let out = run
  for (let i = 0; i <= plan.steps.length; i++) {
    const next = unreachable(plan, out)
    if (next.length === 0) return out
    for (const s of next) out = record(out, s.id, { state: 'skipped' }, at)
  }
  return out
}

/** The steps waiting on a person, in plan order. */
export function awaiting(plan: Plan, run: Run): Step[] {
  return plan.steps.filter((s) => stateOf(run, s.id) === 'awaiting-human')
}

/**
 * Answer a question a step was waiting on.
 *
 * Returns the run unchanged if that step was not actually waiting, because an
 * answer to a question nobody asked is far more likely to be a mix-up of step
 * ids than a thing the caller meant, and applying it would overwrite real state.
 */
export function answer(run: Run, id: string, text: string, at: number): Run {
  if (stateOf(run, id) !== 'awaiting-human') return run
  return record(run, id, { state: 'pending', answer: text }, at)
}

/**
 * A run is finished when nothing is left that could still move.
 *
 * Note what this does NOT claim: that everything succeeded. A run whose steps
 * all failed is finished. `progress()` is where success is counted, and the two
 * are kept apart so that "are we done" cannot quietly come to mean "did it work".
 */
export function isComplete(plan: Plan, run: Run): boolean {
  return plan.steps.every((s) => settled(stateOf(run, s.id)))
}

/** A tally for a human, or for an agent deciding whether to report in. */
export function progress(
  plan: Plan,
  run: Run,
): { total: number; done: number; skipped: number; failed: number; waiting: number; left: number } {
  const count = (f: (s: StepState) => boolean): number =>
    plan.steps.filter((s) => f(stateOf(run, s.id))).length
  return {
    total: plan.steps.length,
    done: count((s) => s === 'done'),
    skipped: count((s) => s === 'skipped'),
    failed: count((s) => s === 'failed'),
    waiting: count((s) => s === 'awaiting-human'),
    left: count((s) => !settled(s)),
  }
}

/**
 * Where a run's state file goes: beside the board, hidden, next to its brief.
 *
 * Same reasoning as `briefPath`. Hidden because a person using this as an
 * ordinary notes app must never meet the agent layer, and beside the board
 * because a state file that outlives the board it describes should be obviously
 * orphaned rather than quietly authoritative.
 */
export function runPath(boardPath: string): string {
  const cut = boardPath.lastIndexOf('/')
  const dir = cut === -1 ? '' : boardPath.slice(0, cut + 1)
  const file = cut === -1 ? boardPath : boardPath.slice(cut + 1)
  return `${dir}.${file}.run.json`
}

/** Two spaces and a trailing newline, like every other file this app writes. */
export function serializeRun(r: Run): string {
  return `${JSON.stringify(r, null, 2)}\n`
}
