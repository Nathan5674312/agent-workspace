/**
 * FATE AS AN MCP SERVER, FOR THE AGENTS THAT LIVE OUTSIDE THE APP.
 *
 * The in-app agent is one agent. The ones people already use every day —
 * Claude Code in a terminal, Codex, Cursor — never saw the vault's ranking, its
 * graph or its boards, and a board run by hand-reading the JSON is a board two
 * agents can disagree about. This exposes the SAME code the app runs: vault.ts's
 * walk, skips and search, the graph's links, and pipeline.ts / run.ts for "what
 * happens next". The app, an outside agent and the test get one answer, which
 * is why those modules were written pure in the first place.
 *
 * Launched by the agent over stdio, one process per agent session:
 *
 *   claude mcp add fate -- node <repo>/out/main/mcp.js "<vault dir>"
 *
 * WHAT IT WRITES, and why that list is short: a board's run file (derived,
 * hidden, beside the board, the same format the run-a-board skill writes) and a
 * NEW board, never an existing one. Notes are not written here at all. An
 * outside agent has its own Write tool behind its own permission prompts, and a
 * second note writer that skipped vault.ts's consent gate and backups would be
 * a worse copy of a feature the app already has.
 *
 * ponytail: hand-rolled JSON-RPC, tools only. No resources, prompts or
 * sampling, and the client's protocol version is echoed back because a
 * tools-only server is identical on every version so far. Reach for
 * @modelcontextprotocol/sdk when any of that is needed.
 */
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as vault from './vault.js'
import { canvasId, isCanvasPath, parseCanvas, serializeCanvas, type CanvasDoc } from '../shared/canvas.js'
import { compile, type Plan, type Step } from '../shared/pipeline.js'
import * as runs from '../shared/run.js'
import { terms } from '../shared/retrieve.js'
import { searchText, titleMatches } from '../shared/search.js'
import { setFrontmatter } from '../shared/notemeta.js'
import { ROADMAP } from '../shared/roadmap.js'
import { controlFile, VIEWS, type AgentView, type ControlInfo } from '../shared/control.js'
import type { BoardStamp } from '../shared/brief.js'
import type { Actor, VaultTreeNode } from '../shared/ipc.js'

if (process.argv[2]) vault.setVaultDir(resolve(process.argv[2]))

/** How long a claim lasts without another record. Longer than a step, shorter than a dead agent should hold a board. */
const LEASE_MS = 30 * 60 * 1000

type Args = Record<string, unknown>

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return v
}

/** Agents send Windows separators as often as not; the vault's canonical form is forward slashes. */
const rel = (p: unknown, name: string): string => str(p, name).replace(/\\/g, '/')

// ------------------------------------------------------------------ writing, and what it must rest on

/** Who is writing, from the client's own `initialize`. "claude-code", "cursor", ... */
let agentName = 'an outside agent'

/**
 * The bar every write clears: NO prompt, but no write without evidence.
 *
 * The vault's own pilot caught the failure this exists for: an agent saved its
 * GUESS at a rule as a note, and the next session would have trusted it. So a
 * write names what it rests on — the user's words, a command's output, a file —
 * and that lands in System/agent-writes.jsonl beside the change, where a person
 * can check it. Writing what you inferred is exactly what this field refuses.
 */
const EVIDENCE = {
  type: 'string',
  description:
    'Required. What this change rests on: the user\'s own words (quote them), a command\'s output, or a file you read. Not your own inference. Only verified, credible information goes into the vault.',
}

const actor = (evidence: unknown): Actor & { kind: 'external' } => ({
  kind: 'external',
  agent: agentName,
  evidence: str(evidence, 'evidence'),
})

/** A note an agent may write: Markdown, inside the vault, nowhere the explorer hides (.git, .obsidian, .trash). */
function notePath(p: unknown, name = 'path'): string {
  const path = rel(p, name)
  if (!/\.md$/i.test(path)) throw new Error(`${name} must be a Markdown note ending .md. Boards have their own tools.`)
  vault.requireVisible(vault.resolveInVault(path))
  return path
}

function logWrite(op: string, paths: string[], evidence: string): void {
  try {
    const dir = resolve(vault.getVaultDir(), 'System')
    mkdirSync(dir, { recursive: true })
    const line = { at: new Date().toISOString(), agent: agentName, op, paths, evidence }
    appendFileSync(join(dir, 'agent-writes.jsonl'), `${JSON.stringify(line)}\n`)
  } catch {
    // The write itself already landed. A log that will not append must not
    // make the agent believe it failed and try again.
  }
}

/** The overwrite guard's refusal, said so an agent knows the next move. */
function saveError(e: unknown, path: string): Error {
  if (e instanceof Error && e.name === 'SaveConflict') {
    return new Error(`${path} exists or changed since you read it. read_note it again and pass that mtime, or pick a new path.`)
  }
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Knock on the running app (shared/control.ts). Null on success, else why not.
 * Never throws: an agent's write must not fail because the window is closed.
 */
async function tellApp(route: '/open' | '/changed', body: object): Promise<string | null> {
  let info: ControlInfo
  try {
    info = JSON.parse(readFileSync(controlFile(vault.getVaultDir()), 'utf8'))
    // A crash or a force-quit leaves the file behind, and its port may since
    // belong to some other program. Signal 0 only asks whether the app lives.
    process.kill(info.pid, 0)
  } catch {
    return 'Fate is not open on this vault, so there is no window to show it in.'
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fate-token': info.token },
      body: JSON.stringify({ ...body, vault: vault.getVaultDir() }),
      signal: AbortSignal.timeout(2000),
    })
    return res.ok ? null : await res.text()
  } catch {
    return 'Fate is not open on this vault, so there is no window to show it in.'
  }
}

/**
 * After any write. This process caches the graph like the app does, so a link
 * just written would be missing from note_links until the cache aged out; and
 * the open window re-reads the folder. The second half is fire and forget.
 */
const changed = (): void => {
  vault.invalidateGraph()
  void tellApp('/changed', {})
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]

/**
 * The links someone WROTE. The app's graph also carries `structure` edges that
 * tie unreachable notes to a root so the view can draw them; told "Plan.md
 * links to Board.canvas" because of one, an agent would be misled.
 */
const writtenLinks = async () => (await vault.graph()).links.filter((l) => l.kind !== 'structure')

// ------------------------------------------------------------------ boards

type Loaded = { board: string; plan: Plan; stamp: BoardStamp; run: runs.Run; begun: boolean; runFile: string }

function loadBoard(board: string): Loaded {
  if (!isCanvasPath(board)) throw new Error(`${board} is not a .canvas board`)
  const abs = vault.resolveInVault(board)
  if (!existsSync(abs)) throw new Error(`No board at ${board}. list_boards shows what exists.`)
  const st = statSync(abs)
  const stamp = { mtime: st.mtimeMs, size: st.size }
  const plan = compile(parseCanvas(readFileSync(abs, 'utf8')))
  const runFile = vault.resolveInVault(runs.runPath(board))
  const begun = existsSync(runFile)
  // A run file that exists but will not parse is REFUSED, not replaced: starting
  // over here would overwrite somebody's progress on the next record.
  const run: runs.Run = begun ? JSON.parse(readFileSync(runFile, 'utf8')) : runs.beginRun(board, stamp, Date.now())
  return { board, plan, stamp, run, begun, runFile }
}

const stale = (b: Loaded): boolean =>
  b.begun && (b.run.boardStamp?.mtime !== b.stamp.mtime || b.run.boardStamp?.size !== b.stamp.size)

const liveClaim = (run: runs.Run, now: number) => (run.claim && run.claim.until > now ? run.claim : undefined)

function stepLines(s: Step, run: runs.Run, plan: Plan): string[] {
  const out = [`- [${s.id}] ${s.text || s.file || s.url || '(no text)'}`]
  if (s.phase) out.push(`    phase: ${s.phase}`)
  if (s.file) out.push(`    material: ${s.file}${isCanvasPath(s.file) ? ' (a sub-pipeline: run it, or note it and move on)' : ' (read it before acting)'}`)
  if (s.url) out.push(`    link: ${s.url}`)
  for (const d of s.after) {
    const dep = run.steps[d]
    const label = s.conditions[d] ? ` only "${s.conditions[d]}"` : ''
    const said = dep?.output ? `: ${dep.output.slice(0, 300)}` : ''
    const name = plan.steps.find((x) => x.id === d)?.text.slice(0, 60) ?? d
    out.push(`    after [${d}] "${name}"${label} (${dep?.state ?? 'pending'}${said})`)
  }
  return out
}

/** What an agent needs to decide its next move, in words. */
function view(b: Loaded, run = b.run): string {
  const { plan } = b
  if (!plan.runnable) {
    return [`${b.board} is not a pipeline:`, ...plan.problems.map((p) => `- ${p.detail}`)].join('\n')
  }
  const now = Date.now()
  run = runs.settleUnreachable(plan, run, now)
  const p = runs.progress(plan, run)
  const lines = [
    `${b.board}: ${p.done}/${p.total} done, ${p.skipped} skipped, ${p.failed} failed, ${p.waiting} waiting on a person, ${p.left} left.`,
  ]
  if (stale(b)) lines.push('WARNING: the board was edited since this run began. Re-read the steps below before acting.')
  const claim = liveClaim(run, now)
  if (claim) lines.push(`Claimed by "${claim.by}" until ${new Date(claim.until).toISOString()}.`)

  const ready = runs.ready(plan, run)
  const going = plan.steps.filter((s) => runs.stateOf(run, s.id) === 'running')
  const waiting = runs.awaiting(plan, run)
  if (going.length) lines.push('', 'IN PROGRESS:', ...going.flatMap((s) => stepLines(s, run, plan)))
  if (ready.length) {
    lines.push('', 'READY NOW (when free to choose, take the first):', ...ready.flatMap((s) => stepLines(s, run, plan)))
  }
  if (waiting.length) {
    lines.push('', 'WAITING ON A PERSON:', ...waiting.map((s) => `- [${s.id}] ${run.steps[s.id]?.question ?? '(no question recorded)'}`))
  }
  if (runs.isComplete(plan, run)) lines.push('', 'The run is complete.')
  return lines.join('\n')
}

function boardsIn(n: VaultTreeNode, out: string[] = []): string[] {
  if (n.kind === 'canvas') out.push(n.path)
  n.children?.forEach((c) => boardsIn(c, out))
  return out
}

const STATES = ['running', 'done', 'skipped', 'failed', 'awaiting-human'] as const

/**
 * Lay a new board out left to right by depth. Deliberately plain: it has to be
 * legible when the user opens it, not beautiful, and cards get moved anyway.
 */
function layout(steps: { key: string; text?: string; file?: string }[], edges: { from: string; to: string; label?: string }[]): CanvasDoc {
  const id = new Map(steps.map((s) => [s.key, canvasId()]))
  const depth = new Map(steps.map((s) => [s.key, 0]))
  // Longest-path depth. Bounded passes, so a cycle terminates here and is then
  // reported by compile() rather than hanging the layout.
  for (let i = 0; i < steps.length; i++) {
    for (const e of edges) depth.set(e.to, Math.max(depth.get(e.to)!, depth.get(e.from)! + 1))
  }
  const rows = new Map<number, number>()
  return {
    nodes: steps.map((s) => {
      const d = Math.min(depth.get(s.key)!, steps.length)
      const row = rows.get(d) ?? 0
      rows.set(d, row + 1)
      const at = { id: id.get(s.key)!, x: d * 360, y: row * 160, width: 260, height: 120 }
      return s.file ? { ...at, type: 'file' as const, file: s.file } : { ...at, type: 'text' as const, text: s.text! }
    }),
    edges: edges.map((e) => ({
      id: canvasId(),
      fromNode: id.get(e.from)!,
      toNode: id.get(e.to)!,
      fromSide: 'right' as const,
      toSide: 'left' as const,
      ...(e.label ? { label: e.label } : {}),
    })),
  }
}

// ------------------------------------------------------------------ tools

type Tool = { name: string; description: string; inputSchema: object; run: (a: Args) => Promise<string> | string }

const TOOLS: Tool[] = [
  {
    name: 'search_vault',
    description:
      "Search the user's Fate vault (their notes, decisions, projects and past work). Two or more words are ranked by how strongly they appear, rare words counting most, so a whole question works and a note need not contain every word. One word finds every note containing it, names first. Returns matching lines with 1-based line numbers, plus each note's links and backlinks so you can follow the graph. Use this BEFORE answering anything about the user's projects, preferences or history.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or a whole question, e.g. "release procedure" or "why does my wifi keep dropping".' },
        limit: { type: 'number', description: 'Most notes to return. Default 8.' },
      },
      required: ['query'],
    },
    async run(a) {
      const query = str(a.query, 'query')
      const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 8
      // Two or more words: BM25 via vault.related(), which put a right note in
      // the top 5 for 14/14 held-out questions against 2/14 for the AND search
      // (fate-benchmark/retrieval). One word: the AND search, whose names-first
      // order is the right one for a single word.
      const ranked = new Set(terms(query)).size >= 2
      const paths = ranked
        ? await vault.related(query, limit)
        : (await vault.search(query)).slice(0, limit).map((n) => n.path)
      const found = (
        await Promise.all(
          paths.map(async (path) => {
            try {
              const { text, title } = await vault.read(path)
              return { path, titleMatch: titleMatches(title, query), ...searchText(text, query) }
            } catch {
              return null // gone between the ranking and the read
            }
          }),
        )
      ).filter((n) => n !== null)
      if (found.length === 0) return `Nothing in the vault matches "${query}". Try fewer or different words.`
      const links = await writtenLinks()
      const near = (pick: (l: { from: string; to: string }) => string | null) =>
        [...new Set(links.map(pick).filter((x): x is string => !!x))].slice(0, 6).join(', ')
      return [
        `Vault: ${vault.getVaultDir()} (paths below are relative to it). ${
          ranked ? 'Ranked by word weight; a note need not contain every word.' : 'Every note contains the word; names first.'
        }`,
        ...found.map((n) => {
          const out = near((l) => (l.from === n.path ? l.to : null))
          const back = near((l) => (l.to === n.path ? l.from : null))
          return [
            `## ${n.path}${n.titleMatch ? ' (name matches)' : ''}`,
            ...n.hits.map((h) => `  L${h.line + 1}: ${h.text}`),
            n.truncated ? `  +${n.truncated} more matching lines` : '',
            out ? `  links to: ${out}` : '',
            back ? `  linked from: ${back}` : '',
          ].filter(Boolean).join('\n')
        }),
      ].join('\n\n')
    },
  },
  {
    name: 'list_boards',
    description:
      'List every board (.canvas pipeline) in the vault with its size and run progress. A board is a runnable plan the user drew: cards are steps, arrows are order. Check here when a task sounds repeatable, before doing it freehand.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const paths = boardsIn(await vault.tree())
      if (paths.length === 0) return 'No boards in this vault yet. create_board makes one.'
      return paths
        .map((p) => {
          try {
            const b = loadBoard(p)
            if (!b.plan.runnable) return `- ${p}: not a pipeline (${b.plan.problems[0]?.detail ?? 'no steps'})`
            const pr = runs.progress(b.plan, runs.settleUnreachable(b.plan, b.run, Date.now()))
            const where = b.begun ? `${pr.done} done, ${pr.left} left` : 'never run'
            const first = b.plan.steps[0]
            const starts = (first.text || first.file || first.url || '').replace(/\s+/g, ' ').slice(0, 80)
            return `- ${p}: ${pr.total} steps, ${where}. Starts: "${starts}"`
          } catch (e) {
            return `- ${p}: unreadable (${(e as Error).message})`
          }
        })
        .join('\n')
    },
  },
  {
    name: 'board_next',
    description:
      "Show where a board's run stands and which steps are ready now, with each step's instruction, material and the output of the steps before it. Read-only. Call before working a board, and again whenever you are unsure what is next.",
    inputSchema: {
      type: 'object',
      properties: { board: { type: 'string', description: 'Vault-relative path, e.g. "Home.canvas".' } },
      required: ['board'],
    },
    run: (a) => view(loadBoard(rel(a.board, 'board'))),
  },
  {
    name: 'board_record',
    description:
      'Record what happened to one step of a board, after EVERY step. Claims the board for you (a 30-minute lease, renewed on each record) so another agent does not work it at the same time, and releases it when nothing is left for you to do. Never edit the .canvas to record progress; this writes the run file beside it. Returns the updated board_next view.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Vault-relative path of the board.' },
        step: { type: 'string', description: 'Step id, as board_next shows it in [brackets].' },
        state: { type: 'string', enum: [...STATES], description: 'awaiting-human when the step needs the user to answer a question; on a branch, mark the path not taken skipped.' },
        output: { type: 'string', description: 'What the step produced, briefly. Later steps and later agents read this.' },
        question: { type: 'string', description: 'awaiting-human only: what to ask the user.' },
        error: { type: 'string', description: 'failed only: what went wrong.' },
        by: { type: 'string', description: 'A name for yourself, unique to this session, e.g. "claude-code: weekly report".' },
      },
      required: ['board', 'step', 'state', 'by'],
    },
    run(a) {
      const b = loadBoard(rel(a.board, 'board'))
      const step = str(a.step, 'step')
      const by = str(a.by, 'by')
      const state = a.state as (typeof STATES)[number]
      if (!STATES.includes(state)) throw new Error(`state must be one of ${STATES.join(', ')}`)
      if (!b.plan.runnable) throw new Error(view(b))
      if (!b.plan.steps.some((s) => s.id === step)) throw new Error(`${b.board} has no step ${step}. board_next lists the ids.`)
      const now = Date.now()
      const held = liveClaim(b.run, now)
      if (held && held.by !== by) {
        throw new Error(`${b.board} is claimed by "${held.by}" until ${new Date(held.until).toISOString()}. Do something else; do not wait.`)
      }

      // Only the fields this call supplied: an undefined `question` must not
      // erase the one a person is still reading.
      const patch = Object.fromEntries(
        Object.entries({ state, output: a.output, question: a.question, error: a.error }).filter(([, v]) => typeof v === 'string'),
      )
      let run = runs.settleUnreachable(b.plan, runs.record(b.run, step, patch, now), now)
      // Busy = there is still something for an agent to do or finish. A board
      // parked on a person must not also look taken.
      const busy =
        runs.ready(b.plan, run).length > 0 || b.plan.steps.some((s) => runs.stateOf(run, s.id) === 'running')
      run = { ...run, boardStamp: b.stamp, claim: busy ? { by, until: now + LEASE_MS } : undefined }

      const tmp = `${b.runFile}.tmp`
      writeFileSync(tmp, runs.serializeRun(run))
      renameSync(tmp, b.runFile)
      // The warning (if any) is computed against the stamp the run had BEFORE
      // this record, which is the one the caller has not yet acknowledged.
      return `Recorded [${step}] ${state}.\n\n${view(b, run)}`
    },
  },
  {
    name: 'create_board',
    description:
      'Create a NEW board (a runnable pipeline the user can see and edit on their canvas) from steps and arrows. Use when a multi-step task is worth repeating: capture the route that worked so the next run is cheap. Refuses to overwrite an existing board and refuses a loop (a loop is a mind-map, not a pipeline).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path ending .canvas, e.g. "Pipelines/Weekly Report.canvas".' },
        steps: {
          type: 'array',
          description: 'Each step is a card: an instruction (text) or a note to use as material (file).',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Your name for the step, used in edges.' },
              text: { type: 'string', description: 'The instruction, as you would say it to a colleague.' },
              file: { type: 'string', description: 'Instead of text: vault-relative path of a note, skill or sub-board.' },
            },
            required: ['key'],
          },
        },
        edges: {
          type: 'array',
          description: 'Arrows: from runs before to. A label is a condition in plain words, e.g. "if yes".',
          items: {
            type: 'object',
            properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } },
            required: ['from', 'to'],
          },
        },
        evidence: EVIDENCE,
      },
      required: ['path', 'steps', 'evidence'],
    },
    async run(a) {
      const path = rel(a.path, 'path')
      if (!isCanvasPath(path)) throw new Error('path must end .canvas')
      const abs = vault.resolveInVault(path)
      vault.requireVisible(abs)
      const who = actor(a.evidence)
      if (!Array.isArray(a.steps) || a.steps.length === 0) throw new Error('steps must be a non-empty list')
      const steps = a.steps.map((s: Args, i: number) => {
        const key = str(s?.key, `steps[${i}].key`)
        if ((typeof s.text === 'string') === (typeof s.file === 'string')) {
          throw new Error(`steps[${i}] needs exactly one of text or file`)
        }
        return { key, text: s.text as string | undefined, file: typeof s.file === 'string' ? s.file.replace(/\\/g, '/') : undefined }
      })
      const keys = new Set(steps.map((s) => s.key))
      if (keys.size !== steps.length) throw new Error('step keys must be unique')
      const edges = (Array.isArray(a.edges) ? a.edges : []).map((e: Args, i: number) => {
        const from = str(e?.from, `edges[${i}].from`)
        const to = str(e?.to, `edges[${i}].to`)
        if (!keys.has(from) || !keys.has(to)) throw new Error(`edges[${i}] names a step that does not exist`)
        return { from, to, label: typeof e.label === 'string' ? e.label : undefined }
      })

      const doc = layout(steps, edges)
      const plan = compile(doc)
      if (!plan.runnable) throw new Error(['Not created, it is not a pipeline:', ...plan.problems.map((p) => `- ${p.detail}`)].join('\n'))
      mkdirSync(dirname(abs), { recursive: true })
      // mtime 0 is vault.ts's CREATE stamp: on a path that exists it is a
      // conflict, so this can never overwrite a board.
      try {
        await vault.save(path, serializeCanvas(doc), 0, who)
      } catch (e) {
        if (e instanceof Error && e.name === 'SaveConflict') throw new Error(`${path} already exists. Boards are never overwritten; pick another path.`)
        throw e
      }
      logWrite('create_board', [path], who.evidence)
      changed()
      return `Created ${path}.\n\n${view(loadBoard(path))}`
    },
  },
  ...appTools(),
]

/**
 * EVERY OTHER SURFACE A PERSON USES IN THE APP, as tools: notes, the graph, the
 * database, the canvas, the roadmap, and the window itself. The rule they were
 * written to: anything a user can put into Fate, an agent can too, through the
 * same code — vault.ts's backups, overwrite guard and trash, the graph the
 * graph view draws, the rows the Database tab lists. What an agent gets that a
 * click does not is the evidence requirement on every write.
 *
 * A function rather than a literal only so the array above can end with it;
 * nothing here is computed.
 */
function appTools(): Tool[] {
  return [
    // ---------------------------------------------------------------- notes
    {
      name: 'read_note',
      description:
        'Read a note in full, with its mtime. Pass that mtime back to write_note or set_property: a change is refused if the note moved on since you read it, so nobody\'s edit is silently overwritten.',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Vault-relative, e.g. "Fate/PC Specs.md".' } }, required: ['path'] },
      async run(a) {
        const n = await vault.read(rel(a.path, 'path'))
        return `${n.path} · mtime ${n.mtime}\n\n${n.text}`
      },
    },
    {
      name: 'write_note',
      description:
        "Create a note, or replace one you have read. Goes through Fate's own save: the old text is kept in .backups/, and a note that changed since you read it is refused rather than overwritten. Write only verified, credible information, and say what it rests on in `evidence`. To start from a template, read_note the template under Templates/ first.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path ending .md.' },
          text: { type: 'string', description: 'The complete new text. This replaces the note; it does not append.' },
          mtime: { type: 'number', description: 'The mtime read_note gave you. Omit only when creating a new note.' },
          evidence: EVIDENCE,
        },
        required: ['path', 'text', 'evidence'],
      },
      async run(a) {
        const path = notePath(a.path)
        if (typeof a.text !== 'string') throw new Error('text must be a string')
        const who = actor(a.evidence)
        mkdirSync(dirname(vault.resolveInVault(path)), { recursive: true })
        let saved
        try {
          saved = await vault.save(path, a.text, typeof a.mtime === 'number' ? a.mtime : 0, who)
        } catch (e) {
          throw saveError(e, path)
        }
        logWrite('write_note', [path], who.evidence)
        changed()
        return `Saved ${path} · mtime ${saved.mtime}. The previous text, if any, is in .backups/.`
      },
    },
    {
      name: 'move_note',
      description:
        "Move or rename a note, the way the explorer does: links stay resolvable by name, and nothing is deleted. To delete a note, there is no tool, which is the app's own rule; ask the user.",
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, evidence: EVIDENCE },
        required: ['from', 'to', 'evidence'],
      },
      async run(a) {
        const from = notePath(a.from, 'from')
        const to = notePath(a.to, 'to')
        const who = actor(a.evidence)
        await vault.move(from, to, who)
        logWrite('move_note', [from, to], who.evidence)
        changed()
        return `Moved ${from} → ${to}. The move is journalled and can be undone from the app.`
      },
    },
    {
      name: 'set_property',
      description:
        'Set one frontmatter property on a note (status, type, tags, updated, or any key), as editing a cell in the Database tab does. Reads, edits and saves through the overwrite guard in one step.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          key: { type: 'string', description: 'e.g. "status".' },
          value: { type: 'string', description: 'e.g. "active", or "[a, b]" for a list.' },
          evidence: EVIDENCE,
        },
        required: ['path', 'key', 'value', 'evidence'],
      },
      async run(a) {
        const path = notePath(a.path)
        const key = str(a.key, 'key')
        if (!/^[A-Za-z][\w-]*$/.test(key)) throw new Error('key must be a plain frontmatter name: letters, digits, - or _')
        if (typeof a.value !== 'string') throw new Error('value must be a string')
        const who = actor(a.evidence)
        const n = await vault.read(path)
        try {
          await vault.save(path, setFrontmatter(n.text, key, a.value), n.mtime, who)
        } catch (e) {
          throw saveError(e, path)
        }
        logWrite('set_property', [path], who.evidence)
        changed()
        return `${path}: ${key} = ${a.value}`
      },
    },

    // ---------------------------------------------------------------- the graph
    {
      name: 'note_links',
      description:
        "A note's place in the graph: what it links to, what links to it, and (depth 2) the notes two hops away. The same links the graph view draws.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, depth: { type: 'number', description: '1 (default) or 2.' } },
        required: ['path'],
      },
      async run(a) {
        const path = rel(a.path, 'path')
        const links = await writtenLinks()
        const out = uniq(links.filter((l) => l.from === path).map((l) => l.to))
        const inn = uniq(links.filter((l) => l.to === path).map((l) => l.from))
        if (out.length === 0 && inn.length === 0) return `${path} has no links in or out. It is an orphan, or not a note in this vault.`
        const lines = [`## ${path}`, `links to (${out.length}): ${out.join(', ') || '—'}`, `linked from (${inn.length}): ${inn.join(', ') || '—'}`]
        if (a.depth === 2) {
          const ring = new Set([path, ...out, ...inn])
          const two = new Map<string, string>()
          for (const l of links) {
            if (ring.has(l.from) && !ring.has(l.to) && l.from !== path) two.set(l.to, l.from)
            if (ring.has(l.to) && !ring.has(l.from) && l.to !== path) two.set(l.from, l.to)
          }
          const shown = [...two].slice(0, 40)
          lines.push(`two hops (${two.size}${two.size > shown.length ? `, first ${shown.length}` : ''}): ${shown.map(([n, via]) => `${n} (via ${via})`).join(', ') || '—'}`)
        }
        return lines.join('\n')
      },
    },
    {
      name: 'graph_path',
      description: 'The shortest chain of links between two notes, ignoring direction. Answers "how is X connected to Y".',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      async run(a) {
        const from = rel(a.from, 'from')
        const to = rel(a.to, 'to')
        const links = await writtenLinks()
        const next = new Map<string, string[]>()
        const add = (x: string, y: string) => next.set(x, [...(next.get(x) ?? []), y])
        for (const l of links) {
          add(l.from, l.to)
          add(l.to, l.from)
        }
        const prev = new Map<string, string | null>([[from, null]])
        const queue = [from]
        while (queue.length && !prev.has(to)) {
          const cur = queue.shift()!
          for (const n of next.get(cur) ?? []) {
            if (!prev.has(n)) {
              prev.set(n, cur)
              queue.push(n)
            }
          }
        }
        if (!prev.has(to)) return `${from} and ${to} are not connected by any chain of links.`
        const chain: string[] = []
        for (let at: string | null = to; at !== null; at = prev.get(at) ?? null) chain.unshift(at)
        return `${chain.length - 1} link${chain.length === 2 ? '' : 's'}: ${chain.join(' → ')}`
      },
    },
    {
      name: 'graph_overview',
      description: 'The shape of the whole vault: how many notes and links, the hubs everything hangs off, and the orphans nothing reaches.',
      inputSchema: { type: 'object', properties: {} },
      async run() {
        const [{ nodes }, links, rows] = await Promise.all([vault.graph(), writtenLinks(), vault.list()])
        const degree = new Map<string, number>()
        for (const l of links) {
          degree.set(l.from, (degree.get(l.from) ?? 0) + 1)
          degree.set(l.to, (degree.get(l.to) ?? 0) + 1)
        }
        const hubs = [...degree].sort((x, y) => y[1] - x[1]).slice(0, 10)
        const orphans = rows.filter((r) => r.orphan).map((r) => r.path)
        return [
          `${nodes.length} notes, ${links.length} links.`,
          `Hubs: ${hubs.map(([p, d]) => `${p} (${d})`).join(', ')}`,
          `Orphans (${orphans.length}${orphans.length > 30 ? ', first 30' : ''}): ${orphans.slice(0, 30).join(', ') || '—'}`,
        ].join('\n')
      },
    },

    // ---------------------------------------------------------------- the database
    {
      name: 'query_notes',
      description:
        "The Database tab as a query: notes filtered by folder, type, status, tag, orphan, or last-updated date, newest first. Each row shows the frontmatter the table shows.",
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Path prefix, e.g. "Fate/Roadmap".' },
          type: { type: 'string' },
          status: { type: 'string' },
          tag: { type: 'string' },
          orphan: { type: 'boolean' },
          updated_after: { type: 'string', description: 'YYYY-MM-DD.' },
          limit: { type: 'number', description: 'Default 50.' },
        },
      },
      async run(a) {
        const has = (k: string) => typeof a[k] === 'string' && (a[k] as string) !== ''
        const folder = has('folder') ? (a.folder as string).replace(/\\/g, '/').replace(/\/?$/, '/') : null
        const rows = (await vault.list())
          .filter((r) => !folder || r.path.startsWith(folder))
          .filter((r) => !has('type') || r.type === a.type)
          .filter((r) => !has('status') || r.status === a.status)
          .filter((r) => !has('tag') || r.tags.includes(a.tag as string))
          .filter((r) => typeof a.orphan !== 'boolean' || r.orphan === a.orphan)
          .filter((r) => !has('updated_after') || r.updated > (a.updated_after as string))
          .sort((x, y) => y.updated.localeCompare(x.updated) || x.path.localeCompare(y.path))
        const limit = typeof a.limit === 'number' && a.limit > 0 ? Math.floor(a.limit) : 50
        if (rows.length === 0) return 'No notes match.'
        return [
          `${rows.length} note${rows.length === 1 ? '' : 's'}${rows.length > limit ? `, first ${limit}` : ''}. path | type | status | updated | tags`,
          ...rows.slice(0, limit).map((r) => `${r.path} | ${r.type || '—'} | ${r.status || '—'} | ${r.updated || '—'} | ${r.tags.join(', ') || '—'}`),
        ].join('\n')
      },
    },

    // ---------------------------------------------------------------- the canvas
    {
      name: 'read_board',
      description: "Every card, group and arrow on a board, with card ids: what the canvas shows, as text. Use the ids with add_to_board.",
      inputSchema: { type: 'object', properties: { board: { type: 'string' } }, required: ['board'] },
      async run(a) {
        const board = rel(a.board, 'board')
        if (!isCanvasPath(board)) throw new Error(`${board} is not a .canvas board`)
        const doc = parseCanvas((await vault.read(board)).text)
        const groups = doc.nodes.filter((n) => n.type === 'group')
        const cards = doc.nodes.filter((n) => n.type !== 'group')
        const said = (n: (typeof cards)[number]) =>
          (n.text ?? n.file ?? n.url ?? '').replace(/\s+/g, ' ').slice(0, 160) || '(empty)'
        const plan = compile(doc)
        return [
          `${board}: ${cards.length} cards, ${groups.length} groups, ${doc.edges.length} arrows. ${plan.runnable ? 'Runnable as a pipeline.' : 'Not a pipeline (a mind-map, or it has a loop).'}`,
          groups.length ? `Groups: ${groups.map((g) => `"${g.label ?? ''}"`).join(', ')}` : '',
          'Cards:',
          ...cards.map((n) => `- [${n.id}] ${n.type}: ${said(n)}`),
          doc.edges.length ? 'Arrows:' : '',
          ...doc.edges.map((e) => `- [${e.fromNode}] → [${e.toNode}]${e.label ? ` "${e.label}"` : ''}`),
        ].filter(Boolean).join('\n')
      },
    },
    {
      name: 'add_to_board',
      description:
        "Add cards and arrows to an EXISTING board, as dragging them onto the canvas does. New cards go to the right of what is there; nothing already on the board is moved or changed. Arrows may join new cards (by your key) to existing ones (by the id read_board shows).",
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'string' },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' } },
              required: ['key'],
            },
          },
          edges: {
            type: 'array',
            items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] },
          },
          evidence: EVIDENCE,
        },
        required: ['board', 'cards', 'evidence'],
      },
      async run(a) {
        const board = rel(a.board, 'board')
        if (!isCanvasPath(board)) throw new Error(`${board} is not a .canvas board`)
        vault.requireVisible(vault.resolveInVault(board))
        const who = actor(a.evidence)
        const n = await vault.read(board)
        const doc = parseCanvas(n.text)
        if (!Array.isArray(a.cards) || a.cards.length === 0) throw new Error('cards must be a non-empty list')
        const cards = a.cards.map((c: Args, i: number) => {
          const key = str(c?.key, `cards[${i}].key`)
          if ((typeof c.text === 'string') === (typeof c.file === 'string')) throw new Error(`cards[${i}] needs exactly one of text or file`)
          return { key, text: c.text as string | undefined, file: typeof c.file === 'string' ? c.file.replace(/\\/g, '/') : undefined }
        })
        const fresh = new Set(cards.map((c) => c.key))
        if (fresh.size !== cards.length) throw new Error('card keys must be unique')
        const existing = new Set(doc.nodes.map((x) => x.id))
        const edges = (Array.isArray(a.edges) ? a.edges : []).map((e: Args, i: number) => {
          const from = str(e?.from, `edges[${i}].from`)
          const to = str(e?.to, `edges[${i}].to`)
          for (const end of [from, to]) {
            if (!fresh.has(end) && !existing.has(end)) throw new Error(`edges[${i}]: "${end}" is neither a new card's key nor a card on the board`)
          }
          return { from, to, label: typeof e.label === 'string' ? e.label : undefined }
        })

        // Lay the new cards out among themselves, then park the lot to the
        // right of the board's current extent, top-aligned with it.
        const placed = layout(cards, edges.filter((e) => fresh.has(e.from) && fresh.has(e.to)))
        const right = doc.nodes.reduce((m, x) => Math.max(m, x.x + x.width), 0)
        const top = doc.nodes.length ? doc.nodes.reduce((m, x) => Math.min(m, x.y), Infinity) : 0
        const idOf = new Map(cards.map((c, i) => [c.key, placed.nodes[i].id]))
        for (const node of placed.nodes) {
          node.x += right + 160
          node.y += top
        }
        doc.nodes.push(...placed.nodes)
        for (const e of edges) {
          doc.edges.push({
            id: canvasId(),
            fromNode: idOf.get(e.from) ?? e.from,
            toNode: idOf.get(e.to) ?? e.to,
            fromSide: 'right',
            toSide: 'left',
            ...(e.label ? { label: e.label } : {}),
          })
        }
        try {
          await vault.save(board, serializeCanvas(doc), n.mtime, who)
        } catch (e) {
          throw saveError(e, board)
        }
        logWrite('add_to_board', [board], who.evidence)
        changed()
        const plan = compile(doc)
        return `Added ${cards.length} card${cards.length === 1 ? '' : 's'} and ${edges.length} arrow${edges.length === 1 ? '' : 's'} to ${board}. ${plan.runnable ? 'It still runs as a pipeline.' : `It is not a runnable pipeline now: ${plan.problems.map((p) => p.detail).join('; ')}`}`
      },
    },

    // ---------------------------------------------------------------- the roadmap
    {
      name: 'roadmap',
      description:
        "The roadmap of the main project, the project of projects. For this vault that is Fate itself: every feature, grouped, with its honest status (built, partial, planned) and what was verified. Start here for any work on Fate. It is source code, src/shared/roadmap.ts in the agent-workspace repo: when your work changes what an entry describes, update that entry there and say what you watched work.",
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['built', 'partial', 'planned'] } } },
      run(a) {
        const want = typeof a.status === 'string' ? a.status : null
        const all = ROADMAP.flatMap((g) => g.features)
        const count = (s: string) => all.filter((f) => f.status === s).length
        return [
          `Fate roadmap: ${count('built')} built, ${count('partial')} partial, ${count('planned')} planned.`,
          ...ROADMAP.flatMap((g) => {
            const fs = g.features.filter((f) => !want || f.status === want)
            if (fs.length === 0) return []
            return [
              '',
              `## ${g.title}${g.subtitle ? ` — ${g.subtitle}` : ''}`,
              ...fs.map((f) => `- [${f.status}] ${f.label}${f.surface ? ` (${f.surface})` : ''}${f.note ? ` — ${f.note.length > 240 ? `${f.note.slice(0, 240)}…` : f.note}` : ''}`),
            ]
          }),
        ].join('\n')
      },
    },

    // ---------------------------------------------------------------- the window
    {
      name: 'open_view',
      description:
        "Bring a view forward in the running Fate window so the user can watch: the graph, a board on the canvas, the database, the roadmap, the planner, or a note in the editor. Use it when you are working somewhere the user would want to see.",
      inputSchema: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: [...VIEWS] },
          path: { type: 'string', description: 'A note or board to open with it. A .canvas path opens on the canvas.' },
        },
        required: ['view'],
      },
      async run(a) {
        const view = a.view as AgentView
        if (!VIEWS.includes(view)) throw new Error(`view must be one of ${VIEWS.join(', ')}`)
        const path = a.path === undefined ? undefined : rel(a.path, 'path')
        const why = await tellApp('/open', { view, ...(path ? { path } : {}) })
        if (why) throw new Error(why)
        return `Fate is showing the ${view}${path ? ` with ${path}` : ''}.`
      },
    },
  ]
}

// ------------------------------------------------------------------ protocol

const instructions = (): string =>
  [
    `Fate is the user's workspace at ${vault.getVaultDir()}: Markdown notes, a link graph, a database of their frontmatter, .canvas boards, and a roadmap. These tools reach every one of them, the way the user does in the app.`,
    'Before answering anything about their projects, decisions, preferences or past work, call search_vault: it is often already written down. Follow it with note_links to see what a note connects to.',
    'Before writing, read AGENTS.md at the vault root if it exists. Write through write_note, set_property, move_note and the board tools, not your own file writes: they keep backups and refuse to overwrite a change you did not see. Every write needs `evidence`. Only verified, credible information goes in, never your own guess.',
    'Boards are runnable pipelines. When a task sounds repeatable, check list_boards; to run one, board_next, do one ready step, board_record it, repeat. When you build a multi-step system (a transcription pipeline, a weekly report), lay it out as a board with create_board or add_to_board. Never edit a .canvas to record progress.',
    'For work on Fate itself, start at roadmap: it is the project of projects.',
    'When you are working somewhere the user would want to watch, open_view brings it up in their Fate window.',
  ].join(' ')

type Rpc = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: { name?: string; arguments?: Args; protocolVersion?: string; clientInfo?: { name?: unknown } }
}

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })

async function handle(m: Rpc): Promise<unknown> {
  switch (m.method) {
    case 'initialize':
      // The name every write is attributed to. A client that gives none is
      // still logged, as "an outside agent", rather than refused.
      if (typeof m.params?.clientInfo?.name === 'string' && m.params.clientInfo.name.trim()) {
        agentName = m.params.clientInfo.name.trim().slice(0, 80)
      }
      return {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fate', version: '1' },
        instructions: instructions(),
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map(({ run: _run, ...t }) => t) }
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === m.params?.name)
      if (!t) throw rpcError(-32602, `Unknown tool: ${m.params?.name}`)
      // A tool failure is an ANSWER the model should read, not a protocol fault.
      try {
        return { content: [{ type: 'text', text: await t.run(m.params?.arguments ?? {}) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }
      }
    }
  }
  throw rpcError(-32601, `Method not found: ${m.method}`)
}

const send = (m: object): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
}

// stdout IS the protocol. One stray console.log anywhere below would corrupt it.
console.log = console.error

createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (!line.trim()) return
    let m: Rpc
    try {
      m = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    if (m.id === undefined || m.id === null) return // a notification: nothing to answer
    try {
      send({ id: m.id, result: await handle(m) })
    } catch (e) {
      send({ id: m.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } })
    }
  })
// No exit on stdin close: nothing here holds the event loop open, so the
// process ends by itself once every in-flight call has answered. An explicit
// exit dropped those answers.
