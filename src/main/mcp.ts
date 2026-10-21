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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as vault from './vault.js'
import { canvasId, isCanvasPath, parseCanvas, serializeCanvas, type CanvasDoc } from '../shared/canvas.js'
import { compile, type Plan, type Step } from '../shared/pipeline.js'
import * as runs from '../shared/run.js'
import { terms } from '../shared/retrieve.js'
import { searchText, titleMatches } from '../shared/search.js'
import type { BoardStamp } from '../shared/brief.js'
import type { VaultTreeNode } from '../shared/ipc.js'

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
      const { links } = await vault.graph()
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
      },
      required: ['path', 'steps'],
    },
    run(a) {
      const path = rel(a.path, 'path')
      if (!isCanvasPath(path)) throw new Error('path must end .canvas')
      const abs = vault.resolveInVault(path)
      vault.requireVisible(abs)
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
      try {
        writeFileSync(abs, serializeCanvas(doc), { flag: 'wx' }) // wx: never overwrite, atomically
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} already exists. Boards are never overwritten; pick another path.`)
        throw e
      }
      return `Created ${path}.\n\n${view(loadBoard(path))}`
    },
  },
]

// ------------------------------------------------------------------ protocol

const instructions = (): string =>
  [
    `Fate is the user's knowledge vault at ${vault.getVaultDir()}: Markdown notes plus .canvas boards.`,
    'Before answering anything about their projects, decisions, preferences or past work, call search_vault: it is often already written down.',
    'Before writing to the vault, read AGENTS.md at its root if it exists.',
    'Boards are runnable pipelines the user drew. When a task sounds repeatable, check list_boards first; to work one, call board_next, do one ready step, board_record it, repeat.',
    'When you finish multi-step work worth repeating, offer to save it with create_board. Never edit a .canvas file to record progress.',
  ].join(' ')

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: { name?: string; arguments?: Args; protocolVersion?: string } }

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })

async function handle(m: Rpc): Promise<unknown> {
  switch (m.method) {
    case 'initialize':
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
