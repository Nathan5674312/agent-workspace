/**
 * What the user actually said, kept verbatim, and handed back automatically.
 *
 * WHY THIS EXISTS. The 2026-09-16 benchmark runs measured the vault directly:
 * two arbitrary domain rules were stated in a prompt, the code holding them was
 * deleted, and the agent was asked to rebuild it. With a note, it one-shot the
 * task. Without one, it guessed and lost a round. Across four runs the agent
 * wrote a note when it felt like it — one of two on Opus, none of two on
 * Sonnet — so the same instruction file produced a win or a tie depending on
 * the session's mood. A capability that fires half the time cannot be promised
 * to anyone.
 *
 * Worse, in the run where it did write, it saved its own GUESS as fact: a note
 * asserting the wrong week start, which the next session would have inherited
 * as settled. A vault that records inferences is worse than an empty one,
 * because a confident wrong note is read and believed.
 *
 * So this module does not infer anything. It records the user's own words,
 * exactly as typed, and replays them into later sessions. Both halves are
 * mechanical: nothing here depends on the agent choosing to remember, and
 * nothing here can promote a guess to a fact, because the agent never writes
 * to it.
 *
 * IT LIVES IN shared/ SO THE SUITE CAN REACH IT. An earlier draft sat in main/
 * and imported vault.ts for the vault path; `node --test` cannot resolve a
 * `./x.js` specifier (CLAUDE.md §2), so eleven of its fifteen tests silently
 * SKIPPED while the suite still reported green. The directory is a parameter
 * now, and the only caller that knows it is the supervisor.
 *
 * NOT A NOTE, AND NOT IN THE NOTES. This is an append-only log under
 * `System/`, which is machinery rather than knowledge. Obsidian will not treat
 * it as a note and `list()` will not surface it beside real ones. The curated
 * vault stays curated: AGENTS.md's rule that most turns are worth nothing is
 * about NOTES, and it still holds. A log is allowed to be boring.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** One turn, as the user typed it. */
export interface StatedTurn {
  at: string
  session: string
  text: string
}

/**
 * JSONL, not markdown. The file grows for the life of a vault and is read by
 * machine far more often than by a person; one object per line survives a
 * truncated write and stays greppable, where an appended markdown document
 * would need parsing to tell two turns apart.
 */
export function logPath(vaultDir: string): string {
  return join(vaultDir, 'System', 'stated.jsonl')
}

/**
 * How much history a new session is handed. A cap in CHARACTERS rather than
 * entries, because one pasted stack trace can outweigh a hundred short turns,
 * and the budget that matters is context, not line count.
 */
export const RECALL_BUDGET = 4000

/** Record one turn. Never throws: losing a log line must not fail the turn. */
export function record(text: string, session: string, vaultDir: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return false
  try {
    const file = logPath(vaultDir)
    mkdirSync(dirname(file), { recursive: true })
    const line: StatedTurn = { at: new Date().toISOString(), session, text: trimmed }
    appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
    return true
  } catch {
    // A vault on a disconnected drive, a read-only mount, a path that moved
    // under us. The turn is still the thing the user asked for.
    return false
  }
}

/** Every recorded turn, oldest first. A damaged line is skipped, not fatal. */
export function readAll(vaultDir: string): StatedTurn[] {
  const file = logPath(vaultDir)
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: StatedTurn[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as StatedTurn
      if (parsed && typeof parsed.text === 'string') out.push(parsed)
    } catch {
      // A half-written final line from a killed process. Skip it.
    }
  }
  return out
}

/**
 * The block prepended to the FIRST turn of a session.
 *
 * Newest turns are kept when the budget is tight: a rule stated an hour ago is
 * likelier to still hold than one from six months back, and the old one is
 * still on disk for an agent that goes looking.
 *
 * `excludeSession` drops the current session's own turns, which are already in
 * the model's context. Replaying them would spend budget telling it what it
 * just read.
 */
export function preamble(
  opts: { vaultDir: string; excludeSession?: string; budget?: number },
): string | undefined {
  const budget = opts.budget ?? RECALL_BUDGET
  const turns = readAll(opts.vaultDir)
    .filter((t) => t.session !== opts.excludeSession)
  if (turns.length === 0) return undefined

  const kept: string[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const rendered = `[${turns[i].at.slice(0, 10)}] ${turns[i].text}`
    if (used + rendered.length > budget) break
    kept.unshift(rendered)
    used += rendered.length
  }
  if (kept.length === 0) return undefined

  const omitted = turns.length - kept.length
  return [
    'These are things the user has told you in this vault before, quoted exactly.',
    'They are a record of what was SAID, not a summary and not anything an agent',
    'concluded — treat them as the user speaking, and prefer them over your own',
    'assumptions about conventions in this project.',
    omitted > 0 ? `(${omitted} older turn${omitted === 1 ? '' : 's'} not shown.)` : '',
    '',
    ...kept,
    '',
    '--- end of earlier instructions; the current request follows ---',
  ].filter((l) => l !== '').join('\n')
}
