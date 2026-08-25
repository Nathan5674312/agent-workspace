/**
 * A BOARD, COMPILED INTO SOMETHING AN AGENT CAN RUN.
 *
 * The claim this module rests on: a canvas board a human drew is ALREADY a
 * program, and nothing needs to be added to it to make one. An arrow between two
 * cards means "that one, then this one" to a person reading the board; it means
 * exactly the same thing here. A group is a phase because a labelled box around
 * four cards is already a phase. A file card is material because pointing at a
 * note is already how you say "use this".
 *
 * That is the whole design, and two hard requirements fall out of it for free.
 *
 * INVISIBILITY. There is no syntax to learn, no `@directive`, no metadata card,
 * no toggle marking a board "agentic". A person mind-mapping a holiday and a
 * person authoring a pipeline draw the same file, and neither ever sees a trace
 * of the other's use of it. Nothing here renders. Nothing here is authored.
 *
 * THE `.canvas` FILE IS NEVER WRITTEN BY THIS MODULE. Not one key, not one byte.
 * `docs/canvas-backlog.md` records that whether Obsidian preserves unknown keys
 * is UNMEASURED, and that hijacking a spec field for app data is on the
 * never-build list because the user would see our internals printed on their
 * board. Both risks vanish by construction if the compiled form lives in a
 * separate file. So it does. Everything below is DERIVED: throw it away and the
 * next compile rebuilds it from the board, which is the only source of truth
 * there has ever been.
 *
 * WHY `shared/` AND WHY PURE. Three callers need identical answers: the app when
 * it is open, a CLI agent when it is closed, and the test. If the topological
 * order differed between them, two agents would disagree about which step is
 * next while both were "right". No DOM, no React, no filesystem, so
 * `node --test` runs this file directly.
 */
import type { CanvasDoc, CanvasNode, CanvasEdge } from './canvas.js'
import { isCanvasPath } from './canvas.js'

/** The compiled form's schema version. Written into every plan. */
export const PLAN_VERSION = 1

/**
 * One unit of work.
 *
 * `text` and `file` are read straight off the node, unchanged. The instruction
 * IS the card's text: whatever the human wrote, verbatim, with no parsing
 * applied to it. Parsing would be a syntax, and a syntax is a thing the user has
 * to see.
 */
export type Step = {
  id: string
  /** Sequence position, 0-based. Stable for a given board. */
  index: number
  /** The card's own text, verbatim. For a `text` card this is the instruction. */
  text: string
  /** A `file` card's vault-relative path: the material, skill or note to use. */
  file?: string
  /** A `link` card's URL. */
  url?: string
  /** The label of the innermost group containing this card, if any. The phase. */
  phase?: string
  /** Ids that must be done first. Derived from incoming edges. */
  after: string[]
  /** Ids waiting on this one. Derived from outgoing edges. */
  before: string[]
  /**
   * Edge labels on the way IN, keyed by the id they came from. An edge label is
   * a condition in every flowchart ever drawn ("if yes", "on failure"), so it is
   * carried through rather than interpreted.
   */
  conditions: Record<string, string>
}

/**
 * Something about the board that stops it being a pipeline, said plainly.
 *
 * Not thrown. A board with a cycle is a perfectly good mind-map and the person
 * who drew it did nothing wrong; it just has no first step. Refusing to compile
 * would make the honest answer ("this is not a sequence") indistinguishable from
 * a crash, and an agent needs to be able to tell those apart.
 */
export type PlanProblem =
  | { kind: 'cycle'; nodes: string[]; detail: string }
  | { kind: 'dangling-edge'; edge: string; missing: string; detail: string }
  | { kind: 'no-entry'; detail: string }

export type Plan = {
  version: number
  /** Steps in the order a human would read them off the arrows. */
  steps: Step[]
  /** Steps with nothing pointing at them: where a run begins. */
  entry: string[]
  /** Group labels, in the order their boxes appear in the file. */
  phases: string[]
  /**
   * Cards on the board that are not in `steps`, and why. Today that is only
   * group boxes, which are containers rather than work.
   */
  excluded: { id: string; reason: string }[]
  problems: PlanProblem[]
  /** True when `steps` is a real sequence: at least one step, and no cycle. */
  runnable: boolean
}

/** Group boxes are the phase, not a step in it. */
const isContainer = (n: CanvasNode): boolean => n.type === 'group'

/**
 * Does `inner` sit inside `outer`?
 *
 * JSON Canvas groups have NO children array. A group is a rectangle and
 * membership is entirely spatial. This is the one place the format forces
 * geometry into what is otherwise a graph problem, and getting it wrong would
 * silently mis-assign every phase on a dense board.
 *
 * The test is the card's CENTRE, not its bounding box. A card overlapping a
 * group's edge belongs to whichever group it is mostly in, which is what it
 * looks like it belongs to. Requiring full containment would drop cards that
 * visibly sit in a group; testing any-overlap would claim two at once.
 */
function centreInside(inner: CanvasNode, outer: CanvasNode): boolean {
  const cx = inner.x + inner.width / 2
  const cy = inner.y + inner.height / 2
  return (
    cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height
  )
}

/**
 * The label of the SMALLEST group containing this card.
 *
 * Smallest, because groups nest: a card inside "Draft" inside "Content" is in
 * the draft phase. Area is the tiebreak, compared as a number rather than by
 * containment testing between the groups themselves, which would be quadratic
 * for no extra accuracy.
 */
function phaseOf(node: CanvasNode, groups: CanvasNode[]): string | undefined {
  let best: CanvasNode | undefined
  for (const g of groups) {
    if (g.id === node.id) continue
    if (!centreInside(node, g)) continue
    if (!best || g.width * g.height < best.width * best.height) best = g
  }
  const label = best?.label
  return typeof label === 'string' && label !== '' ? label : undefined
}

/**
 * Order the steps.
 *
 * Kahn's algorithm with ONE deliberate deviation: the ready set is kept in the
 * nodes' own array order rather than in the order they became ready. Array order
 * is the spec's z-order, it is what the file already says, and it is identical
 * for every reader of that file. Without that tiebreak two agents compiling the
 * same board would produce two different "next steps" and both would be
 * defensible, which is the worst failure available to a thing whose entire job
 * is telling several agents what to do next.
 *
 * Returns the ordered ids plus whatever could not be ordered, which is exactly
 * the set of nodes involved in a cycle.
 */
function topological(
  ids: string[],
  after: Map<string, Set<string>>,
): { order: string[]; stuck: string[] } {
  const rank = new Map(ids.map((id, i) => [id, i]))
  const remaining = new Set(ids)
  const done = new Set<string>()
  const order: string[] = []

  for (;;) {
    const ready = [...remaining]
      .filter((id) =>
        [...(after.get(id) ?? [])].every((dep) => done.has(dep) || !remaining.has(dep)),
      )
      .sort((a, b) => rank.get(a)! - rank.get(b)!)
    if (ready.length === 0) break
    for (const id of ready) {
      order.push(id)
      done.add(id)
      remaining.delete(id)
    }
  }
  return { order, stuck: [...remaining].sort((a, b) => rank.get(a)! - rank.get(b)!) }
}

/**
 * Compile a board.
 *
 * Never throws on a board `parseCanvas` accepted. Everything that would be an
 * error somewhere else (a cycle, an edge to a card that was deleted, a board
 * with no beginning) comes back in `problems` with the ids involved, because the
 * caller is usually an agent that has to say something useful about it rather
 * than a human who can look at the screen.
 */
export function compile(doc: CanvasDoc): Plan {
  const nodes = (doc.nodes ?? []) as CanvasNode[]
  const groups = nodes.filter(isContainer)
  const work = nodes.filter((n) => !isContainer(n))
  const known = new Set(work.map((n) => n.id))
  const groupIds = new Set(groups.map((g) => g.id))

  const problems: PlanProblem[] = []
  const after = new Map<string, Set<string>>(work.map((n) => [n.id, new Set<string>()]))
  const before = new Map<string, Set<string>>(work.map((n) => [n.id, new Set<string>()]))
  const conditions = new Map<string, Record<string, string>>()

  for (const e of (doc.edges ?? []) as CanvasEdge[]) {
    // An edge touching a group is the human drawing a relationship between
    // phases. It is real, it is preserved in the file, and it is not a
    // dependency between two units of work, so it is skipped rather than
    // reported: nothing is wrong with the board.
    if (groupIds.has(e.fromNode) || groupIds.has(e.toNode)) continue

    for (const [end, id] of [
      ['fromNode', e.fromNode],
      ['toNode', e.toNode],
    ] as const) {
      if (!known.has(id)) {
        problems.push({
          kind: 'dangling-edge',
          edge: e.id,
          missing: id,
          detail: `Edge ${e.id} points at ${id} via ${end}, which is not on this board. The card was probably deleted without its edges.`,
        })
      }
    }
    if (!known.has(e.fromNode) || !known.has(e.toNode)) continue

    after.get(e.toNode)!.add(e.fromNode)
    before.get(e.fromNode)!.add(e.toNode)
    if (typeof e.label === 'string' && e.label !== '') {
      const bag = conditions.get(e.toNode) ?? {}
      bag[e.fromNode] = e.label
      conditions.set(e.toNode, bag)
    }
  }

  const { order, stuck } = topological(
    work.map((n) => n.id),
    after,
  )
  if (stuck.length > 0) {
    problems.push({
      kind: 'cycle',
      nodes: stuck,
      detail:
        'These cards point at each other in a loop, so there is no order that puts every one of them after the cards it depends on. A board can legitimately look like this (it is a map rather than a sequence) but it cannot be run as one.',
    })
  }

  const byId = new Map(work.map((n) => [n.id, n]))
  const steps: Step[] = order.map((id, index) => {
    const n = byId.get(id)!
    const step: Step = {
      id,
      index,
      text: typeof n.text === 'string' ? n.text : '',
      after: [...after.get(id)!],
      before: [...before.get(id)!],
      conditions: conditions.get(id) ?? {},
    }
    if (typeof n.file === 'string') step.file = n.file
    if (typeof n.url === 'string') step.url = n.url
    const phase = phaseOf(n, groups)
    if (phase) step.phase = phase
    return step
  })

  const entry = steps.filter((s) => s.after.length === 0).map((s) => s.id)
  if (steps.length > 0 && entry.length === 0) {
    problems.push({
      kind: 'no-entry',
      detail:
        'Every card on this board has something pointing at it, so there is nowhere to begin.',
    })
  }

  return {
    version: PLAN_VERSION,
    steps,
    entry,
    phases: groups
      .map((g) => (typeof g.label === 'string' ? g.label : ''))
      .filter((l) => l !== ''),
    excluded: groups.map((g) => ({
      id: g.id,
      reason: 'group box: the phase its cards are in, not work of its own',
    })),
    problems,
    runnable: steps.length > 0 && stuck.length === 0 && entry.length > 0,
  }
}

/**
 * THE PIPELINES AN INDEX BOARD POINTS AT.
 *
 * How an agent gets from "there is a vault" to "here are the runnable boards"
 * without anybody telling it. It opens the root board, compiles it, and calls
 * this. That is the whole mechanism.
 *
 * THE INDEX IS A BOARD, NOT A MANIFEST, and everything good about this follows
 * from that one refusal. A `pipelines.json` beside the boards would be a second
 * thing to keep in sync, and the first time someone renamed a board in Obsidian
 * it would be wrong with no way to notice. A board pointing at boards cannot go
 * out of date, because it IS the thing being described — the same claim
 * `compile` rests on, applied one level up. The sidebar already nests boards
 * this way (`boardTree`), so this is the agent-side reading of a hierarchy the
 * user can already see and already edits by dragging.
 *
 * Nothing new is authored to be listed here. A `file` card pointing at a
 * `.canvas` is what a person draws when they mean "and then that pipeline", and
 * it renders as an ordinary card in both this app and Obsidian.
 *
 * `Step`s rather than paths, in board order, because the arrows around those
 * cards mean what they always mean: `after`, `before` and `conditions` say
 * which pipeline runs when, and an index board is allowed to be a sequence
 * rather than a bare list. A caller that only wants the paths takes `.file`.
 *
 * NOT RECURSIVE, deliberately. A pipeline that indexes further pipelines is one
 * more compile by a caller that wants it, and doing it here would need this
 * module to read files — which would cost it the purity that lets a CLI agent,
 * the app and the test all get the same answer. `boardTree` is where the
 * recursive form already lives, with the cycle guard it needs.
 */
export function pipelines(plan: Plan): Step[] {
  return plan.steps.filter((s) => s.file !== undefined && isCanvasPath(s.file))
}
