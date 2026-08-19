/**
 * The terminal command table — src/shared/terminal.ts.
 *
 * The table's rule is that nothing in it lies. A command either runs today, or
 * is a real commitment that says what it still needs — and anything that could
 * never work here is absent rather than listed and refusing.
 *
 * These tests hold that from both ends, because the failure is silent either
 * way: a command marked ready with no implementation prints an internal error
 * at the user, and one marked planned with no reason is indistinguishable from
 * one that is simply broken.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMANDS,
  GROUP_LABEL,
  GROUP_ORDER,
  findCommand,
  parseInput,
} from '../src/shared/terminal.ts'

test('a command that is not built yet says what it needs', () => {
  // THE HONESTY RULE, and the whole reason `state` exists. A command that
  // refuses without a reason is the silent no-op that docs/buttons/ was written
  // to remove — the same defect as a button with no handler, one layer in.
  for (const c of COMMANDS) {
    if (c.state === 'ready') continue
    assert.ok(
      c.note && c.note.length > 10,
      `/${c.name} is ${c.state} but gives no reason`,
    )
  }
})

test('nothing in the table can never work here', () => {
  // The table used to carry a third state for commands belonging to another
  // product. Those are deleted now, not greyed out: a command that can never
  // act is a control that lies, and /help should not read as another app's
  // feature list.
  for (const c of COMMANDS) {
    assert.ok(
      c.state === 'ready' || c.state === 'planned',
      `/${c.name} has state ${c.state}`,
    )
  }
})

test('EVERY ready command is actually implemented in the panel', () => {
  // The failure this prevents, concretely: eight commands were marked ready
  // while TerminalView had no branch for them, so typing one would have hit the
  // default arm and printed "marked ready but has no implementation" at the
  // user. Ready has to mean ready.
  const view = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'panes', 'vault', 'TerminalView.tsx'),
    'utf8',
  )
  for (const c of COMMANDS.filter((c) => c.state === 'ready')) {
    assert.match(
      view,
      new RegExp(`case '${c.name}':`),
      `/${c.name} claims ready but TerminalView has no branch for it`,
    )
  }
})

test('ready commands do not carry an excuse', () => {
  // A `note` on a working command is a contradiction, and it would be rendered
  // to the user beside a command that works fine.
  for (const c of COMMANDS.filter((c) => c.state === 'ready')) {
    assert.equal(c.note, undefined, `/${c.name} is ready but explains itself`)
  }
})

test('no command is defined twice, and no alias collides', () => {
  // Aliases share one entry by construction, so a collision here means two
  // DIFFERENT commands claim the same word and one of them is unreachable.
  const seen = new Map()
  for (const c of COMMANDS) {
    for (const n of [c.name, ...(c.aliases ?? [])]) {
      assert.ok(!seen.has(n), `"${n}" is claimed by /${seen.get(n)} and /${c.name}`)
      seen.set(n, c.name)
    }
  }
})

test('every command lands in a group /help renders', () => {
  // A group missing from GROUP_ORDER is a section of the table that /help would
  // silently never print.
  for (const c of COMMANDS) {
    assert.ok(GROUP_ORDER.includes(c.group), `/${c.name} is in unrendered group ${c.group}`)
    assert.ok(GROUP_LABEL[c.group], `group ${c.group} has no label`)
  }
})

test('aliases resolve to the same entry, so states cannot drift', () => {
  assert.equal(findCommand('bg'), findCommand('background'))
  assert.equal(findCommand('exit'), findCommand('quit'))
  assert.equal(findCommand('tasks'), findCommand('agents'))
})

test('lookup tolerates the slash and the case the user actually types', () => {
  assert.equal(findCommand('/HELP')?.name, 'help')
  assert.equal(findCommand('  /Agents  ')?.name, 'agents')
  assert.equal(findCommand('nope'), null)
})

test('the agent controls this pass adds are ready', () => {
  // These are the terminal's reason to exist; if one regresses to `planned`
  // the feature is gone and nothing else would notice.
  for (const n of ['help', 'agents', 'kill', 'clear', 'status', 'mem', 'quit']) {
    assert.equal(findCommand(n)?.state, 'ready', `/${n} is no longer ready`)
  }
})

// ------------------------------------------------------------------ parsing

test('parseInput separates shell, command and prompt', () => {
  assert.deepEqual(parseInput(''), { kind: 'empty' })
  assert.deepEqual(parseInput('   '), { kind: 'empty' })
  assert.deepEqual(parseInput('!git status'), { kind: 'shell', command: 'git status' })
  assert.deepEqual(parseInput('what does this repo do'), {
    kind: 'prompt',
    text: 'what does this repo do',
  })

  const cmd = parseInput('/kill abc123')
  assert.equal(cmd.kind, 'command')
  assert.equal(cmd.name, 'kill')
  assert.equal(cmd.arg, 'abc123')
  assert.equal(cmd.command?.name, 'kill')
})

test('an unknown slash command parses as a command with no entry', () => {
  // NOT as a prompt. Sending `/nope` to the agent as if it were a question is
  // how a typo becomes a billed turn.
  const p = parseInput('/nope')
  assert.equal(p.kind, 'command')
  assert.equal(p.command, null)
})

test('the shell escape is its own kind, and cannot be reached any other way', () => {
  // The consent gate keys on `kind: 'shell'`. If a bare prompt or a slash
  // command could ever produce one, the gate would have a hole in it.
  for (const input of ['git status', '/git status', '/!git', 'echo !bang']) {
    assert.notEqual(parseInput(input).kind, 'shell', `"${input}" reached the shell path`)
  }
  assert.equal(parseInput('!').kind, 'empty', 'a bare ! is not a command to run')
  assert.equal(parseInput('!   ').kind, 'empty')
})
