/**
 * THE SUPERVISOR — one OS process per agent session, and a crash that stays
 * local to the session that caused it.
 *
 * Before this, `query()` ran inline in the main process for every session. That
 * put the SDK transport, its stream parsing and our block handling on the same
 * thread as the window: one unhandled rejection, one OOM on a long transcript,
 * one unexpected block shape, and the whole app went down — the vault pane, the
 * unsaved editor buffer, and every other agent with it.
 *
 * WHAT THIS GUARANTEES, precisely, because "sandboxed" is a word people mean
 * different things by:
 *
 *   ✓ FAULT ISOLATION. A child that throws, OOMs, or is killed takes down
 *     nothing but itself. The parent learns from an `exit` event, marks that one
 *     session `error`, and every other child keeps streaming.
 *   ✓ RESOURCE ISOLATION. Separate heap, separate GC. A 400 MB transcript in one
 *     session cannot slow the editor's typing.
 *   ✓ LIFECYCLE ISOLATION. Killing a session is `kill()` on a pid, not an
 *     attempt to unwind a shared async iterator that may not be listening.
 *
 *   ✗ NOT a security sandbox. The child is a full Node process with the same
 *     user, the same filesystem rights and the same network as the app. It is
 *     protection against a session BREAKING, not against one being malicious.
 *     What restrains a session's reach is `tools` plus the consent gate, and
 *     those are unchanged. Anyone reading "sandbox" here as "it cannot hurt me"
 *     would be wrong, so the word is avoided everywhere else in this file.
 *
 * A process per TURN, not a long-lived pool. An idle agent should not hold a
 * Node heap and an SDK subprocess open, and the SDK's own `resume` already
 * carries the conversation across turns, so there is nothing in memory worth
 * keeping between them.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { ChatBlock, PermissionMode, Session } from '../shared/ipc.js'
import type { HostOutbound, VaultOp } from './agentHost.js'

/** What the supervisor tells its caller about a live child. */
export interface AgentProcessInfo {
  sessionId: string
  pid: number | null
  /** ms since epoch. */
  startedAt: number
  status: 'starting' | 'running' | 'awaiting-permission'
  /** Most recent figures the child reported, or null before its first tick. */
  rss: number | null
  heapUsed: number | null
}

/** How a child stopped. `crash` is the one that used to take the app with it. */
export type ExitReason = 'done' | 'failed' | 'killed' | 'crash'

export interface ExitRecord {
  sessionId: string
  reason: ExitReason
  /** Process exit code, when the OS gave one. */
  code: number | null
  message: string
  at: number
}

/** Everything the caller wants to hear from a running turn. */
export interface RunCallbacks {
  onBlocks: (role: 'assistant' | 'user', blocks: ChatBlock[]) => void
  onSdkSession: (sdkSessionId: string) => void
  onStatus: (status: Session['status']) => void
  /** Resolve true to allow the tool call. */
  onConsent: (toolName: string, input: unknown) => Promise<boolean>
  /**
   * Perform one vault operation on the child's behalf, and say what happened.
   *
   * This never rejects: a refusal and a failure are both `ok: false` with a
   * message, because the child has to hand SOMETHING back to the model and an
   * unanswered round trip would hang the turn until the process is killed.
   */
  onVaultOp: (request: VaultOp) => Promise<{ ok: boolean; message: string }>
  /** Exactly once, whatever happens. */
  onExit: (record: ExitRecord) => void
}

interface Child {
  proc: UtilityProcess
  info: AgentProcessInfo
  /** Set the moment we know why it is ending, so `exit` can tell crash from
   *  an orderly finish. Absent at exit time IS the definition of a crash. */
  reason: ExitReason | null
  message: string
  settled: boolean
}

const children = new Map<string, Child>()

/**
 * The last 50 exits, newest last. `/agents` shows the live tree; this is what
 * makes a crash visible AFTER the process is gone, which is the only time
 * anyone goes looking for it.
 */
const exits: ExitRecord[] = []
const EXIT_LOG_MAX = 50

function recordExit(record: ExitRecord): void {
  exits.push(record)
  if (exits.length > EXIT_LOG_MAX) exits.splice(0, exits.length - EXIT_LOG_MAX)
}

/**
 * Where the built child entry lands. electron-vite emits main-process entries to
 * `out/main/`, beside this file, so resolving relative to __dirname works in the
 * packaged app and in dev alike.
 */
let HOST_ENTRY: string | null = null

function hostEntry(): string {
  return HOST_ENTRY ?? join(__dirname, 'agentHost.js')
}

/**
 * For tests only: run a different child.
 *
 * The isolation guarantee cannot be proved against the real host, because that
 * one needs API credentials and a working agent turn to reach the interesting
 * code path. Pointing it at a script that crashes ON PURPOSE is the only way to
 * assert "one dies, the others live" rather than assume it. Same escape hatch,
 * same naming, as `_setVaultDirForTest` in vault.ts.
 */
export function _setHostEntryForTest(entry: string | null): void {
  HOST_ENTRY = entry
}

export function isRunning(sessionId: string): boolean {
  return children.has(sessionId)
}

/** Live children, for `/agents`. */
export function listProcesses(): AgentProcessInfo[] {
  return [...children.values()].map((c) => ({ ...c.info }))
}

/** Recent exits, newest last, for `/agents` and `/logs`. */
export function listExits(): ExitRecord[] {
  return exits.map((e) => ({ ...e }))
}

/**
 * Stop one session's process. Returns false when there was nothing to kill,
 * which the caller needs in order to say "no such agent" rather than lying
 * about having stopped something.
 */
export function kill(sessionId: string): boolean {
  const child = children.get(sessionId)
  if (!child) return false
  child.reason = 'killed'
  child.message = 'Killed from the terminal'
  child.proc.kill()
  return true
}

/** Ask the SDK to stop the turn without killing the process. */
export function interrupt(sessionId: string): boolean {
  const child = children.get(sessionId)
  if (!child) return false
  child.proc.postMessage({ kind: 'interrupt' })
  return true
}

/**
 * Kill everything. Called on app quit so no agent process outlives the window
 * that owns it — an orphan here is a Node process the user cannot see and did
 * not ask for.
 */
export function killAll(): void {
  for (const id of [...children.keys()]) kill(id)
}

/**
 * Run one turn in a fresh process.
 *
 * Resolves when the process has exited, so the caller can persist the
 * transcript exactly once and know nothing more is coming.
 */
export function run(
  session: { id: string; cwd: string; permissionMode?: PermissionMode; sdkSessionId?: string },
  text: string,
  cb: RunCallbacks,
): Promise<ExitRecord> {
  if (children.has(session.id)) {
    return Promise.reject(new Error(`Session ${session.id} is already running`))
  }

  const proc = utilityProcess.fork(hostEntry(), [], {
    // The child needs no window and no stdin. stdout/stderr are piped so a
    // native crash message is captured rather than vanishing into the void —
    // without this, "it just died" is all anyone would ever get.
    stdio: 'pipe',
    serviceName: `agent-${session.id.slice(0, 8)}`,
  })

  const child: Child = {
    proc,
    info: {
      sessionId: session.id,
      pid: null,
      startedAt: Date.now(),
      status: 'starting',
      rss: null,
      heapUsed: null,
    },
    reason: null,
    message: '',
    settled: false,
  }
  children.set(session.id, child)

  /** Anything the child printed before dying. The only clue a hard crash leaves. */
  let stderr = ''
  proc.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000)
  })

  return new Promise<ExitRecord>((resolve) => {
    const settle = (reason: ExitReason, code: number | null, message: string): void => {
      if (child.settled) return
      child.settled = true
      children.delete(session.id)
      const record: ExitRecord = {
        sessionId: session.id,
        reason,
        code,
        message,
        at: Date.now(),
      }
      recordExit(record)
      cb.onExit(record)
      resolve(record)
    }

    proc.on('spawn', () => {
      child.info.pid = proc.pid ?? null
      child.info.status = 'running'
      proc.postMessage({
        kind: 'start',
        text,
        cwd: session.cwd,
        permissionMode: session.permissionMode,
        resume: session.sdkSessionId,
      })
    })

    proc.on('message', (raw: unknown) => {
      const msg = raw as HostOutbound
      if (!msg || typeof msg !== 'object') return

      switch (msg.kind) {
        case 'sdk-session':
          cb.onSdkSession(msg.sdkSessionId)
          break
        case 'blocks':
          cb.onBlocks(msg.role, msg.blocks)
          break
        case 'status':
          if (msg.status === 'running' || msg.status === 'awaiting-permission') {
            child.info.status = msg.status
          }
          cb.onStatus(msg.status)
          break
        case 'mem':
          child.info.rss = msg.rss
          child.info.heapUsed = msg.heapUsed
          break
        case 'consent-request':
          // The child cannot decide this. It round-trips here, and the answer
          // comes from the one consent surface in the app.
          void cb
            .onConsent(msg.toolName, msg.input)
            .catch(() => false)
            .then((allow) => {
              // The child may already be gone — a kill during a consent prompt
              // is an ordinary race, not an error.
              if (!child.settled) {
                proc.postMessage({ kind: 'consent-reply', nonce: msg.nonce, allow })
              }
            })
          break
        case 'vault-request':
          // Same shape as consent, and for the same reason: the child owns no
          // vault access, so the operation happens HERE or not at all.
          void cb
            .onVaultOp(msg.request)
            .catch((e: unknown) => ({
              ok: false,
              message: e instanceof Error ? e.message : String(e),
            }))
            .then((reply) => {
              // The child may already be gone — a kill mid-operation is an
              // ordinary race. The vault work itself already happened or
              // already did not; nothing is left half-done by skipping this.
              if (!child.settled) {
                proc.postMessage({ kind: 'vault-reply', nonce: msg.nonce, ...reply })
              }
            })
          break
        case 'failed':
          // A REPORTED failure. The run broke and told us how, which is a
          // different and much better thing than a crash.
          child.reason = 'failed'
          child.message = msg.message
          break
        case 'done':
          child.reason = 'done'
          break
      }
    })

    /**
     * THE WHOLE POINT OF THE FILE.
     *
     * Every child ends here, and `child.reason` is what separates an orderly
     * finish from a crash: the child sets it by reporting `done` or `failed`
     * before exiting, and a kill sets it on the way out. Arriving with it still
     * null means the process died without saying anything — OOM, a native
     * fault, an unhandled rejection — and that is exactly the case that used to
     * take the entire app down. Now it ends one session.
     */
    proc.on('exit', (code: number) => {
      if (child.reason === 'done') {
        settle('done', code, '')
      } else if (child.reason === 'failed') {
        settle('failed', code, child.message)
      } else if (child.reason === 'killed') {
        settle('killed', code, child.message)
      } else {
        settle(
          'crash',
          code,
          // The exit code alone is unreadable (Windows hands back things like
          // 3221225477 for an access violation), so carry whatever the process
          // managed to print. This string is the difference between a bug
          // someone can chase and one they cannot.
          stderr.trim() ||
            `The agent process exited unexpectedly with code ${code}. Other sessions were not affected.`,
        )
      }
    })
  })
}
