/**
 * HOW AN AGENT OUTSIDE THE APP REACHES THE RUNNING WINDOW.
 *
 * The MCP server (src/main/mcp.ts) runs in the agent's process, not the app's.
 * To make the Fate window show a view, or to tell it a note changed underneath
 * it, it has to find the app. So the app listens on a random localhost port and
 * leaves `{ port, token, vault, pid }` in the OS temp folder, in a file named
 * after the vault it has open. The MCP server was started with that vault's
 * path, computes the same name, and knows where to knock.
 *
 * What the token is for, honestly: any process running as this user can read
 * the temp file, so it does not stop a hostile program already running as you.
 * It stops other users on the machine and stray local requests. And the whole
 * reach of a request is "show this view" or "re-read the folder", nothing that
 * changes a file.
 *
 * Shared by both sides so the file name and the accepted shapes cannot drift.
 */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export type ControlInfo = { port: number; token: string; vault: string; pid: number }

/** The surfaces an agent may bring forward. The MainView names the app already uses. */
export const VIEWS = ['editor', 'graph', 'canvas', 'database', 'roadmap', 'planner'] as const
export type AgentView = (typeof VIEWS)[number]
export type OpenRequest = { view: AgentView; path?: string }

/** Case-folded and trailing-slash-free: Windows paths are, and two spellings of one vault must meet. */
const key = (vault: string): string => resolve(vault).replace(/[\\/]+$/, '').toLowerCase()

export const sameVault = (a: string, b: string): boolean => key(a) === key(b)

export function controlFile(vault: string, dir: string = tmpdir()): string {
  const id = createHash('sha256').update(key(vault)).digest('hex').slice(0, 16)
  return join(dir, `fate-control-${id}.json`)
}

/**
 * Null for anything that is not a request this channel serves. The renderer
 * re-validates the path when it reads the note; this only keeps obvious junk,
 * and any climb out of the vault, from ever reaching it.
 */
export function parseOpen(body: unknown): OpenRequest | null {
  const b = body as { view?: unknown; path?: unknown } | null
  if (!b || typeof b !== 'object' || !VIEWS.includes(b.view as AgentView)) return null
  const view = b.view as AgentView
  if (b.path === undefined) return { view }
  if (typeof b.path !== 'string' || b.path.trim() === '') return null
  const path = b.path.replace(/\\/g, '/')
  if (path.split('/').includes('..') || /^([a-z]:|\/)/i.test(path)) return null
  return { view, path }
}
