/**
 * THE VAULT'S STANDING ORDERS, HANDED TO THE AGENT EVERY TURN.
 *
 * A vault says how agents should behave in it — `AGENTS.md` and `CLAUDE.md` at
 * its root — and the in-app agent never saw either. Agent SDK 0.1 stopped
 * loading CLAUDE.md by default, and turning that back on (`settingSources:
 * ['project']`) would ALSO load the vault's `.claude/settings.json`, whose hooks
 * run shell commands. This agent has no shell on purpose, and a vault somebody
 * sent you is not a reason to give it one. So the parent reads the two files
 * itself and the child puts them in the system prompt: the rules arrive, the
 * hooks do not.
 *
 * System prompt, not the front of the message the way stated.ts does it: these
 * are the vault's policy, and policy is what a system prompt is for. Sent on
 * every turn, resumes included, because a system prompt is not part of the
 * transcript a resume replays.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Read in this order. AGENTS.md is the operating manual; CLAUDE.md often just points at it. */
export const ORDER_FILES = ['AGENTS.md', 'CLAUDE.md']

/** Per file, in characters. A runaway AGENTS.md must not ride along on every turn. */
export const ORDERS_MAX = 20_000

export function standingOrders(vaultDir: string, max = ORDERS_MAX): string | undefined {
  const parts: string[] = []
  for (const name of ORDER_FILES) {
    let text: string
    try {
      text = readFileSync(join(vaultDir, name), 'utf8').trim()
    } catch {
      continue // absent is the normal case for a fresh vault, not an error
    }
    if (!text) continue
    const body =
      text.length > max ? `${text.slice(0, max)}\n\n(cut at ${max} characters; read ${name} for the rest)` : text
    parts.push(`<${name}>\n${body}\n</${name}>`)
  }
  if (parts.length === 0) return undefined
  return [
    "This vault's own instructions for agents, verbatim from its root. They are the user's rules for working here: follow them.",
    ...parts,
  ].join('\n\n')
}
