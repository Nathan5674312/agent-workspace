/**
 * ONE AGENT SESSION, IN ITS OWN OS PROCESS.
 *
 * This file is not imported by anything. It is an ENTRY POINT: the supervisor
 * (src/main/supervisor.ts) launches it with Electron's `utilityProcess`, one
 * instance per agent session, and talks to it over the port.
 *
 * WHY A SEPARATE PROCESS AT ALL, given the SDK already spawns the Claude Code
 * CLI as a child: the agent LOOP was never the fragile part. What runs in-process
 * is the SDK's transport, its stream parsing, and our own message handling — and
 * all of that ran in the MAIN process, where an unhandled rejection, an OOM on a
 * large transcript, or one bad block shape takes down the window, the vault
 * pane, the editor buffer and every other session with it. Moving it here makes
 * a session's worst case "that session died" instead of "the app died".
 *
 * THE RULES THIS FILE LIVES BY:
 *
 *   - It owns no state the app needs. Session records and transcripts are
 *     written by the parent, so a process dying loses nothing that was not
 *     already on its way out.
 *   - It never touches the vault. The only filesystem this reaches is whatever
 *     the SDK's own tools reach, under `cwd`, gated by `canUseTool`.
 *   - Consent is NOT decided here. `canUseTool` round-trips to the parent, which
 *     asks the agent corner — there is one consent surface in this app and a
 *     child process is not allowed to become a second one.
 *   - It exits when the turn ends. A process per session, not a pool: an idle
 *     agent should not hold a Node heap open.
 */
import { query, createSdkMcpServer, tool, type Query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatBlock, PermissionMode } from '../shared/ipc.js'

/** Sent parent -> child exactly once, to start the turn. */
export type HostStart = {
  kind: 'start'
  text: string
  cwd: string
  permissionMode: PermissionMode | undefined
  resume: string | undefined
}

/** Parent -> child, answering a consent round trip. */
export type HostConsentReply = { kind: 'consent-reply'; nonce: number; allow: boolean }

/**
 * Parent -> child, answering a vault round trip.
 *
 * `ok: false` is not only a crash. A human refusing the write arrives here the
 * same way, and `message` is what the agent is told either way — which is the
 * point: an agent that was denied should read that it was denied, in words, and
 * stop asking, rather than see a transport error and retry.
 */
export type HostVaultReply = {
  kind: 'vault-reply'
  nonce: number
  ok: boolean
  message: string
}

/**
 * What the child asks the parent to do to the vault. One variant per tool.
 *
 * `reason` rides along on every one because consent.ts refuses an agent actor
 * without a non-empty one, and it is the whole of what the human judges by.
 */
export type VaultOp =
  | { op: 'write'; path: string; text: string; reason: string }
  | { op: 'move'; from: string; to: string; reason: string }

/** Parent -> child, asking the SDK to stop the current turn. */
export type HostInterrupt = { kind: 'interrupt' }

export type HostInbound = HostStart | HostConsentReply | HostVaultReply | HostInterrupt

/** Child -> parent. */
export type HostOutbound =
  | { kind: 'sdk-session'; sdkSessionId: string }
  | { kind: 'blocks'; role: 'assistant' | 'user'; blocks: ChatBlock[] }
  | { kind: 'consent-request'; nonce: number; toolName: string; input: unknown }
  | { kind: 'vault-request'; nonce: number; request: VaultOp }
  | { kind: 'status'; status: 'running' | 'awaiting-permission' | 'idle' | 'error' }
  | { kind: 'failed'; message: string }
  | { kind: 'done' }
  | { kind: 'mem'; rss: number; heapUsed: number }

/**
 * Guard against a child that is asked to run twice. The supervisor spawns one
 * process per turn, so a second `start` means a bug upstream, and running it
 * would interleave two SDK streams onto one port.
 */
let started = false
let run: Query | null = null

/** Outstanding consent round trips, by nonce. */
const pending = new Map<number, (allow: boolean) => void>()

/** Outstanding vault round trips, by nonce. Shares `nextNonce` so the two
 *  kinds of round trip can never collide on one number. */
const vaultPending = new Map<number, (reply: { ok: boolean; message: string }) => void>()

let nextNonce = 1

const send = (msg: HostOutbound): void => {
  process.parentPort.postMessage(msg)
}

function toSdkPermissionMode(
  mode: PermissionMode | undefined,
): 'default' | 'acceptEdits' | 'bypassPermissions' {
  switch (mode) {
    case 'accept-edits':
      return 'acceptEdits'
    case 'bypass':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}

/**
 * Tool results arrive as either a plain string or Anthropic content blocks.
 * Flattened here rather than letting `[object Object]` reach the pane — same
 * reason and same shape as the version this replaced in claude.ts.
 */
function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Ask the parent. Resolves false if the port dies mid-question — a child that
 * cannot reach the consent surface must DENY, never assume yes. This is the one
 * place where "the transport broke" and "the human said no" have to collapse to
 * the same answer, and the safe one is no.
 */
function requestConsent(toolName: string, input: unknown): Promise<boolean> {
  const nonce = nextNonce++
  return new Promise<boolean>((resolve) => {
    pending.set(nonce, resolve)
    send({ kind: 'consent-request', nonce, toolName, input })
  })
}

/** Ask the parent to perform one vault operation. Same round trip as consent,
 *  for the same reason: the child is not allowed to touch the vault itself. */
function requestVault(request: VaultOp): Promise<{ ok: boolean; message: string }> {
  const nonce = nextNonce++
  return new Promise((resolve) => {
    vaultPending.set(nonce, resolve)
    send({ kind: 'vault-request', nonce, request })
  })
}

/** An MCP tool answers with content blocks, and flags a failure rather than
 *  throwing — a thrown handler reaches the model as a transport fault, not as
 *  "the human said no", and those must not look alike. */
function toolResult(r: { ok: boolean; message: string }) {
  return { content: [{ type: 'text' as const, text: r.message }], isError: !r.ok }
}

/**
 * THE VAULT TOOLS — the only way an agent may change a file.
 *
 * Deliberately NOT the SDK's own Write and Edit. Those go straight to disk,
 * which walks past all four things vault.ts owns: the consent gate, the
 * pre-edit backup under `.backups/`, the lost-update guard, and the atomic
 * temp-then-rename. A write tool that skips those is not a smaller version of
 * this feature, it is a worse and different one, and the failure it produces —
 * a note silently overwritten while the user had it open — is exactly the one
 * the rest of this codebase is arranged to prevent.
 *
 * So these do NO filesystem work. Each round-trips to the parent, exactly as
 * consent already does, and the parent calls vault.ts with an agent Actor. The
 * rule at the top of this file is unchanged: this process never touches the
 * vault.
 *
 * There is no delete tool, and that is a decision rather than an omission. A
 * move to `.trash/` is what deletion means here and `move_note` already
 * expresses it, reversibly, through the one path that records an undo.
 */
const vaultTools = createSdkMcpServer({
  name: 'vault',
  version: '1.0.0',
  tools: [
    tool(
      'write_note',
      'Write a note in the vault, creating it if it does not exist. Supply the COMPLETE new text; this REPLACES the file rather than appending to it, so read the note first unless you are creating it. The user is asked to approve before anything is written, and the previous contents are kept.',
      {
        path: z.string().describe('Vault-relative path, e.g. "Projects/AI.md".'),
        text: z.string().describe('The complete new contents of the note.'),
        reason: z
          .string()
          .describe('Why this write should happen, in one sentence a human can judge. Shown to the user verbatim.'),
      },
      async (args) => toolResult(await requestVault({ op: 'write', ...args })),
    ),
    tool(
      'move_note',
      'Move or rename a note in the vault. Reversible: the move is recorded and can be undone. The user is asked to approve first.',
      {
        from: z.string().describe('Current vault-relative path.'),
        to: z.string().describe('New vault-relative path.'),
        reason: z
          .string()
          .describe('Why this move should happen, in one sentence a human can judge. Shown to the user verbatim.'),
      },
      async (args) => toolResult(await requestVault({ op: 'move', ...args })),
    ),
  ],
})

async function start(msg: HostStart): Promise<void> {
  send({ kind: 'status', status: 'running' })
  try {
    run = query({
      prompt: msg.text,
      options: {
        cwd: msg.cwd,
        // `tools` restricts which BUILT-IN tools exist, and this list is
        // still read-only on purpose: no Bash, and no built-in Write or Edit,
        // because those write to disk behind vault.ts's back. See vaultTools.
        tools: ['Read', 'Glob', 'Grep'],
        // Mutation lives here instead, in tools that cannot reach the disk
        // themselves. `tools` above does not govern MCP tools, so restricting
        // the built-ins and offering these are not in tension.
        mcpServers: { vault: vaultTools },
        // Auto-approved HERE deliberately, and it is not a hole in the gate.
        // Every one of these ends in vault.ts, which raises the REAL prompt
        // through consent.ts — the agent's stated reason, the exact paths, the
        // batch grants, strict mode, the timeout that counts as a refusal.
        // Leaving them to canUseTool as well would ask twice for one action:
        // first as `Allow mcp__vault__write_note` over a blob of JSON, then
        // properly. A human who has learned to click through the first prompt
        // is in a worse position than one who only ever saw the second, which
        // is the same argument consent.ts opens with.
        allowedTools: ['mcp__vault__write_note', 'mcp__vault__move_note'],
        permissionMode: toSdkPermissionMode(msg.permissionMode),
        allowDangerouslySkipPermissions: msg.permissionMode === 'bypass',
        resume: msg.resume,
        canUseTool: async (toolName, input) => {
          send({ kind: 'status', status: 'awaiting-permission' })
          try {
            const allow = await requestConsent(toolName, input)
            return allow
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'User denied' }
          } finally {
            send({ kind: 'status', status: 'running' })
          }
        },
      },
    })

    for await (const sdkMsg of run) {
      if ('session_id' in sdkMsg && sdkMsg.session_id) {
        send({ kind: 'sdk-session', sdkSessionId: sdkMsg.session_id })
      }

      if (sdkMsg.type === 'assistant' && sdkMsg.message?.content) {
        const blocks: ChatBlock[] = []
        for (const block of sdkMsg.message.content) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anyBlock = block as any
          if ('text' in block) {
            blocks.push({ kind: 'text', text: anyBlock.text })
          } else if ('thinking' in block) {
            blocks.push({ kind: 'thinking', text: anyBlock.thinking })
          } else if ('type' in block && anyBlock.type === 'tool_use') {
            blocks.push({
              kind: 'tool_use',
              id: anyBlock.id,
              name: anyBlock.name,
              input: anyBlock.input,
            })
          }
        }
        if (blocks.length > 0) send({ kind: 'blocks', role: 'assistant', blocks })
      }

      if (sdkMsg.type === 'user' && !('isReplay' in sdkMsg && sdkMsg.isReplay)) {
        const content = sdkMsg.message?.content
        if (Array.isArray(content)) {
          const blocks: ChatBlock[] = []
          for (const block of content) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyBlock = block as any
            if (anyBlock?.type !== 'tool_result') continue
            blocks.push({
              kind: 'tool_result',
              id: anyBlock.tool_use_id,
              content: renderToolResult(anyBlock.content),
              isError: anyBlock.is_error === true,
            })
          }
          if (blocks.length > 0) send({ kind: 'blocks', role: 'user', blocks })
        }
      }

      if (sdkMsg.type === 'result') {
        send({ kind: 'status', status: sdkMsg.subtype === 'success' ? 'idle' : 'error' })
      }
    }
    send({ kind: 'done' })
  } catch (e) {
    // Reported, not thrown. A throw here would become an unhandled rejection and
    // kill this process — which the supervisor would then report as a CRASH,
    // when in fact the run failed cleanly and the distinction matters: a crash
    // means "we do not know what happened", a failure means "we do".
    send({ kind: 'failed', message: e instanceof Error ? e.message : String(e) })
  } finally {
    run = null
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data as HostInbound
  if (!msg || typeof msg !== 'object') return

  if (msg.kind === 'start') {
    if (started) return
    started = true
    void start(msg)
    return
  }

  if (msg.kind === 'consent-reply') {
    const resolve = pending.get(msg.nonce)
    if (resolve) {
      pending.delete(msg.nonce)
      resolve(msg.allow === true)
    }
    return
  }

  if (msg.kind === 'vault-reply') {
    const resolve = vaultPending.get(msg.nonce)
    if (resolve) {
      vaultPending.delete(msg.nonce)
      resolve({ ok: msg.ok === true, message: String(msg.message ?? '') })
    }
    return
  }

  if (msg.kind === 'interrupt') {
    // Best effort, exactly as in the in-process version: the `finally` above
    // settles the turn either way, and the supervisor can still kill the
    // process if the SDK will not stop.
    void run?.interrupt().catch(() => {})
  }
})

/**
 * Orphan prevention is the PARENT's job, not this file's.
 *
 * `process.parentPort` only emits `message` — there is no `close` to listen for,
 * so a child cannot notice its parent dying. The supervisor kills every child on
 * app quit (`killAll`, wired in src/main/index.ts) instead, which is the only
 * place that reliably knows the app is going away.
 */

/**
 * Answer /mem from inside the process being asked about. The parent knows the
 * pid but not the heap, and asking the OS for RSS gives a number that is true
 * of the whole process rather than of V8.
 */
setInterval(() => {
  const m = process.memoryUsage()
  send({ kind: 'mem', rss: m.rss, heapUsed: m.heapUsed })
}, 5000).unref()
