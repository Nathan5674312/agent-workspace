/**
 * AGENT ACTIVITY, TAILED OUT OF TRANSCRIPTS NOBODY HAD TO OPT INTO.
 *
 * Claude Code appends JSONL to `<config>/projects/<slugified-cwd>/<id>.jsonl`,
 * one line per message, and the tool calls are in it with their inputs. The
 * harness writes that file, not the model, so an agent cannot act invisibly —
 * it could read a decoy, but it cannot read nothing. That is why this reads
 * transcripts rather than asking agents to announce themselves: a self-reported
 * log shows what an agent chose to admit.
 *
 * Parsing lives in `shared/transcript.ts`, which is pure and enforces the two
 * privacy boundaries (tool metadata only, and shell commands reduced to a
 * program). This file is the part that must touch the disk, and everything here
 * is about doing that without being expensive.
 *
 * THREE THINGS THAT WOULD MAKE THIS UNUSABLE IF DONE NAIVELY.
 *
 *   Transcripts are big. One session on this machine is 44 MB. Reading a file
 *   to find out what changed at the end of it is not viable at any interval, so
 *   every file is read FROM A SAVED BYTE OFFSET and only the new tail is parsed.
 *
 *   There are hundreds of them. Sessions accumulate for months. Only files
 *   touched inside `RECENT_MS` are looked at, so a machine with a year of
 *   history costs the same as a fresh one.
 *
 *   There is more than one agent, on more than one account. This machine has
 *   `.claude` and `.claude-nathanielyoungal`, deliberately, and both are
 *   scanned. Watching one would show half the picture and give no sign that the
 *   other half existed.
 *
 * POLLING, NOT `fs.watch`. Watching directories recursively is
 * platform-dependent and drops events under load, and the failure mode is a
 * display that quietly stops updating — indistinguishable from an idle agent,
 * which is the one thing this must never be wrong about. A `stat` on a handful
 * of recent files every couple of seconds is cheap and cannot silently miss.
 */
import { BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { EV, type Activity } from '../shared/ipc.js'
import { parseLines } from '../shared/transcript.js'

/** How far back a transcript counts as live. */
const RECENT_MS = 30 * 60 * 1000
/** How often to look. Fast enough to feel live, slow enough to be free. */
const POLL_MS = 1500
/** Never hand the renderer more than this in one push. */
const MAX_PUSH = 200
/**
 * Cap on the tail read in one poll. A session resumed after a long gap can
 * append megabytes between two polls, and parsing all of it would stall the
 * main process — the window would freeze to report that an agent was busy.
 */
const MAX_TAIL = 2 * 1024 * 1024

/** Byte offset already consumed, per transcript path. */
const offsets = new Map<string, number>()
/**
 * Whether the first pass has run.
 *
 * This exists because of a bug that only showed up with the app open and agents
 * working. A file seen for the first time starts at its END, so that opening the
 * app narrates what is happening NOW instead of replaying a month of history.
 * That is right for files that already existed — and exactly wrong for one that
 * did not, because a transcript CREATED after startup is new from its first
 * byte. Four subagents launched into a running app therefore showed nothing at
 * all: each of their files was brand new, and every one was skipped as though it
 * were old history.
 *
 * So "first sighting" means two different things depending on when it happens,
 * and this flag is what tells them apart.
 */
let primed = false
let timer: NodeJS.Timeout | null = null

/**
 * Every Claude Code config directory belonging to this user.
 *
 * `~/.claude` plus any `~/.claude-*`, because the second account on this
 * machine lives at `.claude-nathanielyoungal` and hard-coding that name would
 * make this work here and nowhere else. `CLAUDE_CONFIG_DIR` is honoured first
 * since that is the documented override and the mechanism `hands.ps1` uses.
 */
function configDirs(): string[] {
  const found = new Set<string>()
  const env = process.env.CLAUDE_CONFIG_DIR
  if (env) found.add(env)
  const home = homedir()
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      if (e.name === '.claude' || e.name.startsWith('.claude-')) found.add(join(home, e.name))
    }
  } catch {
    /* an unreadable home directory is not this feature's problem */
  }
  return [...found]
}

/**
 * `cfg` is the config directory this transcript was found under, carried
 * because the walk is the only place that knows it — by the time a line is
 * parsed the path is gone, and two installations' agents are otherwise
 * indistinguishable on screen. See `Activity.source`.
 */
type Found = { path: string; mtime: number; size: number; cfg: string }

/**
 * Recently-written transcripts across every config directory.
 *
 * Walks `projects/<slug>/` one level, plus `<slug>/<id>/subagents/`, because a
 * subagent writes its own transcript and its work is exactly the activity a
 * person watching would want to see. Anything unreadable is skipped rather than
 * thrown — a permissions error on one stale session directory must not stop the
 * whole display.
 */
function recentTranscripts(now: number): Found[] {
  const out: Found[] = []
  const consider = (p: string, cfg: string): void => {
    try {
      const s = statSync(p)
      if (s.isFile() && now - s.mtimeMs < RECENT_MS) {
        out.push({ path: p, mtime: s.mtimeMs, size: s.size, cfg })
      }
    } catch {
      /* vanished between readdir and stat */
    }
  }

  for (const cfg of configDirs()) {
    const projects = join(cfg, 'projects')
    let slugs: string[]
    try {
      slugs = readdirSync(projects)
    } catch {
      continue
    }
    for (const slug of slugs) {
      const dir = join(projects, slug)
      let entries: import('node:fs').Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) consider(join(dir, e.name), cfg)
        else if (e.isDirectory()) {
          const subs = join(dir, e.name, 'subagents')
          try {
            for (const s of readdirSync(subs)) {
              if (s.endsWith('.jsonl')) consider(join(subs, s), cfg)
            }
          } catch {
            /* no subagents for this session */
          }
        }
      }
    }
  }
  return out
}

/**
 * The bytes appended since last time.
 *
 * A file that SHRANK was rotated or replaced, and the stored offset now points
 * into the middle of different content. Resetting to the end rather than to zero
 * is deliberate: re-reading a rotated 44 MB file from the start would flood the
 * display with a replay of everything that already happened.
 *
 * A first sighting also starts at the end. Opening the app should show what
 * agents are doing NOW, not narrate the last month.
 */
function readTail(f: Found): string {
  const seen = offsets.get(f.path)
  // A file we have never seen. Before the first pass that means "already
  // existed", and starting at the end is what stops the app replaying a month
  // of history on open. AFTER the first pass it means the file was CREATED
  // while we were watching — a subagent that just started — and every byte of
  // it is new, so it is read from the beginning.
  if (seen === undefined) {
    offsets.set(f.path, primed ? 0 : f.size)
    if (!primed) return ''
  } else if (seen > f.size) {
    // Shrank: rotated or replaced, and the offset now points into different
    // content. Resume at the end rather than at zero, so a rotated 44 MB file
    // does not flood the display with a replay.
    offsets.set(f.path, f.size)
    return ''
  }
  const from0 = offsets.get(f.path)!
  if (from0 === f.size) return ''

  const from = Math.max(from0, f.size - MAX_TAIL)
  const length = f.size - from
  let fd: number | null = null
  try {
    fd = openSync(f.path, 'r')
    const buf = Buffer.allocUnsafe(length)
    const n = readSync(fd, buf, 0, length, from)
    offsets.set(f.path, f.size)
    return buf.toString('utf8', 0, n)
  } catch {
    // Locked, deleted, or being written. Leave the offset alone and try again
    // on the next poll rather than losing our place in the file.
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * One pass. Exported so a test can drive it without a timer.
 *
 * The last line of a growing file is routinely half-written; `parseLines`
 * returns nothing for it rather than throwing, and the remainder arrives whole
 * on the next poll because the offset only advances to the file size we read.
 */
export function poll(now: number = Date.now()): Activity[] {
  const out: Activity[] = []
  const wasPrimed = primed
  for (const f of recentTranscripts(now)) {
    const tail = readTail(f)
    if (tail === '') continue
    // The config directory's own name, not its full path: `.claude` or
    // `.claude-nathanielyoungal`. The rest is the user's home directory, which
    // is identical for every installation and so distinguishes nothing.
    const source = f.cfg.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? f.cfg
    out.push(...parseLines(tail.split('\n').filter(Boolean), source))
  }
  primed = true
  // The priming pass reports nothing by definition: it exists to record where
  // every existing file ends, not to narrate what already happened.
  if (!wasPrimed) return []
  out.sort((a, b) => a.at - b.at)
  return out.length > MAX_PUSH ? out.slice(-MAX_PUSH) : out
}

/**
 * Broadcast to every live window, not the focused one.
 *
 * Same reasoning as the consent corner: while an agent is working, the normal
 * state is that no window has focus. `isDestroyed()` is checked because a window
 * closing between the list and the send throws, and an unhandled throw on a
 * 1.5-second timer takes the main process down.
 */
function push(items: Activity[]): void {
  if (items.length === 0) return
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send(EV.agentActivity, items)
    } catch {
      /* the window went away mid-send */
    }
  }
}

/** Begin watching. Idempotent. */
export function start(): void {
  if (timer) return
  // Prime the offsets so the first push is new activity, not a backlog.
  poll()
  timer = setInterval(() => {
    try {
      push(poll())
    } catch {
      // A failure here must never stop the loop: the display going quiet is
      // indistinguishable from every agent being idle.
    }
  }, POLL_MS)
  timer.unref?.()
}

export function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** For a window that just opened: everything from the last few minutes. */
export function current(): Activity[] {
  return poll()
}

/** Test seam. */
export function _resetForTest(): void {
  offsets.clear()
  primed = false
}
