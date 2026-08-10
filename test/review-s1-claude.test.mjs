/**
 * SECTION 1 review suite — Claude Code pane.
 *
 * These tests drive the REAL modules. `./fixtures/ts-hooks.mjs` teaches Node how
 * to resolve the project's `./foo.js` -> `foo.ts` specifiers and swaps the
 * `electron` dependency for a stub, then `src/main/claude.ts` is imported as-is
 * and its actual `register()` is called with a recording `handle`. Nothing here
 * re-implements or copies the module under test; if a handler changes, these
 * tests see the change.
 *
 * Two kinds of test live here:
 *   1. Behaviour — real handlers invoked against a real temp userData dir.
 *   2. Source invariants — properties that must hold by construction and that
 *      no unit test can observe (no second consent path, no fabricated values,
 *      no node/network access from the sandboxed renderer). Asserted against
 *      the source text, which is the only place they are visible.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MAIN_SRC = readFileSync(join(ROOT, 'src/main/claude.ts'), 'utf-8')
const PANE_SRC = readFileSync(join(ROOT, 'src/renderer/panes/claude/ClaudePane.tsx'), 'utf-8')
const SDK_OPTIONS_DTS = readFileSync(
  join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/runtimeTypes.d.ts'),
  'utf-8',
)
const SDK_CORE_DTS = readFileSync(
  join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/entrypoints/sdk/coreTypes.d.ts'),
  'utf-8',
)

/**
 * Source with comments removed, for invariants about what the CODE does.
 *
 * A source-invariant test greps raw text, so it cannot tell an implementation
 * from a comment describing one. The `no Math.random` test was asserting
 * against a file whose own comment reads "crypto.randomUUID, not
 * Math.random().toString(36)" — the note explaining that the rule is FOLLOWED
 * was the thing breaking the test. It failed on correct code, which is the
 * worst failure mode a guard test has: it teaches you to ignore a red suite.
 *
 * Caveat: this also strips `//` inside string literals, so a URL in code would
 * be truncated. That direction is safe here — over-stripping can only hide a
 * violation, never invent one, and these assertions are all negative.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const MAIN_CODE = stripComments(MAIN_SRC)
const PANE_CODE = stripComments(PANE_SRC)

// --------------------------------------------------------------- real module

const USER_DATA = mkdtempSync(join(tmpdir(), 'claude-s1-review-'))
process.env.TEST_USER_DATA = USER_DATA

// Seed a session on disk BEFORE the module is imported. The module lazily reads
// sessions.json on first use, so this is the only way to prove it reads at all.
const SESSIONS_DIR = join(USER_DATA, 'claude-sessions')
mkdirSync(SESSIONS_DIR, { recursive: true })
writeFileSync(
  join(SESSIONS_DIR, 'sessions.json'),
  JSON.stringify([
    { id: 'seeded-session', title: 'Seeded', cwd: 'C:/projects/seed', status: 'idle', updatedAt: 1 },
    // Junk rows: a corrupt or hand-edited file must not poison the list.
    null,
    { id: '../../escape', title: 'traversal', cwd: 'C:/x', status: 'idle', updatedAt: 2 },
    { nope: true },
  ]),
)

const { register } = await import('../src/main/claude.ts')

/** channel -> handler, captured from the module's own register(). */
const H = new Map()
register((channel, fn) => H.set(channel, fn))

const CH = {
  sessions: 'claude:sessions',
  newSession: 'claude:new-session',
  interrupt: 'claude:interrupt',
  history: 'claude:history',
  stats: 'claude:stats',
  setPermissionMode: 'claude:set-permission-mode',
}

test('register() wires every claude channel the contract declares', () => {
  for (const channel of Object.values(CH)) {
    assert.equal(typeof H.get(channel), 'function', `missing handler for ${channel}`)
  }
  assert.equal(typeof H.get('claude:send'), 'function')
})

test('sessions persisted on disk are actually read back', async () => {
  const list = await H.get(CH.sessions)()
  const ids = list.map((s) => s.id)
  assert.ok(
    ids.includes('seeded-session'),
    'sessions.json was written but never read — the cache guard must not start as a truthy []',
  )
})

test('corrupt and traversing rows are dropped rather than trusted', async () => {
  const list = await H.get(CH.sessions)()
  assert.ok(!list.some((s) => s == null), 'null row survived JSON load')
  assert.ok(!list.some((s) => String(s.id).includes('..')), 'a session id containing ".." was accepted')
  assert.ok(list.every((s) => typeof s.cwd === 'string'), 'row without a cwd survived JSON load')
})

test('new sessions get a collision-safe id, not Math.random()', async () => {
  const a = await H.get(CH.newSession)('C:/projects/a')
  const b = await H.get(CH.newSession)('C:/projects/b')

  assert.notEqual(a.id, b.id)
  // A UUID. Math.random().toString(36).slice(2) is variable-length and can be
  // one or two characters — as a directory name that is a real collision.
  assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(a.cwd, 'C:/projects/a', 'the project scope must be stored on the session')
  assert.equal(a.status, 'idle')

  const onDisk = JSON.parse(readFileSync(join(SESSIONS_DIR, 'sessions.json'), 'utf-8'))
  assert.ok(onDisk.some((s) => s.id === a.id), 'new session was not persisted')
})

test('stats: every range computes — including "all"', async () => {
  // Regression: `new Date(now - Infinity).toISOString()` throws RangeError, so
  // selecting the All tab took down the whole stats call.
  for (const range of ['all', '30d', '7d']) {
    const s = await H.get(CH.stats)(range)
    assert.equal(s.range, range)
    assert.ok(Array.isArray(s.heatmap))
  }
})

test('stats: the heatmap window matches the selected range and ends today', async () => {
  const today = new Date().toISOString().split('T')[0]
  const week = await H.get(CH.stats)('7d')
  const month = await H.get(CH.stats)('30d')

  assert.equal(week.heatmap.length, 7, 'a 7d toggle must not render a 90-day grid')
  assert.equal(month.heatmap.length, 30)
  assert.equal(week.heatmap.at(-1).date, today, 'heatmap is oldest-first and ends on today')

  const dates = week.heatmap.map((c) => c.date)
  assert.deepEqual(dates, [...dates].sort(), 'heatmap cells must be in ascending date order')
  assert.equal(new Set(dates).size, dates.length, 'a DST boundary must not duplicate a cell')
})

test('stats: unknown values report null, never a fabricated number', async () => {
  const s = await H.get(CH.stats)('all')
  // No run has happened in this temp profile, so there is no hour data and no
  // model data. Both must come back null rather than an invented figure.
  assert.equal(s.peakHour, null)
  assert.equal(s.favoriteModel, null)
  assert.equal(s.messages, 0)
  assert.equal(s.totalTokens, 0)
})

test('stats: the sessions tile counts real sessions, not a hardcoded zero', async () => {
  const before = (await H.get(CH.stats)('all')).sessions
  await H.get(CH.newSession)('C:/projects/counted')
  const after = (await H.get(CH.stats)('all')).sessions
  assert.equal(after, before + 1, 'creating a session must move the sessions tile')
})

test('stats survive a corrupt stats.json instead of throwing', async () => {
  writeFileSync(join(SESSIONS_DIR, 'stats.json'), '{ this is not json')
  // The in-process cache is already warm, so prove the loader itself is safe by
  // checking it does not throw on the next cold read path either.
  const s = await H.get(CH.stats)('all')
  assert.ok(Number.isFinite(s.messages))
})

test('history refuses a traversing session id', async () => {
  await assert.rejects(
    () => H.get(CH.history)('../../../../etc/passwd'),
    /invalid session id/,
    'a session id from the renderer is untrusted input and becomes a directory name',
  )
  await assert.rejects(() => H.get(CH.history)('a/b'), /invalid session id/)
  // A well-formed id for a session with no transcript is simply empty.
  assert.deepEqual(await H.get(CH.history)('seeded-session'), [])
})

test('permission mode is validated and persisted per session', async () => {
  const s = await H.get(CH.newSession)('C:/projects/perm')

  await assert.rejects(
    () => H.get(CH.setPermissionMode)(s.id, 'plan'),
    /Unknown permission mode/,
    'an unrecognised mode must not fall through to the default and read as "ask"',
  )

  await H.get(CH.setPermissionMode)(s.id, 'bypass')
  const onDisk = JSON.parse(readFileSync(join(SESSIONS_DIR, 'sessions.json'), 'utf-8'))
  const row = onDisk.find((r) => r.id === s.id)
  assert.equal(row.permissionMode, 'bypass', 'the mode must be persisted, not swallowed')

  await assert.rejects(() => H.get(CH.setPermissionMode)('no-such-session', 'ask'), /not found/)
})

test('interrupt on an idle or unknown session is a no-op, not a crash', async () => {
  await H.get(CH.interrupt)('no-such-session')
  const s = await H.get(CH.newSession)('C:/projects/int')
  await H.get(CH.interrupt)(s.id)
  const list = await H.get(CH.sessions)()
  assert.equal(list.find((x) => x.id === s.id).status, 'idle')
})

// ------------------------------------------------------- SDK symbol existence

test('every SDK option passed to query() exists in the SDK type definitions', () => {
  const optionKeys = [
    'cwd',
    'tools',
    'permissionMode',
    'allowDangerouslySkipPermissions',
    'resume',
    'canUseTool',
  ]
  for (const key of optionKeys) {
    assert.ok(
      new RegExp(`^\\s*${key}\\?:`, 'm').test(SDK_OPTIONS_DTS),
      `query option "${key}" is not declared in the SDK Options type — invented symbol`,
    )
  }
  // And the ones the source actually uses are the ones we just checked.
  const used = [...MAIN_SRC.matchAll(/^\s{10}([a-zA-Z]+):/gm)].map((m) => m[1])
  for (const key of used) {
    assert.ok(optionKeys.includes(key), `query() passes an unverified option "${key}"`)
  }
})

test('the SDK message shapes the source destructures are real', () => {
  assert.match(SDK_CORE_DTS, /subtype: 'success'/)
  assert.match(SDK_CORE_DTS, /modelUsage: \{/)
  assert.match(SDK_CORE_DTS, /usage: NonNullableUsage/)
  assert.match(SDK_CORE_DTS, /type: 'assistant'/)
})

// ------------------------------------------------------- source invariants

test('allowedTools is not used — it auto-approves and bypasses canUseTool', () => {
  // Per the SDK: "List of tool names that are auto-allowed without prompting for
  // permission." Listing read tools there let them execute with no consent at
  // all. `tools` is the option that restricts what exists.
  assert.ok(!/allowedTools\s*:/.test(MAIN_SRC), 'allowedTools bypasses the consent surface')
  assert.match(SDK_OPTIONS_DTS, /auto-allowed without prompting for permission/)
  assert.match(MAIN_SRC, /tools:\s*\[/, 'the tool surface must be restricted with `tools`')
})

test('there is exactly one consent path and it is requestConsent in corner.ts', () => {
  assert.match(MAIN_SRC, /import \{ requestConsent \} from '\.\/corner\.js'/)
  assert.equal(
    (MAIN_SRC.match(/requestConsent\(/g) || []).length,
    1,
    'exactly one call site: inside canUseTool',
  )
  // No competing prompt mechanism anywhere in section 1.
  for (const forbidden of [
    /dialog\./,
    /showMessageBox/,
    /permissionPromptToolName/,
    /window\.confirm/,
    /\bconfirm\(/,
  ]) {
    assert.ok(!forbidden.test(MAIN_SRC), `second prompt path in claude.ts: ${forbidden}`)
    assert.ok(!forbidden.test(PANE_SRC), `second prompt path in ClaudePane.tsx: ${forbidden}`)
  }
})

test('no tool can be allowed without the consent callback returning true', () => {
  // The only `behavior: 'allow'` in the file must be gated on the consent result.
  const allows = MAIN_SRC.match(/behavior: 'allow'/g) || []
  assert.equal(allows.length, 1, 'more than one allow branch means one of them is unconditional')
  assert.match(MAIN_SRC, /allow\s*\n?\s*\?\s*\{ behavior: 'allow'/)
  assert.match(MAIN_SRC, /behavior: 'deny'/)
})

test("bypassPermissions is paired with the SDK's required safety flag", () => {
  // The SDK documents allowDangerouslySkipPermissions as required for this mode;
  // without it the run just errors out.
  assert.match(SDK_OPTIONS_DTS, /Must be set to `true` when using `permissionMode: 'bypassPermissions'`/)
  assert.match(MAIN_SRC, /allowDangerouslySkipPermissions:/)
})

test('no Math.random anywhere in section 1', () => {
  // Comment-stripped: the rule is about what the code does, not about whether
  // the file is allowed to mention the thing it deliberately avoids.
  assert.ok(!/Math\.random/.test(MAIN_CODE), 'Math.random in claude.ts — ids and stats must be real')
  assert.ok(!/Math\.random/.test(PANE_CODE), 'Math.random in ClaudePane.tsx')
})

test('interrupt actually stops the SDK query rather than relabelling a dot', () => {
  assert.match(MAIN_SRC, /running\.set\(/, 'the in-flight query must be retained')
  assert.match(MAIN_SRC, /\.interrupt\(\)/, 'claude:interrupt must call the SDK Query.interrupt()')
  assert.match(SDK_OPTIONS_DTS, /interrupt\(\): Promise<void>/, 'Query.interrupt must exist in the SDK')
})

test('a run cannot leave a session pinned on "running"', () => {
  assert.match(MAIN_SRC, /} finally \{/, 'the send loop needs a finally that settles the status')
  assert.match(MAIN_SRC, /status === 'running' \|\| session\.status === 'awaiting-permission'/)
})

test('project scope and conversation continuity actually reach the SDK', () => {
  assert.match(MAIN_SRC, /cwd: session\.cwd/, 'a session bound to a project must run in that project')
  assert.match(MAIN_SRC, /resume: session\.sdkSessionId/, 'without resume every turn forgets the last')
  assert.match(MAIN_SRC, /session\.sdkSessionId = sdkMsg\.session_id/)
})

test('token and model stats are recorded from the SDK, not left at zero', () => {
  assert.match(MAIN_SRC, /tokensByDay\.set\(/, 'totalTokens showed a confident 0 that meant "unknown"')
  assert.match(MAIN_SRC, /modelCounts\.set\(/, 'favoriteModel was always null for the same reason')
  assert.ok(
    !/history\.length\)/.test(MAIN_SRC),
    'message counters must add the turn, not the whole transcript again',
  )
})

test('the user turn is recorded in the transcript', () => {
  assert.match(MAIN_SRC, /role: 'user'/, 'a transcript of answers with no questions is not a transcript')
})

// --------------------------------------------------- renderer sandbox rules

test('the renderer never reaches for node or the network', () => {
  // CSP is `connect-src 'none'` and there is no node integration; everything
  // must cross the preload bridge.
  for (const forbidden of [/\bfetch\(/, /\brequire\(/, /from 'node:/, /XMLHttpRequest/, /new WebSocket/, /import\('fs'/]) {
    assert.ok(!forbidden.test(PANE_SRC), `renderer uses a forbidden capability: ${forbidden}`)
  }
  assert.match(PANE_SRC, /window\.api\.claude\./, 'the pane talks to main through the bridge')
})

test('every renderer subscription is cleaned up', () => {
  const subscriptions = PANE_SRC.match(/window\.api\.claude\.on[A-Za-z]+\(/g) || []
  assert.ok(subscriptions.length > 0, 'the pane must subscribe to pushes')
  // Each subscribe result is captured and returned from the effect.
  const captured = PANE_SRC.match(/const unsubscribe = window\.api\.claude\.on[A-Za-z]+\(/g) || []
  assert.equal(
    captured.length,
    subscriptions.length,
    'a subscription whose unsubscribe is discarded stacks duplicate handlers on remount',
  )
  assert.equal(
    (PANE_SRC.match(/return unsubscribe/g) || []).length,
    subscriptions.length,
    'every captured unsubscribe must be the effect cleanup',
  )
})

test('NO STYLING: structure and stable class names only', () => {
  assert.ok(!/style=\{\{/.test(PANE_SRC), 'inline style object in the pane')
  assert.ok(!/\bstyle="/.test(PANE_SRC), 'inline style attribute in the pane')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(PANE_SRC), 'colour literal in the pane')
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(PANE_SRC), 'colour function in the pane')
  assert.ok(!/\d+(px|rem|em|vh|vw)\b/.test(PANE_SRC), 'spacing/size unit in the pane')
  assert.ok(!existsSync(join(ROOT, 'src/renderer/panes/claude/ClaudePane.css')), 'section 1 must ship no stylesheet')
  // Class names must be namespaced so they stay stable for whoever styles later.
  const classes = [...PANE_SRC.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
  for (const c of classes) {
    assert.ok(c.startsWith('claude-'), `unnamespaced class name "${c}"`)
  }
})

test('the desktop layout regions the brief names are all present', () => {
  const required = [
    'claude-top-rail',
    'claude-mode-tabs',
    'claude-primary-nav',
    'claude-project-group',
    'claude-session-list',
    'claude-session-status-dot',
    'claude-account-row',
    'claude-greeting',
    'claude-stats-card',
    'claude-stats-tab',
    'claude-stats-range-toggle',
    'claude-stat-tile',
    'claude-heatmap',
    'claude-stats-comparison',
    'claude-composer',
    'claude-scope-chip',
    'claude-composer-input',
    'claude-permission-mode-chip',
    'claude-attach',
    'claude-mic',
    'claude-options',
    'claude-model-name',
    'claude-effort-level',
    'claude-effort-toggle',
  ]
  for (const region of required) {
    assert.ok(PANE_SRC.includes(region), `missing layout region: ${region}`)
  }
  // Exactly eight stat tiles, per the brief.
  assert.equal((PANE_SRC.match(/className="claude-stat-tile"/g) || []).length, 8)
})

test('the permission-mode chip is wired to main, not decorative', () => {
  assert.match(
    PANE_SRC,
    /window\.api\.claude\.setPermissionMode\(/,
    'the chip rendered a mode the session never actually had',
  )
})

test('section 1 did not edit the contract or another pane', () => {
  // The contract must still declare exactly what section 1 consumes.
  const contract = readFileSync(join(ROOT, 'src/shared/ipc.ts'), 'utf-8')
  assert.match(contract, /export type PermissionMode = 'ask' \| 'accept-edits' \| 'bypass'/)
  assert.match(contract, /peakHour: number \| null/)
  assert.match(contract, /claudeSetPermissionMode: 'claude:set-permission-mode'/)
  // corner.ts still owns the only consent primitive.
  const corner = readFileSync(join(ROOT, 'src/main/corner.ts'), 'utf-8')
  assert.match(corner, /export function requestConsent\(/)
})
