/**
 * SECTION 1 — Claude Code pane, main-process half.
 *
 * Owns: sessions, streaming, permission callbacks, stats.
 * Built on `@anthropic-ai/claude-agent-sdk`.
 *
 * Boundary:
 *   SDK owns  -> the agent loop, streaming, tool execution, permission prompts.
 *   We own    -> session records, titles, project scoping, stats + heatmap
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
import { query, type Query } from '@anthropic-ai/claude-agent-sdk'
import type { Handle } from './ipc.js'
import { CH, EV, type Session, type ChatMessage, type Stats, type PermissionMode, type ChatBlock } from '../shared/ipc.js'
import { requestConsent } from './corner.js'

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

/**
 * Our contract exposes three modes; the SDK's union has six. Map explicitly.
 *
 * 'ask' maps to 'default', NOT to 'plan'. Plan mode is read-only planning — a
 * session in it will not execute anything, which is a different product
 * behaviour, not a stricter version of "ask me first". Getting this wrong makes
 * the agent look broken rather than cautious.
 */
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

type StatsData = {
  sessionIds: string[]
  messagesByDay: Map<string, number>
  tokensByDay: Map<string, number>
  modelCounts: Map<string, number>
  /** Local hour-of-day (0-23) -> message count. Drives the peak-hour tile. */
  messagesByHour: Map<number, number>
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

function getStatsFile(): string {
  return join(getSessionsDir(), 'stats.json')
}

const emptyStats = (): StatsData => ({
  sessionIds: [],
  messagesByDay: new Map(),
  tokensByDay: new Map(),
  modelCounts: new Map(),
  messagesByHour: new Map(),
})

function loadStats(): StatsData {
  const file = getStatsFile()
  if (!existsSync(file)) return emptyStats()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    return {
      sessionIds: Array.isArray(raw.sessionIds) ? raw.sessionIds : [],
      messagesByDay: new Map(Array.isArray(raw.messagesByDay) ? raw.messagesByDay : []),
      tokensByDay: new Map(Array.isArray(raw.tokensByDay) ? raw.tokensByDay : []),
      modelCounts: new Map(Object.entries(raw.modelCounts ?? {})),
      messagesByHour: new Map(
        (Array.isArray(raw.messagesByHour) ? raw.messagesByHour : []).map(
          ([h, c]: [string | number, number]) => [Number(h), c] as [number, number],
        ),
      ),
    }
  } catch {
    return emptyStats()
  }
}

function saveStats(stats: StatsData): void {
  const file = getStatsFile()
  atomicWrite(
    file,
    JSON.stringify({
      sessionIds: stats.sessionIds,
      messagesByDay: Array.from(stats.messagesByDay.entries()),
      tokensByDay: Array.from(stats.tokensByDay.entries()),
      modelCounts: Object.fromEntries(stats.modelCounts),
      messagesByHour: Array.from(stats.messagesByHour.entries()),
    }),
  )
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

/**
 * Tool results arrive as either a plain string or Anthropic content blocks.
 * The contract's `tool_result` block is a string, so flatten here rather than
 * letting `[object Object]` reach the pane.
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

function saveSessionHistory(id: string, messages: ChatMessage[]): void {
  const file = join(getSessionDir(id), 'history.json')
  atomicWrite(file, JSON.stringify(messages, null, 2))
}

// ================================================================ Stats calculation

function computeStats(range: 'all' | '30d' | '7d', stats: StatsData): Stats {
  const now = Date.now()
  // `all` cannot go through `new Date(now - Infinity)` — that is an invalid
  // date and `.toISOString()` on it throws RangeError, which took the whole
  // stats call down whenever the All tab was selected. Empty string sorts
  // below every YYYY-MM-DD key, which is exactly "no cutoff".
  const cutoffStr =
    range === 'all'
      ? ''
      : new Date(now - (range === '30d' ? 30 : 7) * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const filtered = Array.from(stats.messagesByDay.entries()).filter(([d]) => d >= cutoffStr)

  const heatmapMap = new Map<string, number>()
  let totalMessages = 0
  let totalTokens = 0
  let activeDays = 0
  for (const [day, count] of filtered) {
    heatmapMap.set(day, count)
    totalMessages += count
    activeDays += count > 0 ? 1 : 0
  }

  const tokenData = Array.from(stats.tokensByDay.entries()).filter(([d]) => d >= cutoffStr)
  for (const [, tokens] of tokenData) {
    totalTokens += tokens
  }

  // ponytail: simple streak calculation, recomputed on each query. upgrade to incremental if stats queries become frequent.
  let currentStreak = 0
  let longestStreak = 0
  let tempStreak = 0
  const sortedDays = Array.from(heatmapMap.keys()).sort()
  let prevDate: Date | null = null
  for (const dayStr of sortedDays) {
    const date = new Date(dayStr)
    if (!prevDate) {
      tempStreak = 1
    } else {
      const dayDiff = (date.getTime() - prevDate.getTime()) / (24 * 60 * 60 * 1000)
      if (dayDiff === 1) {
        tempStreak++
      } else {
        longestStreak = Math.max(longestStreak, tempStreak)
        tempStreak = 1
      }
    }
    prevDate = date
  }
  if (prevDate && (now - prevDate.getTime()) < 24 * 60 * 60 * 1000) {
    currentStreak = tempStreak
  }
  longestStreak = Math.max(longestStreak, tempStreak)

  // Build the heatmap grid, one cell per day, oldest first. The window follows
  // the selected range: a grid showing 90 days under a "7d" toggle is a chart
  // that disagrees with its own label.
  //
  // Stepped in whole UTC days rather than `setDate()` so a DST boundary cannot
  // duplicate or skip a cell — the day keys are UTC (`toISOString`), so the
  // walk has to be UTC too.
  const DAY = 24 * 60 * 60 * 1000
  const windowDays = range === '7d' ? 7 : range === '30d' ? 30 : 365
  const heatmap: Stats['heatmap'] = []
  let cursor = Math.floor((now - (windowDays - 1) * DAY) / DAY) * DAY
  const lastDay = Math.floor(now / DAY) * DAY
  while (cursor <= lastDay) {
    const cellDateStr = new Date(cursor).toISOString().split('T')[0]
    heatmap.push({ date: cellDateStr, count: heatmapMap.get(cellDateStr) ?? 0 })
    cursor += DAY
  }

  // Peak hour: the local hour of day with the most messages. `null` when we have
  // no data — the contract allows null precisely so this tile never has to invent
  // a number. Do not substitute a placeholder here; a fabricated statistic on
  // screen is worse than an empty one.
  //
  // ponytail: hour buckets are lifetime, not range-filtered — a per-(day,hour)
  // key would be the fix if the range toggle needs to move this number.
  const peakHour =
    stats.messagesByHour.size > 0
      ? [...stats.messagesByHour.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : null

  // Favorite model
  let favoriteModel: string | null = null
  if (stats.modelCounts.size > 0) {
    favoriteModel = [...stats.modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }

  return {
    range,
    sessions: stats.sessionIds.length,
    messages: totalMessages,
    totalTokens,
    activeDays,
    currentStreak,
    longestStreak,
    peakHour,
    favoriteModel,
    heatmap,
  }
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

let stats: StatsData | null = null

/**
 * In-flight SDK queries, keyed by our session id. Held so `claude:interrupt`
 * can actually stop the run instead of only relabelling the status dot.
 */
const running = new Map<string, Query>()

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
  handle(CH.claudeSessions, () => {
    const sessions = getSessions()
    return sessions
  })

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

    // The sessions tile counts what this list holds. Nothing was writing to it,
    // so the tile read a confident 0 forever.
    if (!stats) stats = loadStats()
    if (!stats.sessionIds.includes(id)) {
      stats.sessionIds.push(id)
      saveStats(stats)
    }
    return session
  })

  handle(CH.claudeSend, async (id: string, text: string) => {
    const sessions = getSessions()
    const session = sessions.find((s) => s.id === id)
    if (!session) throw new Error(`Session ${id} not found`)

    if (running.has(id)) throw new Error(`Session ${id} is already running`)

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

    /** Messages appended during THIS turn — what the stats counters want. */
    let addedThisTurn = 1

    try {
      const run = query({
        prompt: text,
        options: {
          // `cwd` is the whole of project scoping. Without it every session ran
          // in the Electron app's own working directory regardless of which
          // project the row in the sidebar claimed to be bound to.
          cwd: session.cwd,
          // `tools` restricts what exists. `allowedTools` was used here before
          // and does the opposite of what the comment claimed: per the SDK it
          // is the AUTO-APPROVE list, so Read/Glob/Grep executed without ever
          // reaching canUseTool, while every other tool stayed available.
          tools: ['Read', 'Glob', 'Grep'],
          permissionMode: toSdkPermissionMode(session.permissionMode),
          // The SDK refuses 'bypassPermissions' unless this is set — the mode
          // was previously reachable from the UI and simply errored the run.
          allowDangerouslySkipPermissions: session.permissionMode === 'bypass',
          // Continue the same SDK conversation across turns. Absent this the
          // agent re-met the user on every send.
          resume: session.sdkSessionId,
          canUseTool: async (toolName, input, _options) => {
            // The ONE consent surface: pane 3. No prompt path exists here.
            setStatus('awaiting-permission')
            try {
              const allow = await requestConsent({
                title: `Allow ${toolName}`,
                detail: `The agent wants to ${toolName} with these arguments: ${JSON.stringify(input)}`,
                severity: 'info',
              })
              return allow
                ? { behavior: 'allow', updatedInput: input }
                : { behavior: 'deny', message: 'User denied' }
            } finally {
              // Never leave the dot stuck on "awaiting-permission" — including
              // when requestConsent rejects.
              if (session.status === 'awaiting-permission') setStatus('running')
            }
          },
        },
      })
      running.set(id, run)

      for await (const sdkMsg of run) {
        // Remember the SDK's own session id so the next turn can resume it.
        if ('session_id' in sdkMsg && sdkMsg.session_id) {
          session.sdkSessionId = sdkMsg.session_id
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
              blocks.push({ kind: 'tool_use', id: anyBlock.id, name: anyBlock.name, input: anyBlock.input })
            }
          }
          if (blocks.length > 0) {
            const msg: ChatMessage = {
              id: randomUUID(),
              role: 'assistant',
              blocks,
              at: Date.now(),
            }
            history.push(msg)
            addedThisTurn++
            pushMessage(id, msg)
          }
        }

        // Tool results arrive as SDK `user` messages. The contract has a
        // `tool_result` block and the renderer draws it; nothing was ever
        // emitting one, so every tool call showed a call with no outcome.
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
            if (blocks.length > 0) {
              const msg: ChatMessage = { id: randomUUID(), role: 'user', blocks, at: Date.now() }
              history.push(msg)
              addedThisTurn++
              pushMessage(id, msg)
            }
          }
        }

        if (sdkMsg.type === 'result') {
          setStatus(sdkMsg.subtype === 'success' ? 'idle' : 'error')

          if (!stats) stats = loadStats()
          const today = new Date().toISOString().split('T')[0]
          // Count messages ADDED this turn. This used to add `history.length`,
          // i.e. the whole transcript again on every send, so the messages tile
          // grew quadratically and reported a number that was never real.
          stats.messagesByDay.set(today, (stats.messagesByDay.get(today) ?? 0) + addedThisTurn)
          // Local hour, not UTC — "peak hour" means the user's day, not the server's.
          const hour = new Date().getHours()
          stats.messagesByHour.set(hour, (stats.messagesByHour.get(hour) ?? 0) + addedThisTurn)

          // Tokens and models were never written, so the tiles showed a
          // confident "0" and "—" that meant "we never looked". The SDK reports
          // both on the result message.
          let turnTokens = 0
          for (const [model, use] of Object.entries(sdkMsg.modelUsage ?? {})) {
            turnTokens += (use?.inputTokens ?? 0) + (use?.outputTokens ?? 0)
            stats.modelCounts.set(model, (stats.modelCounts.get(model) ?? 0) + 1)
          }
          if (turnTokens === 0 && sdkMsg.usage) {
            turnTokens = (sdkMsg.usage.input_tokens ?? 0) + (sdkMsg.usage.output_tokens ?? 0)
          }
          stats.tokensByDay.set(today, (stats.tokensByDay.get(today) ?? 0) + turnTokens)
          saveStats(stats)
        }
      }
    } catch (err) {
      setStatus('error')
      throw err
    } finally {
      running.delete(id)
      // A run that ends without a `result` message — transport death, an
      // interrupt, an abort — must not leave the session pinned on 'running'
      // forever. And the transcript is written here so a mid-run failure does
      // not discard everything the agent already said.
      if (session.status === 'running' || session.status === 'awaiting-permission') {
        setStatus('idle')
      }
      saveSessionHistory(id, history)
    }
  })

  handle(CH.claudeInterrupt, async (id: string) => {
    const sessions = getSessions()
    const session = sessions.find((s) => s.id === id)
    if (!session) return

    // Actually stop the run. Flipping the status alone left the SDK query
    // streaming in the background: tools kept executing and the next `result`
    // message overwrote the status back again.
    const run = running.get(id)
    if (run) {
      try {
        await run.interrupt()
      } catch {
        // Interrupt is best-effort; the finally block in send() still settles
        // the status either way.
      }
    }

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

  handle(CH.claudeStats, async (range: Stats['range']) => {
    if (!stats) stats = loadStats()
    return computeStats(range, stats)
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
