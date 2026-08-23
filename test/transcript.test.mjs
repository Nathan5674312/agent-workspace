/**
 * READING WHAT AN AGENT DID FROM A FILE IT DOES NOT WRITE.
 *
 * The design this replaced had agents announce themselves into a log, and it was
 * wrong for one reason: anything an agent writes about itself, it can omit. The
 * harness-written transcript gives a different and stronger property — not
 * honesty, COMPLETENESS. A model cannot call Read without the call appearing.
 *
 * So the tests that matter are the two privacy boundaries and the one
 * robustness case, because all three fail silently:
 *
 *   A shell command is reduced to program and subcommand and STOPS at the first
 *   flag. Arguments carry tokens, keys and URLs, and a status popup showing them
 *   will eventually show one into a screen recording.
 *
 *   Nothing renders message text, thinking, or tool RESULTS. A transcript holds
 *   whole conversations. A display that reaches into them stops being a status
 *   indicator and becomes a window onto everything private in the session.
 *
 *   A half-written last line must not throw. The file is being appended to while
 *   this reads it, so the final line is routinely incomplete — exactly when an
 *   agent is working, which is exactly when this is needed.
 *
 * Fixtures below are real transcript shapes, taken from the actual files on this
 * machine rather than invented.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { parseLine, parseLines, relativeTo, since, sessions, describe } = await import(
  '../src/shared/transcript.ts'
)

const line = (blocks, over = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-23T09:04:24.953Z',
    sessionId: 'sess-a',
    cwd: 'C:\\Users\\Nathan\\Desktop\\agent-workspace',
    gitBranch: 'main',
    message: { content: blocks },
    ...over,
  })

const use = (name, input) => ({ type: 'tool_use', id: 'toolu_x', name, input })
const AT = Date.parse('2026-08-23T09:04:24.953Z')

// ------------------------------------------------------------------ the shape

test('a tool call becomes an activity with its path and time', () => {
  const [a] = parseLine(line([use('Read', { file_path: 'C:\\Users\\Nathan\\Desktop\\x.md' })]))
  assert.equal(a.tool, 'Read')
  assert.equal(a.action, 'read')
  assert.equal(a.path, 'C:\\Users\\Nathan\\Desktop\\x.md')
  assert.equal(a.at, AT)
  assert.equal(a.session, 'sess-a')
})

test('one line can hold several tool calls and all of them come back', () => {
  const out = parseLine(
    line([
      use('Read', { file_path: 'a.md' }),
      { type: 'text', text: 'some reasoning that must not be read' },
      use('Grep', { pattern: 'TODO' }),
    ]),
  )
  assert.deepEqual(out.map((a) => a.tool), ['Read', 'Grep'])
})

test('writes and edits both read as editing', () => {
  for (const t of ['Write', 'Edit', 'MultiEdit']) {
    assert.equal(parseLine(line([use(t, { file_path: 'a.md' })]))[0].action, 'write')
  }
})

test('an unknown tool is reported as other, never dropped', () => {
  // Silence would read as "the agent did nothing", which is the one thing this
  // must never say wrongly. A future tool should show as undescribed activity.
  const [a] = parseLine(line([use('SomeToolFromNextYear', { file_path: 'a.md' })]))
  assert.equal(a.action, 'other')
  assert.equal(a.tool, 'SomeToolFromNextYear')
})

// ------------------------------------------------------- the privacy boundary

test('a shell command is reduced to program and subcommand', () => {
  const d = (command) => parseLine(line([use('Bash', { command })]))[0].detail
  assert.equal(d('git commit -m "secret message"'), 'git commit')
  assert.equal(d('npm test'), 'npm test')
  assert.equal(d('node --experimental-strip-types probe.mjs'), 'node')
  assert.equal(d('/usr/bin/git status'), 'git status')
})

test('a path argument never rides along as a subcommand', () => {
  // Caught by running this over a real transcript, not by review. The rule was
  // "include the second token unless it is a flag", and a quoted path is not a
  // flag — so `cd "C:/Users/.../scratchpad"` put the whole filesystem layout on
  // screen. A subcommand has to LOOK like one: a bare lowercase word.
  const d = (command) => parseLine(line([use('Bash', { command })]))[0].detail
  assert.equal(d('cd "C:/Users/Nathan/AppData/Local/Temp/claude/sess/scratchpad"'), 'cd')
  assert.equal(d('cd C:\\Users\\Nathan\\Desktop'), 'cd')
  assert.equal(d('cat /etc/passwd'), 'cat')
  assert.equal(d('node probe.mjs'), 'node')
  assert.equal(d('rm -rf ./x'), 'rm')
  // ...while a real subcommand still comes through.
  assert.equal(d('git commit'), 'git commit')
  assert.equal(d('cargo build --release'), 'cargo build')
})

test('a command never reaches the display with its arguments', () => {
  // The failure this prevents is a token on screen during a recording.
  const secret = 'curl -H "Authorization: Bearer sk-live-DO-NOT-SHOW" https://api.example.com'
  const [a] = parseLine(line([use('Bash', { command: secret })]))
  assert.equal(a.detail, 'curl')
  assert.ok(!JSON.stringify(a).includes('sk-live'), 'a credential survived into the activity')
})

test('a fetched URL is reduced to its host, because a query string carries tokens', () => {
  const [a] = parseLine(line([use('WebFetch', { url: 'https://example.com/x?token=abc123' })]))
  assert.equal(a.detail, 'example.com')
  assert.ok(!JSON.stringify(a).includes('abc123'))
})

test('message text, thinking and tool results never become activity', () => {
  const out = parseLine(
    line([
      { type: 'text', text: 'private conversation content' },
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'tool_result', content: 'the entire contents of a file' },
    ]),
  )
  assert.deepEqual(out, [])
})

test('an unhandled tool contributes no detail rather than a stringified input', () => {
  // A default that printed unknown inputs would leak the first time a tool with
  // a sensitive argument appeared, and would do it silently.
  const [a] = parseLine(line([use('SomeTool', { apiKey: 'sk-live-leak', file_path: 'a.md' })]))
  assert.equal(a.detail, undefined)
  assert.ok(!JSON.stringify(a).includes('sk-live-leak'))
})

// -------------------------------------------------------------- robustness

test('a half-written last line yields nothing instead of throwing', () => {
  // The file is appended to while being read, so this is the NORMAL state when
  // an agent is working — which is exactly when the display is needed.
  assert.deepEqual(parseLine('{"type":"assistant","message":{"cont'), [])
  assert.deepEqual(parseLine(''), [])
  assert.deepEqual(parseLine('null'), [])
  assert.deepEqual(parseLine('[]'), [])
})

test('a line with no tool calls is simply empty', () => {
  assert.deepEqual(parseLine(line([])), [])
  assert.deepEqual(parseLine(JSON.stringify({ type: 'user', message: { content: 'hi' } })), [])
})

test('a missing timestamp does not produce NaN', () => {
  const [a] = parseLine(line([use('Read', { file_path: 'a.md' })], { timestamp: undefined }))
  assert.equal(a.at, 0)
})

// ------------------------------------------------------------------ vault scope

test('a windows path resolves against a forward-slash root, case-insensitively', () => {
  // The transcript records C:\Users\... and the vault is addressed with forward
  // slashes. Getting this wrong shows every vault read as happening elsewhere.
  assert.equal(
    relativeTo('C:\\Users\\Nathan\\Desktop\\Universal Vault\\Fate\\x.md', 'C:/Users/Nathan/Desktop/Universal Vault'),
    'Fate/x.md',
  )
  assert.equal(
    relativeTo('c:/users/nathan/desktop/universal vault/a.md', 'C:/Users/Nathan/Desktop/Universal Vault'),
    'a.md',
  )
})

test('a path outside the root is refused, and a lookalike prefix is not enough', () => {
  assert.equal(relativeTo('C:/Other/x.md', 'C:/Vault'), null)
  assert.equal(relativeTo('C:/Vault-backup/x.md', 'C:/Vault'), null, 'a sibling matched by prefix')
  assert.equal(relativeTo('C:/Vault', 'C:/Vault'), '')
})

// -------------------------------------------------------------- many agents

test('two agents are kept apart, most recently active first', () => {
  // Not an edge case on this machine: there are two Claude sessions here.
  const items = parseLines([
    line([use('Read', { file_path: 'a.md' })], { sessionId: 'one', timestamp: '2026-08-23T09:00:00.000Z' }),
    line([use('Read', { file_path: 'b.md' })], { sessionId: 'two', timestamp: '2026-08-23T09:05:00.000Z' }),
    line([use('Edit', { file_path: 'c.md' })], { sessionId: 'one', timestamp: '2026-08-23T09:01:00.000Z' }),
  ])
  const s = sessions(items)
  assert.deepEqual(s.map((x) => x.session), ['two', 'one'])
  assert.equal(s[1].count, 2)
  assert.equal(s[1].last.path, 'c.md', 'the newest call for that session was not first')
})

test('subagents of one session are separate agents, not one', () => {
  // FOUND BY RUNNING FOUR AND LOOKING, not by reading the code. A subagent
  // writes its own transcript but inherits its parent's sessionId, so grouping
  // on that showed four concurrent agents as a single row — which is precisely
  // the thing the panel exists to show.
  const sub = (agentId, file) =>
    line([use('Read', { file_path: file })], {
      agentId,
      slug: `name-${agentId}`,
      sessionId: 'parent-session',
    })
  const s = sessions(parseLines([sub('a1', 'x.md'), sub('a2', 'y.md'), sub('a3', 'z.md')]))
  assert.equal(s.length, 3, 'subagents collapsed into one row again')
  assert.deepEqual(s.map((x) => x.session).sort(), ['a1', 'a2', 'a3'])
})

test('a subagent names its parent; a top-level session has none', () => {
  const [child] = parseLine(
    line([use('Read', { file_path: 'x.md' })], { agentId: 'a1', sessionId: 'parent' }),
  )
  assert.equal(child.session, 'a1')
  assert.equal(child.parent, 'parent')

  const [top] = parseLine(line([use('Read', { file_path: 'x.md' })]))
  assert.equal(top.session, 'sess-a')
  assert.equal(top.parent, undefined)
})

test('the readable slug is preferred over a UUID, and does not flicker', () => {
  // The harness already writes a name like "humble-squishing-emerson". It is
  // free and it is what a person can actually tell apart. Taken from whichever
  // line carried it, because the newest line often has none.
  const s = sessions(
    parseLines([
      line([use('Read', { file_path: 'a.md' })], {
        agentId: 'a1',
        slug: 'humble-squishing-emerson',
        timestamp: '2026-08-23T09:00:00.000Z',
      }),
      line([use('Read', { file_path: 'b.md' })], {
        agentId: 'a1',
        timestamp: '2026-08-23T09:01:00.000Z',
      }),
    ]),
  )
  assert.equal(s[0].label, 'humble-squishing-emerson')
})

test('recent is capped, because an agent does dozens of calls a minute', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    line([use('Read', { file_path: `${i}.md` })], {
      timestamp: new Date(AT + i * 1000).toISOString(),
    }),
  )
  assert.equal(sessions(parseLines(many), 5)[0].recent.length, 5)
})

test('since() lets a tail resume without re-reporting', () => {
  const items = parseLines([
    line([use('Read', { file_path: 'old.md' })], { timestamp: '2026-08-23T09:00:00.000Z' }),
    line([use('Read', { file_path: 'new.md' })], { timestamp: '2026-08-23T09:05:00.000Z' }),
  ])
  const cut = Date.parse('2026-08-23T09:05:00.000Z')
  assert.deepEqual(since(items, cut).map((a) => a.path), ['new.md'])
})

// ------------------------------------------------------------------ the line

test('a windows path is reduced to a filename, not printed whole', () => {
  // Every fixture path in this file used forward slashes, so the `/`-only split
  // passed here and failed in the app: the panel printed
  // `reading C:\Users\Nathan\Desktop\Universal Vault\Transcripts\Roy Lee\...`
  // across three lines of every card. Found by looking at the rendered panel.
  const [a] = parseLine(
    line([use('Read', { file_path: 'C:\\Users\\Nathan\\Desktop\\Universal Vault\\Fate\\Home.md' })]),
  )
  assert.equal(describe(a), 'reading Home.md')

  // With a root, it is still just the filename, not the relative path.
  assert.equal(describe(a, 'C:/Users/Nathan/Desktop/Universal Vault'), 'reading Home.md')
})

test('the description says the thing, not the category', () => {
  const root = 'C:/Users/Nathan/Desktop/Universal Vault'
  const one = (t, input) => describe(parseLine(line([use(t, input)]))[0], root)
  assert.equal(one('Read', { file_path: `${root}/Fate/Roadmap/07 - Agents.md` }), 'reading 07 - Agents.md')
  assert.equal(one('Edit', { file_path: `${root}/Home.md` }), 'editing Home.md')
  assert.equal(one('Grep', { pattern: 'TODO' }), 'searching for TODO')
  assert.equal(one('Bash', { command: 'npm test -- --watch' }), 'running npm test')
})
