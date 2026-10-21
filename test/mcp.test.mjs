/**
 * The MCP server, driven the way Claude Code drives it: a real child process,
 * JSON-RPC lines over stdio, a real vault on disk.
 *
 * End to end on purpose. The framing, the stdin-close behaviour and the path
 * guards are where this breaks, and none of them exist in a function you could
 * import. The invariant that matters most is the last one: working a board
 * never writes one byte of the .canvas itself.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vault = mkdtempSync(join(tmpdir(), 'fate-mcp-'))
mkdirSync(join(vault, 'Notes'))
writeFileSync(join(vault, 'Notes', 'Release.md'), '# Release\n\nThe release procedure lives here. See [[Checklist]].\n')
writeFileSync(join(vault, 'Checklist.md'), '# Checklist\n\n1. tests\n')

let proc
const waiting = new Map()
let nextId = 1

before(() => {
  proc = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      pathToFileURL(join(ROOT, 'test', 'fixtures', 'ts-hooks.mjs')).href,
      join(ROOT, 'src', 'main', 'mcp.ts'),
      vault,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  createInterface({ input: proc.stdout }).on('line', (l) => {
    const m = JSON.parse(l) // a non-JSON line on stdout is itself the failure
    waiting.get(m.id)?.(m)
  })
})
after(() => proc.kill())

const rpc = (method, params) =>
  new Promise((done) => {
    const id = nextId++
    waiting.set(id, done)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result
const text = (r) => r.content[0].text

test('initialize echoes the protocol version and tells the agent to search first', async () => {
  const { result } = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-agent' } })
  assert.equal(result.protocolVersion, '2025-03-26')
  assert.equal(result.serverInfo.name, 'fate')
  assert.match(result.instructions, /search_vault/)
  assert.ok(result.instructions.includes(vault))
})

test('tools/list offers every surface of the app', async () => {
  const { result } = await rpc('tools/list')
  assert.deepEqual(result.tools.map((t) => t.name), [
    'search_vault', 'list_boards', 'board_next', 'board_record', 'create_board',
    'read_note', 'write_note', 'move_note', 'set_property',
    'note_links', 'graph_path', 'graph_overview', 'query_notes',
    'read_board', 'add_to_board', 'roadmap', 'open_view',
  ])
  for (const t of result.tools) assert.equal(t.run, undefined, 'the handler must not leak into the schema')
})

test('search returns 1-based lines and the graph around the note', async () => {
  const out = text(await call('search_vault', { query: 'release procedure' }))
  assert.match(out, /word weight[^\n]*\n\n## Notes\/Release\.md\n/, 'every word must be in the name for a name match')
  assert.match(out, /L3: .*release procedure/)
  assert.match(out, /links to: Checklist\.md/)
  assert.match(text(await call('search_vault', { query: 'checklist' })), /## Checklist\.md \(name matches\)[\s\S]*linked from: Notes\/Release\.md/)
  assert.match(text(await call('search_vault', { query: 'zzqx' })), /Nothing in the vault matches/)
})

test('a whole question finds the note even though no note holds every word', async () => {
  // "shipping" is in no note, so the AND search would return nothing here.
  const out = text(await call('search_vault', { query: 'what was the release procedure before shipping' }))
  assert.match(out, /## Notes\/Release\.md\n[\s\S]*L3: .*release procedure/)
})

test('unknown methods and bad JSON are protocol errors, not crashes', async () => {
  assert.equal((await rpc('resources/list')).error.code, -32601)
  const parse = new Promise((done) => waiting.set(null, done))
  proc.stdin.write('{not json\n')
  assert.equal((await parse).error.code, -32700)
})

const flow = {
  path: 'Pipelines/Flow.canvas',
  steps: [
    { key: 'a', text: 'Step A: check the inbox' },
    { key: 'b', text: 'Step B: write it up' },
    { key: 'c', text: 'Step C: ask Nathan' },
    { key: 'd', file: 'Checklist.md' },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'if anything landed' },
    { from: 'a', to: 'c', label: 'if empty' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' },
  ],
  evidence: 'the user asked for this pipeline in chat',
}

test('create_board writes a runnable board, and refuses overwrite, loops and escapes', async () => {
  const made = await call('create_board', flow)
  assert.equal(made.isError, undefined, text(made))
  assert.match(text(made), /READY NOW[\s\S]*Step A: check the inbox/)
  assert.ok(existsSync(join(vault, 'Pipelines', 'Flow.canvas')))

  assert.match(text(await call('create_board', flow)), /already exists/)
  const loop = await call('create_board', { ...flow, path: 'Loop.canvas', edges: [...flow.edges, { from: 'd', to: 'a' }] })
  assert.equal(loop.isError, true)
  assert.match(text(loop), /not a pipeline/)
  assert.ok(!existsSync(join(vault, 'Loop.canvas')), 'a refused board leaves no file behind')
  assert.equal((await call('create_board', { ...flow, path: '../escape.canvas' })).isError, true)
  assert.equal((await call('create_board', { ...flow, path: '.git/x.canvas' })).isError, true)
})

test('a run goes step by step, claims the board, and never touches the .canvas', async () => {
  const board = 'Pipelines/Flow.canvas'
  const canvasBefore = readFileSync(join(vault, board), 'utf8')
  const id = (out, label) => out.match(new RegExp(`\\[([0-9a-f]+)\\] ${label}`))[1]

  assert.match(text(await call('list_boards')), /Pipelines\/Flow\.canvas: 4 steps, never run\. Starts: "Step A/)
  const first = text(await call('board_next', { board }))
  const a = id(first, 'Step A')

  const afterA = text(await call('board_record', { board, step: a, state: 'done', output: '3 new items', by: 'agent-1' }))
  assert.match(afterA, /Claimed by "agent-1"/)
  const b = id(afterA, 'Step B')
  const c = id(afterA, 'Step C')
  assert.match(afterA, /only "if anything landed" \(done: 3 new items\)/, 'the next step sees the condition and what came before')

  const taken = await call('board_record', { board, step: b, state: 'done', by: 'agent-2' })
  assert.equal(taken.isError, true)
  assert.match(text(taken), /claimed by "agent-1"/)

  await call('board_record', { board, step: b, state: 'done', by: 'agent-1' })
  const joined = text(await call('board_record', { board, step: c, state: 'skipped', by: 'agent-1' }))
  assert.match(joined, /READY NOW[\s\S]*material: Checklist\.md/, 'a join fires once every input is settled and one is done')

  const d = id(joined, 'Checklist\\.md')
  const done = text(await call('board_record', { board, step: d, state: 'done', by: 'agent-1' }))
  assert.match(done, /3\/4 done, 1 skipped/)
  assert.match(done, /The run is complete/)
  assert.doesNotMatch(done, /Claimed by/, 'a finished board releases its claim')

  const run = JSON.parse(readFileSync(join(vault, 'Pipelines', '.Flow.canvas.run.json'), 'utf8'))
  assert.equal(run.steps[a].output, '3 new items')
  assert.equal(readFileSync(join(vault, board), 'utf8'), canvasBefore, 'the board itself was never written')
})

test('a bad step, a bad state and a missing board are refused in words', async () => {
  const board = 'Pipelines/Flow.canvas'
  assert.match(text(await call('board_record', { board, step: 'nope', state: 'done', by: 'x' })), /has no step nope/)
  assert.match(text(await call('board_record', { board, step: 'nope', state: 'finished', by: 'x' })), /state must be one of/)
  assert.match(text(await call('board_next', { board: 'Missing.canvas' })), /No board at Missing\.canvas/)
  assert.match(text(await call('board_next', { board: 'Notes/Release.md' })), /not a \.canvas board/)
})
