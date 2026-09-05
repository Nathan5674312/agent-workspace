/**
 * The states a roadmap row can be in, and the words a person calls them.
 *
 * TWO SEPARATE THINGS, deliberately. The ID is what the app sorts, filters and
 * counts by; the LABEL is what a reader sees. Nathan asked for exactly this
 * split — "that can be in different states depending on how the user's self or
 * if an organisation would prefer" — and it only works if the vocabulary is a
 * setting while the ordering is not. An organisation renaming "Idea" to
 * "Backlog" must not change where Backlog sorts.
 *
 * FOUR, not three. `src/shared/roadmap.ts` grades the APP's own code with
 * built/partial/planned, which is a different question: is this code finished.
 * A person's roadmap needs a slot for something that is finished but not yet
 * signed off, and a slot for something nobody has committed to. Hence `idea`
 * ahead of `partial`, and `done` after `complete`.
 *
 * ORDER IS PROGRESS ORDER, not alphabetical and not importance. Sorting by
 * state should read as a pipeline — what has not started, what is moving, what
 * is finished, what is closed — because that is the question a roadmap is
 * opened to answer.
 */

export type RoadmapState = 'idea' | 'partial' | 'complete' | 'done'

/** Progress order. Index in this array IS the sort key. */
export const STATE_ORDER: RoadmapState[] = ['idea', 'partial', 'complete', 'done']

/** Nathan's words, and the fallback when no vocabulary is configured. */
export const DEFAULT_STATE_LABELS: Record<RoadmapState, string> = {
  idea: 'Idea',
  partial: 'Partial',
  complete: 'Complete',
  done: 'Done',
}

/**
 * Every spelling seen in this vault, mapped to a state.
 *
 * NOT a guess at what people might write. These are the `status:` values that
 * actually occur in the notes this pane reads, plus the three the app's own
 * roadmap uses so the two vocabularies meet. Anything unrecognised is `null`
 * and the row keeps its raw word — see `stateOf`.
 *
 * The alternative was to invent a state for every unknown status, which turns
 * one typo into a permanent extra column in the group list.
 */
const SYNONYMS: Record<string, RoadmapState> = {
  // idea — nobody has committed to it yet
  idea: 'idea',
  ideas: 'idea',
  planned: 'idea',
  backlog: 'idea',
  someday: 'idea',
  proposed: 'idea',
  draft: 'idea',
  brief: 'idea',
  plan: 'idea',
  'north-star': 'idea',
  // partial — moving, not finished
  partial: 'partial',
  wip: 'partial',
  doing: 'partial',
  active: 'partial',
  'in progress': 'partial',
  'in-progress': 'partial',
  started: 'partial',
  scoped: 'partial',
  spec: 'partial',
  building: 'partial',
  researched: 'partial',
  // complete — the work is finished
  complete: 'complete',
  completed: 'complete',
  built: 'complete',
  shipped: 'complete',
  tested: 'complete',
  decided: 'complete',
  // done — finished AND closed out
  done: 'done',
  closed: 'done',
  archived: 'done',
  abandoned: 'done',
}

/**
 * The state a raw `status:` frontmatter value means, or null if it says
 * nothing this pane understands.
 *
 * Null is a real answer, not a failure. A note with `status: blocked` is still
 * a roadmap row and still worth showing; what it is not is one of the four
 * things this pane can sort into a pipeline. Coercing it to `idea` would be a
 * lie that sorts.
 */
export function stateOf(status: string): RoadmapState | null {
  return SYNONYMS[headOf(status).toLowerCase()] ?? null
}

/**
 * The state word at the front of a status, without whatever explains it.
 *
 * Real statuses in a real vault are not single words. This one is verbatim:
 * `IN PROGRESS — electron-builder landed \`0871a02\`, zip artifact builds`.
 * The state is the first clause and the rest is the reason, so matching the
 * whole string finds nothing and the note falls out of the pipeline for having
 * been documented too well.
 *
 * CASE IS PRESERVED, because this is what the roadmap pane puts on the pill and
 * the whole point is that the words are the author's. `stateOf` lowercases for
 * its own lookup; a reader gets `RESEARCHED` if that is what the note says.
 *
 * Cuts at an em or en dash, a spaced hyphen, a colon, or a `#`. The last one
 * is a YAML comment — `status: idea   # idea | active | paused` is a real line
 * in this vault's own template — and without it the pill renders the template's
 * instructions and the row matches no state at all.
 *
 * NOT at a bare hyphen: `north-star` and `in-progress` are single words that
 * contain one.
 */
export function headOf(status: string): string {
  return status.split(/[—–]| - |:|#/)[0].trim()
}

/**
 * Sort key for a state. Unknown states sort AFTER every known one, so a typo
 * lands at the bottom of the list where it is visible, rather than silently
 * at the top where it looks deliberate.
 */
export function stateRank(state: RoadmapState | null): number {
  return state === null ? STATE_ORDER.length : STATE_ORDER.indexOf(state)
}

/*
 * THERE IS NO `labelOf`, AND THAT IS THE ANSWER RATHER THAN A GAP.
 *
 * It existed to map a state onto a configurable word, for an organisation that
 * calls `idea` "Backlog". The pane does something better and simpler: it shows
 * the word the NOTE uses and spends the state only on sorting, counting and
 * colour. So the vocabulary is already whatever a person or an organisation
 * writes, with nothing to configure and nothing to keep in step.
 *
 * DEFAULT_STATE_LABELS above is still used, in the one place that is counting
 * across every vocabulary at once — the pipeline summary at the top of the
 * pane, where "48 partial" has to mean the same thing for every row it covers.
 */
