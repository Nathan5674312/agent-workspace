/**
 * WHAT AN AGENT ACTUALLY DID, FROM A RECORD IT DOES NOT WRITE.
 *
 * The first design for showing agent activity had the agent announce itself
 * into a log. That was wrong for one reason and it is the reason that matters:
 * anything the agent writes about itself, the agent can omit. An activity
 * display built on self-report is a display of what an agent chose to admit.
 *
 * Claude Code already keeps a better record. Every session appends JSONL to
 * `<config>/projects/<slugified-cwd>/<session-id>.jsonl`, one line per message,
 * and the tool calls are in there with their full inputs. THE HARNESS WRITES
 * THAT FILE, not the model. So the guarantee is not "the agent is honest", it is
 * COMPLETENESS: a model cannot call Read without the call appearing. It could
 * read a decoy, but it cannot read anything at all invisibly.
 *
 * That is a genuinely different property and it is the whole reason this module
 * exists instead of the announce-yourself protocol.
 *
 * TWO RULES ABOUT WHAT IS READ, AND THEY ARE PRIVACY BOUNDARIES RATHER THAN
 * TIDINESS.
 *
 *   1. TOOL METADATA ONLY. Never message text, never thinking, never tool
 *      RESULTS. A transcript holds entire conversations — everything the person
 *      typed and everything that came back. An activity popup needs to know a
 *      file was read; it does not need the file's contents, and a surface that
 *      renders them turns a status indicator into a window onto every private
 *      thing in the session.
 *
 *   2. A SHELL COMMAND IS REDUCED TO ITS PROGRAM AND SUBCOMMAND, and stops at
 *      the first flag. `git commit`, `npm test`, `node`. Never the full command
 *      line, because arguments carry tokens, keys and URLs, and a display that
 *      shows them will eventually show one over somebody's shoulder or into a
 *      screen recording.
 *
 * Note what is NOT used: Bash's `description` field. It reads well and it is
 * written by the model, which puts it straight back in the category this module
 * was built to escape.
 *
 * Pure. No filesystem: it turns lines into events, and whoever owns the file
 * handle does the tailing. Transcripts reach tens of megabytes — 44 MB for one
 * session on this machine — so a caller must read from a saved offset and never
 * parse the whole file.
 */

/** What a tool call amounts to, in the smallest vocabulary that stays useful. */
export type Action = 'read' | 'write' | 'search' | 'run' | 'other'

export type Activity = {
  /** Epoch ms, from the transcript line. */
  at: number
  /**
   * Who did it, and this is NOT simply the session id.
   *
   * A subagent writes its own transcript but inherits its PARENT's `sessionId`,
   * so grouping on that collapses every subagent of one session into a single
   * row. Four agents launched at once appeared as one, which was found by
   * running four and looking, not by reading the code. `agentId` is present on
   * subagent lines and is the real identity; `sessionId` is the fallback for a
   * top-level session, which has no `agentId`.
   */
  session: string
  /** The parent session, when this is a subagent. Absent at top level. */
  parent?: string
  /**
   * The harness's own readable name for the session, like
   * "humble-squishing-emerson". Far better to put on screen than a UUID, and it
   * costs nothing because it is already in the file.
   */
  label?: string
  /** The working directory that session was launched in. */
  cwd: string
  /**
   * Which Claude Code installation this came from: the config directory's own
   * name, like `.claude` or `.claude-nathanielyoungal`.
   *
   * Stamped by `parseLines` from the path the transcript was found at, because
   * it is not written inside the file. Absent when the caller did not say.
   */
  source?: string
  /** The tool's own name, kept verbatim so an unknown one is still reportable. */
  tool: string
  action: Action
  /** The path the tool named, absolute, as the tool gave it. */
  path?: string
  /**
   * A short descriptor safe to put on screen: a glob, a program and
   * subcommand, a URL's host. Never a full command line, never file contents.
   */
  detail?: string
}

/**
 * Which tools mean what.
 *
 * An unrecognised tool is `other` rather than dropped. A new tool appearing in a
 * future version should show up as activity the app cannot describe, not as
 * silence — silence would read as "the agent did nothing", which is the one
 * thing this module must never say incorrectly.
 */
const ACTIONS: Record<string, Action> = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  Bash: 'run',
  PowerShell: 'run',
}

/**
 * First token, plus the second ONLY when it actually looks like a subcommand.
 *
 * "not a flag" was the first rule here and it was wrong, caught by running this
 * over a real transcript: `cd "C:/Users/Nathan/AppData/.../scratchpad"` came
 * back with the whole path attached, because a quoted path is not a flag. That
 * is both a leak — a filesystem layout on screen — and useless, since nobody
 * needs to read a directory to know the agent changed directory.
 *
 * So a subcommand must LOOK like one: a bare lowercase word. That admits
 * `git commit`, `npm test` and `cargo build`, and excludes paths, quoted
 * strings, flags, URLs, variables and anything else an argument can be.
 */
function programOf(command: string): string {
  // `cd "<somewhere>" && <the actual work>` is how agents open almost every
  // shell call, so reporting the first program reduced a third of all activity
  // to the word "cd". The interesting program is the last one in the chain.
  // Splitting on the separators rather than parsing a shell grammar is enough
  // here, because the output is one token either way.
  const segments = command.split(/&&|\|\||;|\|/)
  const tail = segments[segments.length - 1]?.trim()
  const chosen = tail && tail !== '' ? tail : command
  const parts = chosen.trim().split(/\s+/)
  const program = (parts[0] ?? '').split(/[\\/]/).pop() ?? ''
  const next = parts[1] ?? ''
  return /^[a-z][a-z0-9:_-]*$/.test(next) ? `${program} ${next}` : program
}

/** A URL's host only. A full URL can carry a token in its query string. */
function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url.trim())
  return m ? m[1] : ''
}

/**
 * The safe descriptor for one tool call.
 *
 * Everything not explicitly handled returns undefined rather than falling back
 * to stringifying the input. A default that prints unknown inputs would leak the
 * first time a tool with a sensitive argument appeared, and it would do it
 * silently, which is exactly how this kind of boundary fails.
 */
function detailOf(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const c = input.command
    return typeof c === 'string' && c !== '' ? programOf(c) : undefined
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const p = input.pattern
    return typeof p === 'string' ? p.slice(0, 60) : undefined
  }
  if (tool === 'WebFetch') {
    const u = input.url
    return typeof u === 'string' ? hostOf(u) : undefined
  }
  if (tool === 'WebSearch') {
    const q = input.query
    return typeof q === 'string' ? q.slice(0, 60) : undefined
  }
  return undefined
}

/**
 * Every tool call on one transcript line.
 *
 * Returns `[]` for anything it cannot read, including malformed JSON, and never
 * throws. A transcript is appended to while this runs, so the LAST line is
 * routinely a half-written one — a parser that threw there would fail every
 * time it caught up with a working agent, which is precisely when it is needed.
 */
export function parseLine(raw: string): Activity[] {
  let line: Record<string, unknown>
  try {
    line = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return []
  }
  if (!line || typeof line !== 'object') return []

  const msg = line.message as { content?: unknown } | undefined
  const content = msg?.content
  if (!Array.isArray(content)) return []

  const at = Date.parse(String(line.timestamp ?? ''))
  const sessionId = typeof line.sessionId === 'string' ? line.sessionId : ''
  const agentId = typeof line.agentId === 'string' ? line.agentId : ''
  // The subagent's own id wins. See the note on `Activity.session`.
  const session = agentId || sessionId
  const cwd = typeof line.cwd === 'string' ? line.cwd : ''
  const slug = typeof line.slug === 'string' ? line.slug : ''

  const out: Activity[] = []
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown; input?: unknown }
    if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue

    const input = (b.input ?? {}) as Record<string, unknown>
    const a: Activity = {
      at: Number.isFinite(at) ? at : 0,
      session,
      cwd,
      tool: b.name,
      action: ACTIONS[b.name] ?? 'other',
    }
    if (agentId && sessionId) a.parent = sessionId
    if (slug) a.label = slug
    // Several tools name their target differently, and the alternatives are
    // listed rather than guessed so an unknown key yields no path instead of
    // some other string that happens to sit in the input.
    for (const key of ['file_path', 'path', 'notebook_path'] as const) {
      const v = input[key]
      if (typeof v === 'string' && v !== '') {
        a.path = v
        break
      }
    }
    const detail = detailOf(b.name, input)
    if (detail) a.detail = detail
    out.push(a)
  }
  return out
}

/**
 * Every tool call across many lines, oldest first.
 *
 * `source` names the INSTALLATION the lines came from, and it is a parameter
 * rather than something parsed out because it is not in the file — it is the
 * config directory the transcript was found under, which only the caller
 * holding the path knows.
 *
 * It matters here more than it would on most machines. `activity.ts` scans
 * `~/.claude` and every `~/.claude-*`, because this machine deliberately runs
 * two Claude Code accounts with two config directories. Without this field both
 * arrive as an undifferentiated list of agents, and the single most useful
 * question a person watching can ask — which of my two installations is doing
 * that — has no answer on screen.
 */
export function parseLines(lines: string[], source?: string): Activity[] {
  const out = lines.flatMap(parseLine)
  if (source !== undefined && source !== '') for (const a of out) a.source = source
  return out
}

/**
 * A path relative to a root, or null if it is outside it.
 *
 * Windows backslashes are normalised and the comparison is case-insensitive,
 * because a transcript records `C:\Users\...` while the vault is addressed with
 * forward slashes, and Windows treats the two casings as one file. Getting this
 * wrong shows every vault read as happening somewhere else.
 *
 * The separator on the prefix is required, so `/vault-backup/x.md` is not
 * treated as living inside `/vault`.
 */
export function relativeTo(path: string, root: string): string | null {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path)
  const r = norm(root)
  const lp = p.toLowerCase()
  const lr = r.toLowerCase()
  if (lp === lr) return ''
  if (!lp.startsWith(`${lr}/`)) return null
  return p.slice(r.length + 1)
}

/**
 * The shortest rendering of a path that still says WHERE.
 *
 * THE BUG THIS FIXES, because it is a good example of one fix quietly undoing
 * another. `describe` has always taken a `root`, and used it to compute a
 * relative path — and then threw that away, because the next line reduced
 * whatever it had to a bare filename:
 *
 *     const name = shown.split(/[\\/]/).pop()
 *
 * That line was itself a fix, for a real defect: the panel was rendering
 * `C:\Users\Nathan\...\Note.md` in full, three wrapped lines per card. Clamping
 * to the basename cured the symptom and made the `root` parameter dead code —
 * every caller passing a root got exactly what a caller passing none got. The
 * only caller stopped passing one, which is how it went unnoticed.
 *
 * Both requirements are real and they are not in conflict once separated:
 * a path must be SHORT, and it must say more than a filename. `guides.ts` does
 * not tell you which of four files with that name is being written; the full
 * absolute path does, at the cost of the layout.
 *
 * So: relative to the agent's own working directory when it is inside it, which
 * is short AND located — `src/shared/guides.ts`. Outside it, the last few
 * segments behind an ellipsis, so a file somewhere else is still placed without
 * unrolling somebody's home directory across the screen.
 *
 * `segments` is how many of those tail segments to keep. Two for a file, which
 * is enough to say which folder it is in. The activity panel passes three for a
 * WORKING DIRECTORY, where the extra one is what separates two checkouts of the
 * same repo — and it calls this rather than owning a second copy of the rule,
 * because the last time the view held its own path arithmetic the tests could
 * only grep for it.
 */
export function where(path: string, root?: string, segments = 2): string {
  const rel = root ? relativeTo(path, root) : null
  // '' means the path IS the root — a tool called on the directory itself.
  if (rel !== null && rel !== '') return rel
  // Split on BOTH separators. A transcript records `C:\Users\...\Note.md`, and
  // splitting on `/` alone leaves that whole string intact — which is precisely
  // how the full-path-on-screen defect happened.
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return parts.join('/') || path
  return `…/${parts.slice(-segments).join('/')}`
}

/** Only what happened at or after `t`. For tailing without re-reporting. */
export function since(items: Activity[], t: number): Activity[] {
  return items.filter((a) => a.at >= t)
}

/**
 * The current state of each session: what it last touched, and how busy it is.
 *
 * `recent` is capped deliberately. An agent performs dozens of calls a minute
 * and a display that lists them all is a firehose nobody reads — the useful
 * question is "what is it on right now", not "everything it has ever done".
 */
export type SessionState = {
  session: string
  /** The readable name, when the transcript carried one. */
  label?: string
  /** Set when this is a subagent of another session. */
  parent?: string
  /** Which installation it belongs to. See `Activity.source`. */
  source?: string
  cwd: string
  /** The most recent call. What to put on the first line. */
  last: Activity
  /** Most recent first, newest `limit` only. */
  recent: Activity[]
  /** How many calls in total were seen for this session. */
  count: number
}

export function sessions(items: Activity[], limit = 5): SessionState[] {
  const by = new Map<string, Activity[]>()
  for (const a of items) {
    const list = by.get(a.session)
    if (list) list.push(a)
    else by.set(a.session, [a])
  }

  const out: SessionState[] = []
  for (const [session, list] of by) {
    const ordered = [...list].sort((x, y) => y.at - x.at)
    const state: SessionState = {
      session,
      cwd: ordered[0].cwd,
      last: ordered[0],
      recent: ordered.slice(0, limit),
      count: ordered.length,
    }
    // Taken from whichever line carried them rather than from the newest, since
    // an attachment line can carry the slug while the tool call next to it does
    // not, and a name that flickers is worse than no name.
    const named = ordered.find((a) => a.label)
    if (named?.label) state.label = named.label
    const child = ordered.find((a) => a.parent)
    if (child?.parent) state.parent = child.parent
    const from = ordered.find((a) => a.source)
    if (from?.source) state.source = from.source
    out.push(state)
  }
  // Busiest-most-recent first: whoever moved last is who a person looking at
  // the screen right now is most likely asking about.
  return out.sort((a, b) => b.last.at - a.last.at)
}

/**
 * One line a person can read, for one session.
 *
 * Says the thing, not the category. "reading 07 - Agents.md" rather than "1 file
 * operation", for the same reason a notification says the question instead of
 * announcing that a question exists.
 */
export function describe(a: Activity, root?: string): string {
  const name = a.path ? where(a.path, root) : undefined
  switch (a.action) {
    case 'read':
      return name ? `reading ${name}` : 'reading'
    case 'write':
      return name ? `editing ${name}` : 'editing'
    case 'search':
      return a.detail ? `searching for ${a.detail}` : 'searching'
    case 'run':
      return a.detail ? `running ${a.detail}` : 'running a command'
    default:
      return a.tool
  }
}
