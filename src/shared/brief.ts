/**
 * THE PLAN, WRITTEN DOWN SO THAT A MODEL WHICH HAS NEVER SEEN THIS APP CAN RUN
 * IT WITH NOTHING BUT A FILESYSTEM.
 *
 * The requirement this file exists to satisfy is "every agent, every model, past
 * and future". That requirement has one honest answer and it is not an
 * abstraction layer over vendors, because every integration protocol so far has
 * had a shelf life measured in months: plugins died, function-call schemas were
 * rewritten more than once, MCP is barely two years old and belongs to one
 * vendor. Anything built on top of one of those inherits its expiry date.
 *
 * The interface that has worked for every model that could ever use a tool, and
 * will keep working for every model after, is READING A FILE. That is the floor.
 * Richer transports are welcome on top of it, but only ever as a convenience: if
 * MCP vanished tomorrow nothing in this design would break, and when the next
 * protocol arrives it is a thin adapter over this same file rather than a second
 * source of truth that can drift out of agreement with the first.
 *
 * So the rule, and it is testable: ANYTHING AN AGENT NEEDS MUST BE OBTAINABLE
 * WITH `ls` AND `cat`, WITH NO PROCESS RUNNING. `docs/` and an SDK are not an
 * integration; they are a dependency on someone being around to read them.
 *
 * SELF-DESCRIBING, WHICH IS THE PART PEOPLE SKIP. A schema that lives somewhere
 * else is a schema a model has to already know about, and "already knows about
 * it" is precisely what cannot be assumed of a model that has not been trained
 * yet. So the explanation ships INSIDE the payload, in plain language, in the
 * first keys of the object. A reader that has never heard of this app opens the
 * file and the first thing in it says what it is and what to do with it. That
 * costs a few hundred bytes once per board and removes every version-negotiation
 * problem this format could otherwise have.
 *
 * DERIVED, NEVER AUTHORED. The board is the truth. This file is a reading of it,
 * and it is always safe to delete: the next compile rebuilds it. That is what
 * makes it safe to write at all, and it is why `staleAgainst()` exists — a
 * derived file that cannot tell you it has gone out of date is worse than no
 * file, because it is confidently wrong.
 *
 * Pure. No filesystem here: this module decides WHAT to write and WHERE, and the
 * caller does the writing, so the same function serves the app, a CLI agent, and
 * `node --test` without any of them needing the others.
 */
import type { Plan } from './pipeline.js'

/** Bumped only when a reader that understood the old shape would misread the new one. */
export const BRIEF_VERSION = 1

/**
 * What the board looked like when this was compiled.
 *
 * Size and mtime rather than a content hash: both come free from the `stat` the
 * caller has already done, hashing would mean reading the whole board a second
 * time, and the question being asked is only "did this change", which a stat
 * answers. A board edited and reverted to the same bytes within one filesystem
 * timestamp tick would evade this, and that is the same ceiling `save()`'s
 * lost-update guard already lives with.
 */
export type BoardStamp = { mtime: number; size: number }

export type Brief = {
  readThisFirst: string
  howToUseThis: string[]
  doNot: string[]
  format: { version: number; derived: true; safeToDelete: true }
  board: { file: string; name: string; stamp: BoardStamp }
  compiledAt: number
  runnable: boolean
  /** Present only when `runnable` is false, so a reader is never left guessing. */
  whyNotRunnable?: string[]
  plan: Plan
}

/**
 * Where the brief for a board goes.
 *
 * Beside the board, dot-prefixed. Two reasons, and the second is the one that
 * settled it.
 *
 * HIDDEN, because the requirement is that a person using this as an ordinary
 * notes app never sees a trace of the agent-facing layer. Obsidian hides
 * dotfiles, every file manager has to be asked to show them, and `.obsidian/`
 * has already trained users that a dot-thing beside their notes is not theirs to
 * think about. A file called `My Board.agent.json` sitting in the folder would
 * fail that requirement on its own.
 *
 * BESIDE rather than in one central directory, because this file goes stale when
 * the board changes and the worst version of stale is far away. Move or rename a
 * board with the brief next to it and the orphan is obvious at a glance; do the
 * same with a central registry and it silently describes a board that no longer
 * exists at that path. Enumerating every brief in a vault is still one glob.
 */
export function briefPath(boardPath: string): string {
  const cut = boardPath.lastIndexOf('/')
  const dir = cut === -1 ? '' : boardPath.slice(0, cut + 1)
  const file = cut === -1 ? boardPath : boardPath.slice(cut + 1)
  return `${dir}.${file}.brief.json`
}

/** The board's display name: filename, `.canvas` dropped. */
function boardName(boardPath: string): string {
  return boardPath.split('/').pop()!.replace(/\.canvas$/i, '')
}

/**
 * Has the board changed since this brief was written?
 *
 * The single most important function in the file. A derived artifact that cannot
 * detect its own staleness will be trusted long after it stopped being true, and
 * an agent acting on a plan for a board the human has since redrawn is the exact
 * failure this whole design is supposed to make impossible.
 *
 * Returns true when unsure. An unreadable or absent stamp means the answer is
 * not known, and "recompile unnecessarily" costs milliseconds while "run a stale
 * plan" costs whatever the plan does.
 */
export function staleAgainst(brief: Brief | null | undefined, now: BoardStamp): boolean {
  const was = brief?.board?.stamp
  if (!was || !Number.isFinite(was.mtime) || !Number.isFinite(was.size)) return true
  return was.mtime !== now.mtime || was.size !== now.size
}

/**
 * The prose that ships inside every brief.
 *
 * Written for a reader with no context at all, because that is the reader this
 * format is for. Short sentences, no jargon, no reference to anything it would
 * have to go and find. It says what the file is, what to do, and — the part that
 * matters most — what NOT to touch, since the one irreversible mistake available
 * here is editing the user's board.
 */
function guidance(name: string, board: string): Pick<Brief, 'readThisFirst' | 'howToUseThis' | 'doNot'> {
  return {
    readThisFirst:
      `This file is a plain-language reading of a visual board called "${name}", ` +
      `stored at "${board}". A person arranged some cards and drew arrows between ` +
      `them. The arrows are the order, a labelled box around several cards is a ` +
      `phase, and a card that names a file is material to use. This file is that ` +
      `board written out as a list, so that you can act on it without being able ` +
      `to see it. Nothing here was authored by hand: it was derived from the board ` +
      `and can be rebuilt from it at any time.`,
    howToUseThis: [
      'Read "plan.steps". They are already in order, and "index" is the position.',
      'A step\'s "text" is the instruction, exactly as the person wrote it. It has not been parsed or interpreted, so read it as you would read a sentence from a colleague.',
      'A step\'s "file" points at material in the same vault, relative to the vault root: a skill, a note, a template. Read it before acting on the step.',
      '"after" lists steps that must be finished first. "before" lists steps waiting on this one. Steps in "plan.entry" have nothing before them and are where a run starts.',
      '"conditions" maps an earlier step id to the label written on the arrow between them, such as "if yes". Treat it as the person\'s own words about when this step applies.',
      '"phase" is the label of the box the card sits inside, if any. It groups steps; it is not itself a step.',
      'Before acting, confirm the board has not changed since this was written by comparing "board.stamp" against the file on disk. If it differs, recompile rather than trusting this file.',
    ],
    doNot: [
      `Do not edit "${board}". It is the person's own board, it is shared with other applications, and editing it is the one mistake here that cannot be undone from this file.`,
      'Do not treat this file as the source of truth. The board is. This is a reading of it and may be out of date.',
      'Do not write your results into this file. It is overwritten by the next compile.',
    ],
  }
}

/**
 * Build the brief for a compiled board.
 *
 * `compiledAt` is passed in rather than read from the clock so the function stays
 * pure and a test can assert on the whole object.
 */
export function brief(
  plan: Plan,
  boardPath: string,
  stamp: BoardStamp,
  compiledAt: number,
): Brief {
  const name = boardName(boardPath)
  const out: Brief = {
    ...guidance(name, boardPath),
    format: { version: BRIEF_VERSION, derived: true, safeToDelete: true },
    board: { file: boardPath, name, stamp },
    compiledAt,
    runnable: plan.runnable,
    plan,
  }
  // Only when it is false, and phrased as the reason rather than as an error
  // code: a board that is a map instead of a sequence is not a malfunction, and
  // the reader needs to be able to say something true about it to the person.
  if (!plan.runnable) {
    out.whyNotRunnable =
      plan.problems.length > 0
        ? plan.problems.map((p) => p.detail)
        : ['This board has no cards on it yet.']
  }
  return out
}

/**
 * Serialize a brief.
 *
 * Two spaces and a trailing newline, matching `serializeCanvas` and every other
 * file this app writes into a vault, so a human who does look at it sees
 * something readable and a diff stays legible.
 *
 * KEY ORDER IS LOAD-BEARING and is why this is a function rather than a bare
 * `JSON.stringify` at the call site. `brief()` builds the object with the
 * guidance first, and JSON.stringify emits keys in insertion order, so a reader
 * that only gets the first few hundred bytes — a truncated paste, a head -c, a
 * model with a small window — has already been told what it is holding.
 */
export function serializeBrief(b: Brief): string {
  return `${JSON.stringify(b, null, 2)}\n`
}
