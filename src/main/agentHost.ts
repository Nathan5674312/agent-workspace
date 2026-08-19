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
import { query, type Query } from '@anthropic-ai/claude-agent-sdk'
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

/** Parent -> child, asking the SDK to stop the current turn. */
export type HostInterrupt = { kind: 'interrupt' }

export type HostInbound = HostStart | HostConsentReply | HostInterrupt

/** Child -> parent. */
export type HostOutbound =
  | { kind: 'sdk-session'; sdkSessionId: string }
  | { kind: 'blocks'; role: 'assistant' | 'user'; blocks: ChatBlock[] }
  | { kind: 'consent-request'; nonce: number; toolName: string; input: unknown }
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

async function start(msg: HostStart): Promise<void> {
  send({ kind: 'status', status: 'running' })
  try {
    run = query({
      prompt: msg.text,
      options: {
        cwd: msg.cwd,
        // Unchanged from claude.ts: `tools` restricts what EXISTS.
        // `allowedTools` is the auto-approve list and would let Read/Glob/Grep
        // run without ever reaching canUseTool.
        tools: ['Read', 'Glob', 'Grep'],
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
