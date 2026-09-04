/**
 * SECTION 1 — Claude Code pane, main-process half.
 *
 * Owns: sessions, streaming, permission callbacks.
 * Built on `@anthropic-ai/claude-agent-sdk`.
 *
 * Boundary:
 *   SDK owns  -> the agent loop, streaming, tool execution, permission prompts.
 *   We own    -> session records, titles, project scoping and transcript
 *                persistence (the SDK does not keep any of that).
 *
 * Permission callbacks route to the agent corner (src/main/corner.ts,
 * `requestConsent`) rather than resolving themselves. There is one consent
 * surface in this app and it is pane 3.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Handle } from './ipc.js'
import { CH, EV, type Session, type ChatMessage, type PermissionMode } from '../shared/ipc.js'
import { requestConsent } from './corner.js'
import * as supervisor from './supervisor.js'
import * as vault from './vault.js'
import { ConsentDenied } from './consent.js'
import type { Actor } from '../shared/ipc.js'
import type { VaultOp } from './agentHost.js'

/**
 * THE AGENT'S WRITE PATH, and the only one it has.
 *
 * The child process asked; this is where it actually happens, through the same
 * vault.ts functions the user's own clicks go through. Everything that protects
 * a note protects it here too — the pre-edit backup, the atomic rename, the
 * trash, the undo record — and `actor` is what makes the consent gate fire,
 * since this is agent-originated rather than user-originated.
 *
 * The agent's own words are the reason. consent.ts refuses a blank one, and the
 * human reads it verbatim in the prompt.
 *
 * Exported for the tests, which is the point of it being a named function and
 * not the closure it started as: what a test has to be able to reach is the
 * WRITE, not the chat session wrapped around it.
 */
/**
 * The vault-relative folders on the way to `path` that do not exist yet,
 * outermost first.
 *
 * save() will NOT create them, deliberately: "a save that conjures directories
 * out of a typo'd path is how a vault grows junk"
 * (test/section4-data-layer.test.mjs:301). Creating a folder is a separate
 * control with its own dialog for the user, so it is a separate ask for the
 * agent too — which is why this returns a LIST to be gated one at a time rather
 * than handing `{ recursive: true }` to one call.
 */
function missingFolders(path: string): string[] {
  const parts = path.split(/[\/]+/).slice(0, -1)
  const out: string[] = []
  let acc = ''
  for (const part of parts) {
    if (!part) continue
    acc = acc ? `${acc}/${part}` : part
    if (!existsSync(join(vault.getVaultDir(), acc))) out.push(acc)
  }
  return out
}

export async function applyVaultOp(
  sessionId: string,
  req: VaultOp,
): Promise<{ ok: boolean; message: string }> {
  const actor: Actor = { kind: 'agent', sessionId, reason: req.reason }
  try {
    if (req.op === 'write') {
      /**
       * The stamp is read HERE, a moment before the write, and that is not a
       * hole in the lost-update guard — it is where the guard was never
       * pointed. `mtime` protects a caller HOLDING AN OLD BUFFER from
       * clobbering a newer file, and the agent holds no buffer: it is being
       * told to write this text, now.
       *
       * The side that IS protected is the user's, and it comes for free.
       * Their editor still holds the mtime from before this write, so their
       * next save fails the guard and raises ConflictDialog instead of
       * silently dropping what they typed. That is the case the README called
       * missing, and it needed no new code — only for the agent to go through
       * save() like every other caller.
       *
       * A read that fails is treated as "not there yet", which is what makes
       * this the create call too. It cannot decay into a silent clobber: if
       * the file does exist and merely could not be read, save() stats it,
       * compares a real mtime against this 0, and raises SaveConflict.
       */
      // The folders first, each behind its own prompt. Two dialogs for
      // "write a note into a new folder" is not fatigue, it is the two things
      // that are actually happening — and consent.ts keys allowances per kind
      // precisely so that approving folders never quietly approves writes.
      for (const folder of missingFolders(req.path)) {
        await vault.mkdir(folder, actor)
      }
      const cur = await vault.read(req.path).catch(() => null)
      const saved = await vault.save(req.path, req.text, cur?.mtime ?? 0, actor)
      return { ok: true, message: `Wrote ${saved.path}.` }
    }
    const rec = await vault.move(req.from, req.to, actor)
    return { ok: true, message: `Moved ${rec.from} to ${rec.to}. Undo id ${rec.id}.` }
  } catch (e) {
    // A refusal is reported to the agent AS a refusal. Left as a generic error
    // it reads like a fault, and a model that thinks it hit a fault retries —
    // which is how one "no" turns into five prompts.
    if (e instanceof ConsentDenied) {
      return {
        ok: false,
        message: 'The user did not allow this. Do not retry it; ask them what they want instead.',
      }
    }
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

// ================================================================ Types

type StoredSession = Session & {
  /** Session ID from the SDK. Set from the first SDK message of a run and fed
   *  back as `resume` on the next send — without it every turn starts a fresh
   *  conversation with no memory of the previous one. */
  sdkSessionId?: string
  /** Our own three-value mode, per the contract. Absent on sessions written
   *  before this field existed — treat that as 'ask'. */
  permissionMode?: PermissionMode
}

/**
 * Session ids become directory names under userData. They arrive over IPC from
 * the renderer, so they are untrusted input: `../../..` in an id is a path
 * traversal out of the app's own data directory. Ids we mint are UUIDs, so this
 * only ever rejects something that did not come from us.
 */
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}


// ================================================================ Persistence

function getSessionsDir(): string {
  const dir = join(app.getPath('userData'), 'claude-sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function loadSessions(): StoredSession[] {
  const file = join(getSessionsDir(), 'sessions.json')
  if (!existsSync(file)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(raw)) return []
    // A blind `as StoredSession[]` here meant one hand-edited or truncated file
    // put `undefined.id` into every consumer. Keep only rows that are usable,
    // and specifically only ids that are safe as a directory name.
    return raw.filter(
      (s): s is StoredSession =>
        !!s && typeof s === 'object' && isSafeId((s as StoredSession).id) && typeof (s as StoredSession).cwd === 'string',
    )
  } catch {
    return []
  }
}

/**
 * Write via temp file + rename. A bare writeFileSync truncates before it
 * writes, so a crash mid-write leaves a 0-byte file — and every loader here
 * treats an unparseable file as empty, making the loss silent. rename is
 * atomic on NTFS: the file on disk is either the old content or the new.
 */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, data, 'utf-8')
  renameSync(tmp, file)
}

function saveSessions(sessions: StoredSession[]): void {
  const file = join(getSessionsDir(), 'sessions.json')
  atomicWrite(file, JSON.stringify(sessions, null, 2))
}

// ================================================================ Session & message storage

function getSessionDir(id: string): string {
  if (!isSafeId(id)) throw new Error('invalid session id')
  const dir = join(getSessionsDir(), id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function loadSessionHistory(id: string): ChatMessage[] {
  const file = join(getSessionDir(id), 'history.json')
  if (!existsSync(file)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (m): m is ChatMessage => !!m && typeof m === 'object' && Array.isArray((m as ChatMessage).blocks),
    )
  } catch {
    return []
  }
}


function saveSessionHistory(id: string, messages: ChatMessage[]): void {
  const file = join(getSessionDir(id), 'history.json')
  atomicWrite(file, JSON.stringify(messages, null, 2))
}

// ================================================================ Main process bridge

/**
 * Session cache. `null` means "not read from disk yet" — it must NOT start as
 * `[]`, because the lazy-load guard is `if (!cache)` and an empty array is
 * truthy. With `[]` the guard never fired, `loadSessions()` never ran, and
 * sessions.json was write-only: every restart showed an empty session list
 * while the file on disk held every session ever created.
 */
let sessionCache: StoredSession[] | null = null

function getSessions(): StoredSession[] {
  if (!sessionCache) sessionCache = loadSessions()
  return sessionCache
}

function getWindow(): BrowserWindow | null {
  // Not `require('electron')` — this module is ESM, and the import above is
  // already the same object.
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

function pushMessage(id: string, message: ChatMessage): void {
  const win = getWindow()
  if (win) win.webContents.send(EV.claudeMessage, id, message)
}

function pushSessionUpdate(session: Session): void {
  const win = getWindow()
  if (win) win.webContents.send(EV.claudeSessionUpdate, session)
}

// ================================================================ IPC handlers

export function register(handle: Handle): void {
  handle(CH.claudeNewSession, async (cwd: string) => {
    const sessions = getSessions()
    // crypto.randomUUID, not Math.random().toString(36) — this id is a
    // directory name, and `Math.random()` can produce a two-character string
    // often enough for two sessions to land in the same folder.
    const id = randomUUID()
    const session: StoredSession = {
      id,
      title: 'New session',
      cwd,
      status: 'idle',
      updatedAt: Date.now(),
    }
    sessions.push(session)
    saveSessions(sessions)
    return session
  })

  handle(CH.claudeSend, async (id: string, text: string) => {
    const sessions = getSessions()
    const session = sessions.find((s) => s.id === id)
    if (!session) throw new Error(`Session ${id} not found`)

    if (supervisor.isRunning(id)) throw new Error(`Session ${id} is already running`)

    const setStatus = (status: Session['status']): void => {
      session.status = status
      session.updatedAt = Date.now()
      saveSessions(sessions)
      pushSessionUpdate(session)
    }

    const history = loadSessionHistory(id)

    // The user's own turn is part of the transcript. It was never recorded, so
    // reopening a session showed the answers with none of the questions.
    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      blocks: [{ kind: 'text', text }],
      at: Date.now(),
    }
    history.push(userMsg)
    pushMessage(id, userMsg)

    // Titles are ours to own, per the contract. Derive one from the opening
    // turn instead of leaving every row in the list reading "New session".
    if (!session.title || session.title === 'New session') {
      session.title = text.trim().split('\n')[0].slice(0, 60) || 'New session'
    }

    setStatus('running')

    /**
     * The turn runs in ITS OWN PROCESS now (src/main/supervisor.ts). Nothing
     * about the conversation changed; what changed is that a session which dies
     * badly can no longer take the window, the editor buffer and every other
     * session with it.
     *
     * This never throws for an agent failure. It used to rethrow, which turned
     * a failed run into a rejected IPC call and a red toast with no transcript;
     * the outcome is now a record, and a failure or a crash is written INTO the
     * transcript where the user is already looking.
     */
    const record = await supervisor.run(session, text, {
      onSdkSession: (sdkSessionId) => {
        // Remember the SDK's own session id so the next turn can resume it.
        session.sdkSessionId = sdkSessionId
      },
      onBlocks: (role, blocks) => {
        const msg: ChatMessage = { id: randomUUID(), role, blocks, at: Date.now() }
        history.push(msg)
        pushMessage(id, msg)
      },
      onStatus: (status) => setStatus(status),
      onConsent: (toolName, input) =>
        // The ONE consent surface: pane 3. The child process cannot reach it and
        // is not allowed to become a second one.
        requestConsent({
          title: `Allow ${toolName}`,
          detail: `The agent wants to ${toolName} with these arguments: ${JSON.stringify(input)}`,
          severity: 'info',
        }),
      onVaultOp: (req) => applyVaultOp(id, req),
      onExit: () => {},
    })

    /**
     * A crash is TRANSCRIPT CONTENT, not a console line.
     *
     * The session it happened in is the only place the user will look, and an
     * agent that stops mid-sentence with the dot flicking to "idle" is
     * indistinguishable from one that simply finished. Say which happened, and
     * say the thing that is easy to doubt: the others are still alive.
     */
    if (record.reason === 'crash' || record.reason === 'failed') {
      const msg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        blocks: [
          {
            kind: 'text',
            text:
              record.reason === 'crash'
                ? `⚠ This agent's process stopped unexpectedly. Other sessions are unaffected.\n\n${record.message}`
                : `⚠ This turn failed.\n\n${record.message}`,
          },
        ],
        at: Date.now(),
      }
      history.push(msg)
      pushMessage(id, msg)
    }

    saveSessionHistory(id, history)
    setStatus(record.reason === 'done' || record.reason === 'killed' ? 'idle' : 'error')
  })

  handle(CH.claudeInterrupt, async (id: string) => {
    const sessions = getSessions()
    const session = sessions.find((s) => s.id === id)
    if (!session) return

    // Ask the child's SDK to stop the turn. Still best-effort, and still not a
    // kill: an interrupt should end the turn, not lose the process and with it
    // the resume id. `/kill` is the bigger hammer and is a separate command.
    supervisor.interrupt(id)

    if (session.status === 'running' || session.status === 'awaiting-permission') {
      session.status = 'idle'
      session.updatedAt = Date.now()
      saveSessions(sessions)
      pushSessionUpdate(session)
    }
  })

  handle(CH.claudeHistory, async (id: string) => {
    if (!isSafeId(id)) throw new Error('invalid session id')
    return loadSessionHistory(id)
  })

  handle(CH.claudeSetPermissionMode, async (id: string, mode: PermissionMode) => {
    const sessions = getSessions()
    const session = sessions.find((s) => s.id === id)
    if (!session) throw new Error(`Session ${id} not found`)
    // The renderer is untrusted input. An unrecognised string here would fall
    // through toSdkPermissionMode's default and silently read as 'ask'.
    if (mode !== 'ask' && mode !== 'accept-edits' && mode !== 'bypass') {
      throw new Error(`Unknown permission mode: ${String(mode)}`)
    }
    // Persist it and take effect on the next send(). A silently-ignored mode
    // change is worse than an unsupported one: the chip reads "bypass" while
    // the session still asks, or reads "ask" while it does not.
    //
    // ponytail: applies from the next turn, not mid-run. Reach for the SDK's
    // in-flight mode change only once a run can actually outlive a mode switch.
    session.permissionMode = mode
    session.updatedAt = Date.now()
    saveSessions(sessions)
    pushSessionUpdate(session)
  })
}
