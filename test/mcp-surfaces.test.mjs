/**
 * Every surface of the app, through the MCP server, the way an outside agent
 * reaches it: a real child process over stdio, a real vault on disk, and a
 * stand-in for the Fate window that records what it is asked to show.
 *
 * The properties that matter most, each a way this could quietly go wrong:
 *   - no write without evidence, and every write leaves a line saying what it
 *     rested on (the "only verified, credible information" rule);
 *   - a write never overwrites a change the agent did not read;
 *   - an agent cannot reach .git, .obsidian or .trash, or write a non-note;
 *   - adding to a board never moves what the user already placed;
 *   - open_view reaches the window, with the token, for this vault only.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { controlFile } = await import(pathToFileURL(join(ROOT, 'src', 'shared', 'control.ts')).href)

const vault = mkdtempSync(join(tmpdir(), 'fate-surfaces-'))
mkdirSync(join(vault, 'Notes'))
writeFileSync(join(vault, 'Notes', 'Release.md'), '# Release\n\nSee [[Checklist]] and [[Plan]].\n')
writeFileSync(join(vault, 'Checklist.md'), '# Checklist\n\n1. tests\n')
writeFileSync(join(vault, 'Plan.md'), '---\ntype: plan\nstatus: active\ntags: [ship]\nupdated: 2026-10-01\n---\n# Plan\n\nShip it. [[Far]]\n')
writeFileSync(join(vault, 'Far.md'), '# Far\n')
writeFileSync(join(vault, 'Lonely.md'), '# Lonely\n\nNo links at all.\n')
writeFileSync(
  join(vault, 'Board.canvas'),
  JSON.stringify({
    nodes: [
      { id: 'n1', type: 'text', text: 'Fetch the videos', x: 0, y: 0, width: 250, height: 60 },
      { id: 'n2', type: 'text', text: 'Transcribe them', x: 400, y: 0, width: 250, height: 60 },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
  }),
)

let proc
const waiting = new Map()
let nextId = 1
const rpc = (method, params) =>
  new Promise((done) => {
    const id = nextId++
    waiting.set(id, done)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
before(async () => {
  proc = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(join(ROOT, 'test', 'fixtures', 'ts-hooks.mjs')).href, join(ROOT, 'src', 'main', 'mcp.ts'), vault],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  createInterface({ input: proc.stdout }).on('line', (l) => waiting.get(JSON.parse(l).id)?.(JSON.parse(l)))
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'surface-agent' } })
})
after(() => {
  proc.kill()
  rmSync(controlFile(vault), { force: true })
})

const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result
const text = (r) => r.content[0].text
const ok = (r) => {
  assert.equal(r.isError, undefined, text(r))
  return text(r)
}
const EV = 'the user said: "write this down"'

test('a write needs evidence, refuses what it did not read, and leaves a backup and a log line', async () => {
  const bare = await call('write_note', { path: 'Notes/New.md', text: 'hello\n' })
  assert.equal(bare.isError, true)
  assert.match(text(bare), /evidence/)

  ok(await call('write_note', { path: 'Notes/New.md', text: 'hello\n', evidence: EV }))
  assert.equal(readFileSync(join(vault, 'Notes', 'New.md'), 'utf8'), 'hello\n')

  const blind = await call('write_note', { path: 'Notes/New.md', text: 'clobber\n', evidence: EV })
  assert.equal(blind.isError, true, 'an existing note written without its mtime must be refused')
  assert.match(text(blind), /exists or changed since you read it/)

  const read = ok(await call('read_note', { path: 'Notes/New.md' }))
  const mtime = Number(read.match(/mtime ([\d.]+)/)[1])
  ok(await call('write_note', { path: 'Notes/New.md', text: 'hello again\n', mtime, evidence: EV }))
  assert.equal(readFileSync(join(vault, 'Notes', 'New.md'), 'utf8'), 'hello again\n')
  assert.ok(readdirSync(join(vault, '.backups', 'Notes')).some((f) => f.startsWith('New.md.')), 'the replaced text is in .backups')

  const log = readFileSync(join(vault, 'System', 'agent-writes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(log.every((l) => l.agent === 'surface-agent' && l.evidence === EV))
  assert.deepEqual(log.map((l) => l.op), ['write_note', 'write_note'], 'the refused writes left no line')
})

test('an agent writes notes only, and nowhere the explorer hides', async () => {
  for (const path of ['.git/x.md', '.obsidian/x.md', '.trash/x.md', '../outside.md', 'Notes/x.txt', 'Board.canvas']) {
    const r = await call('write_note', { path, text: 'x', evidence: EV })
    assert.equal(r.isError, true, `${path} was written`)
  }
  assert.ok(!existsSync(join(vault, '.git')))
  assert.ok(!existsSync(resolve(vault, '..', 'outside.md')))
})

test('set_property edits frontmatter through the guard, and move_note moves', async () => {
  ok(await call('set_property', { path: 'Notes/New.md', key: 'status', value: 'draft', evidence: EV }))
  assert.match(readFileSync(join(vault, 'Notes', 'New.md'), 'utf8'), /^---\nstatus: draft\n---\n/)
  assert.equal((await call('set_property', { path: 'Notes/New.md', key: 'bad key!', value: 'x', evidence: EV })).isError, true)

  ok(await call('move_note', { from: 'Notes/New.md', to: 'Notes/Moved.md', evidence: EV }))
  assert.ok(existsSync(join(vault, 'Notes', 'Moved.md')))
  assert.ok(!existsSync(join(vault, 'Notes', 'New.md')))
})

test('the graph: links both ways, two hops, a path, and the orphans', async () => {
  const one = ok(await call('note_links', { path: 'Plan.md', depth: 2 }))
  assert.match(one, /links to \(1\): Far\.md/)
  assert.match(one, /linked from \(1\): Notes\/Release\.md/)
  assert.match(one, /two hops[^\n]*Checklist\.md \(via Notes\/Release\.md\)/)

  assert.match(ok(await call('graph_path', { from: 'Checklist.md', to: 'Far.md' })), /3 links: Checklist\.md → Notes\/Release\.md → Plan\.md → Far\.md/)
  assert.match(ok(await call('graph_path', { from: 'Lonely.md', to: 'Far.md' })), /not connected/)
  assert.match(ok(await call('graph_overview')), /Orphans \(\d+\): [^\n]*Lonely\.md/)

  // Written through the tools a moment ago: the cached graph must already know.
  ok(await call('write_note', { path: 'Linker.md', text: 'See [[Lonely]].\n', evidence: EV }))
  assert.match(ok(await call('note_links', { path: 'Lonely.md' })), /linked from \(1\): Linker\.md/)
})

test('query_notes is the Database tab as a filter', async () => {
  const plans = ok(await call('query_notes', { type: 'plan' }))
  assert.match(plans, /^1 note\./)
  assert.match(plans, /Plan\.md \| plan \| active \| 2026-10-01 \| ship/)
  assert.match(ok(await call('query_notes', { tag: 'ship', status: 'active' })), /Plan\.md/)
  assert.equal(ok(await call('query_notes', { type: 'nothing-is-this' })), 'No notes match.')
  assert.match(ok(await call('query_notes', { folder: 'Notes' })), /Notes\/Release\.md/)
})

test('a board is read as text, and added to without moving what is there', async () => {
  const board = ok(await call('read_board', { board: 'Board.canvas' }))
  assert.match(board, /2 cards, 0 groups, 1 arrows\. Runnable/)
  assert.match(board, /\[n1\] text: Fetch the videos/)
  assert.match(board, /\[n1\] → \[n2\]/)

  const added = ok(
    await call('add_to_board', {
      board: 'Board.canvas',
      cards: [{ key: 'save', text: 'Save each transcript to Transcripts/' }, { key: 'note', file: 'Plan.md' }],
      edges: [{ from: 'n2', to: 'save' }, { from: 'save', to: 'note', label: 'when done' }],
      evidence: EV,
    }),
  )
  assert.match(added, /Added 2 cards and 2 arrows .* still runs as a pipeline/)
  const doc = JSON.parse(readFileSync(join(vault, 'Board.canvas'), 'utf8'))
  assert.deepEqual(doc.nodes.slice(0, 2).map((n) => [n.id, n.x, n.y]), [['n1', 0, 0], ['n2', 400, 0]], 'existing cards did not move')
  assert.ok(doc.nodes.slice(2).every((n) => n.x >= 650), 'new cards sit to the right of the board')
  assert.equal(doc.edges.length, 3)

  const bad = await call('add_to_board', { board: 'Board.canvas', cards: [{ key: 'x', text: 'x' }], edges: [{ from: 'ghost', to: 'x' }], evidence: EV })
  assert.match(text(bad), /"ghost" is neither/)
})

test('the roadmap is the project of projects, and filters by status', async () => {
  const all = ok(await call('roadmap'))
  assert.match(all, /^Fate roadmap: \d+ built, \d+ partial, \d+ planned\./)
  const planned = ok(await call('roadmap', { status: 'planned' }))
  assert.ok(!/\[built\]|\[partial\]/.test(planned), 'the filter lets nothing else through')
})

test('open_view reaches the window with the token, for this vault, and says so when Fate is closed', async () => {
  rmSync(controlFile(vault), { force: true })
  assert.match(text(await call('open_view', { view: 'graph' })), /Fate is not open on this vault/)
  // What a crash leaves: the file, naming a process that is gone.
  writeFileSync(controlFile(vault), JSON.stringify({ port: 9, token: 't', vault, pid: 2 ** 22 + 1 }))
  assert.match(text(await call('open_view', { view: 'graph' })), /Fate is not open on this vault/, 'a dead app is not knocked on')

  const seen = []
  const app = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-fate-token'], body: JSON.parse(body) })
      res.end('ok')
    })
  })
  await new Promise((r) => app.listen(0, '127.0.0.1', r))
  writeFileSync(controlFile(vault), JSON.stringify({ port: app.address().port, token: 'tok', vault, pid: process.pid }))
  try {
    assert.match(ok(await call('open_view', { view: 'canvas', path: 'Board.canvas' })), /showing the canvas with Board\.canvas/)
    assert.equal((await call('open_view', { view: 'terminal' })).isError, true, 'only the views the app has')

    ok(await call('write_note', { path: 'Ping.md', text: 'x\n', evidence: EV }))
    await new Promise((r) => setTimeout(r, 200)) // /changed is fire and forget
    const open = seen.find((s) => s.url === '/open')
    assert.equal(open.token, 'tok')
    assert.deepEqual({ view: open.body.view, path: open.body.path }, { view: 'canvas', path: 'Board.canvas' })
    assert.equal(resolve(open.body.vault), resolve(vault))
    assert.ok(seen.some((s) => s.url === '/changed'), 'a write tells the window to re-read')
  } finally {
    app.close()
  }
})
