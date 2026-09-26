/**
 * The GitHub surface's logic, driven with a stub fetch. No network.
 *
 * What matters most: the device-flow request is exactly what GitHub expects
 * (no secret, `repo` scope, form-encoded), `slow_down` really slows down, a
 * rate limit stops requests rather than spending them, and "pending" counts a
 * PR's commits once.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const gh = await import('../src/shared/github.ts')

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers })

/** Records every call and answers from a list, or a function of the url. */
function stub(answers) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init })
    const a = typeof answers === 'function' ? answers(url) : answers.shift()
    if (a instanceof Error) throw a
    return a
  }
  return { f, calls }
}

// ── device flow ───────────────────────────────────────────────────

test('the device-code request is a form POST with client_id and repo scope, no secret', async () => {
  const { f, calls } = stub([
    json({
      device_code: 'dc',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 899,
      interval: 5,
    }),
  ])
  const code = await gh.requestDeviceCode(f, 'Iv1.abcdef1234')
  assert.equal(calls[0].url, 'https://github.com/login/device/code')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded')
  const body = new URLSearchParams(calls[0].init.body)
  assert.equal(body.get('client_id'), 'Iv1.abcdef1234')
  assert.equal(body.get('scope'), 'repo')
  assert.equal(body.has('client_secret'), false)
  assert.deepEqual(code, {
    deviceCode: 'dc',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 899,
    interval: 5,
  })
})

test('a verification URI off github.com is refused, never opened', async () => {
  const { f } = stub([
    json({ device_code: 'dc', user_code: 'X', verification_uri: 'https://evil.example/login' }),
  ])
  await assert.rejects(gh.requestDeviceCode(f, 'Iv1.abcdef1234'), /does not understand/)
})

// GitHub sends this error WITH a 400 (seen live 2026-09-26). The first version of
// this test used 200, which is how "(400)" with no reason reached a real user.
test('device flow switched off says which box to tick, even on a 400', async () => {
  const { f } = stub([json({ error: 'device_flow_disabled' }, 400)])
  await assert.rejects(gh.requestDeviceCode(f, 'Iv1.abcdef1234'), /Enable Device Flow/)
})

test('an unknown Client ID (404) says to copy it again', async () => {
  const { f } = stub([new Response('Not Found', { status: 404 })])
  await assert.rejects(gh.requestDeviceCode(f, 'Ov23liAAAAAAAAAAAAAA'), /does not know this Client ID/)
})

test('a client secret is never accepted as a Client ID', () => {
  const secret = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(gh.isClientSecret(secret), true)
  assert.equal(gh.isClientId(secret), false)
  assert.equal(gh.isClientId('Ov23liVwK2hQ9G5k3mOn'), true)
  assert.equal(gh.isClientId('Iv1.abcdef1234567890'), true)
})

test('nextPoll: pending keeps the interval, slow_down adds five, token ends it', () => {
  assert.deepEqual(gh.nextPoll(5, { error: 'authorization_pending' }), { kind: 'wait', interval: 5 })
  assert.deepEqual(gh.nextPoll(5, { error: 'slow_down' }), { kind: 'wait', interval: 10 })
  assert.deepEqual(gh.nextPoll(5, { error: 'slow_down', interval: 12 }), { kind: 'wait', interval: 12 })
  assert.deepEqual(gh.nextPoll(5, { access_token: 'gho_x' }), { kind: 'token', token: 'gho_x' })
  assert.equal(gh.nextPoll(5, { error: 'access_denied' }).kind, 'fail')
  assert.equal(gh.nextPoll(5, { error: 'expired_token' }).kind, 'fail')
  assert.equal(gh.nextPoll(5, null).kind, 'fail')
})

test('pollForToken respects interval and slow_down, then returns the token', async () => {
  const { f, calls } = stub([
    json({ error: 'authorization_pending' }),
    json({ error: 'slow_down' }),
    new Error('ECONNRESET'),
    json({ access_token: 'gho_secret' }),
  ])
  const slept = []
  let t = 0
  const token = await gh.pollForToken(
    f,
    'Iv1.abcdef1234',
    { deviceCode: 'dc', userCode: 'U', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 },
    { sleep: async (ms) => { slept.push(ms); t += ms }, now: () => t, cancelled: () => false },
  )
  assert.equal(token, 'gho_secret')
  assert.deepEqual(slept, [5000, 5000, 10000, 10000])
  const body = new URLSearchParams(calls[0].init.body)
  assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token')
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(body.get('device_code'), 'dc')
  assert.equal(body.has('client_secret'), false)
})

test('pollForToken gives up at expiry and on cancel', async () => {
  const code = { deviceCode: 'dc', userCode: 'U', verificationUri: 'https://github.com/x', expiresIn: 10, interval: 5 }
  let t = 0
  const pending = () => json({ error: 'authorization_pending' })
  await assert.rejects(
    gh.pollForToken(stub(pending).f, 'Iv1.abcdef1234', code, {
      sleep: async (ms) => { t += ms }, now: () => t, cancelled: () => false,
    }),
    /expired/,
  )
  await assert.rejects(
    gh.pollForToken(stub(pending).f, 'Iv1.abcdef1234', code, {
      sleep: async () => {}, now: () => 0, cancelled: () => true,
    }),
    /cancelled/,
  )
})

// ── rate limits ───────────────────────────────────────────────────

test('rateLimitWait reads retry-after, the reset epoch, and passes a healthy response', () => {
  const h = (o) => new Headers(o)
  assert.equal(gh.rateLimitWait(200, h({ 'x-ratelimit-remaining': '4000' }), 0), 0)
  assert.equal(gh.rateLimitWait(403, h({ 'retry-after': '30' }), 0), 30_000)
  assert.equal(gh.rateLimitWait(403, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }), 40_000), 60_000)
  // A 200 that spent the last request blocks the NEXT one until reset.
  assert.equal(gh.rateLimitWait(200, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }), 90_000), 10_000)
  assert.equal(gh.rateLimitWait(429, h({}), 0), 60_000)
  assert.equal(gh.rateLimitWait(404, h({}), 0), 0)
})

test('a rate-limited client stops sending until the reset, and sends the token as Bearer', async () => {
  let t = 1_000_000
  const { f, calls } = stub([
    json({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(t / 1000 + 60) }),
    json([]),
  ])
  const c = gh.client(f, 'gho_tok', () => t)
  await assert.rejects(c.get('/user/repos'), gh.RateLimited)
  await assert.rejects(c.get('/user/repos'), gh.RateLimited)
  assert.equal(calls.length, 1, 'a second request went out while blocked')
  assert.equal(calls[0].init.headers.authorization, 'Bearer gho_tok')
  t += 61_000
  assert.deepEqual(await c.get('/user/repos'), [])
  assert.equal(calls.length, 2)
})

test('errors never carry the token', async () => {
  const { f } = stub([json({}, 500), json({}, 401)])
  const c = gh.client(f, 'gho_SECRET', () => 0)
  for (let i = 0; i < 2; i++) {
    await assert.rejects(c.get('/x?y=1'), (e) => !e.message.includes('gho_SECRET'))
  }
})

// ── agents ────────────────────────────────────────────────────────

test('agent detection: the trailer or the branch prefix', () => {
  assert.ok(gh.isAgentCommit('fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'))
  assert.ok(gh.isAgentCommit('fix\n\nco-authored-by: claude <x>'))
  assert.ok(!gh.isAgentCommit('Claude is mentioned in the subject'))
  assert.ok(!gh.isAgentCommit('fix\n\nCo-Authored-By: Nathan <n@x>'))
  for (const b of ['claude/x', 'hands/y', 'bench/real-A']) assert.ok(gh.isAgentBranch(b), b)
  for (const b of ['main', 'feature/claude', 'handsome/x']) assert.ok(!gh.isAgentBranch(b), b)
})

test('active now means under 30 minutes, and never a future time', () => {
  const now = 10_000_000
  assert.ok(gh.isActive([now - 29 * 60_000], now))
  assert.ok(!gh.isActive([now - 31 * 60_000], now))
  assert.ok(!gh.isActive([now + 60_000], now))
  assert.ok(!gh.isActive([], now))
})

test('names that could walk off the API path are refused', () => {
  for (const s of ['..', '.', 'a/b', '', 'a b', '../x']) assert.ok(!gh.isName(s), s)
  assert.ok(gh.isName('agent-workspace'))
  assert.ok(gh.isSha('1e018ca'))
  assert.ok(!gh.isSha('../../x'))
})

// ── the per-repo pass ─────────────────────────────────────────────

test('repoActivity aggregates landed, pending (once per PR), runs and active-now', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z')
  const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString()
  const commit = (sha, message, minsAgo, login = 'Nathan5674312') => ({
    sha,
    author: { login },
    commit: { message, author: { name: 'N', date: iso(minsAgo) }, committer: { date: iso(minsAgo) } },
  })
  const routes = {
    '/repos/o/r/commits?': [
      commit('a1', 'landed by agent\n\nCo-Authored-By: Claude <x>', 10),
      commit('a2', 'older human commit', 2 * 24 * 60),
    ],
    '/repos/o/r/branches?': [{ name: 'main' }, { name: 'claude/feat' }, { name: 'stale' }, { name: 'topic' }],
    '/repos/o/r/compare/main...claude%2Ffeat': {
      ahead_by: 3,
      behind_by: 1,
      commits: [commit('b1', 'wip', 50), commit('b2', 'wip 2', 45)],
    },
    '/repos/o/r/compare/main...stale': { ahead_by: 0, behind_by: 9, commits: [] },
    '/repos/o/r/compare/main...topic': { ahead_by: 2, behind_by: 0, commits: [commit('c1', 'human', 5)] },
    '/repos/o/r/pulls?': [
      { number: 7, title: 'Feat', html_url: 'https://github.com/o/r/pull/7', head: { ref: 'claude/feat', repo: { full_name: 'o/r' } } },
      { number: 8, title: 'Fork', html_url: 'https://github.com/o/r/pull/8', head: { ref: 'main', repo: { full_name: 'x/r' } } },
    ],
    '/repos/o/r/actions/runs?': {
      workflow_runs: [{ name: 'CI', head_branch: 'claude/feat', html_url: 'https://github.com/o/r/actions/runs/1', run_started_at: iso(2) }],
    },
  }
  const { f, calls } = stub((url) => {
    const path = url.slice(gh.API.length)
    const key = Object.keys(routes).find((k) => (k.endsWith('?') ? path.startsWith(k) : path === k))
    return key ? json(routes[key]) : json({}, 404)
  })
  const a = await gh.repoActivity(gh.client(f, 't', () => now), 'o', 'r', 'main', now)

  assert.equal(a.landed7d, 2)
  assert.equal(a.landed24h, 1)
  assert.ok(a.landed[0].agent && !a.landed[1].agent)
  assert.deepEqual(a.branches.map((b) => [b.name, b.ahead, b.behind, b.agent]), [
    ['topic', 2, 0, false],
    ['claude/feat', 3, 1, true],
  ])
  assert.equal(a.pending, 5, 'branch commits, not branch + PR')
  assert.deepEqual(a.pulls.map((p) => [p.number, p.ahead]), [[7, 3], [8, null]])
  assert.equal(a.runs.length, 1)
  assert.equal(a.activeNow, true)
  assert.ok(calls.some((c) => c.url.includes(`since=${new Date(now - 7 * 864e5).toISOString()}`)))
  assert.ok(!calls.some((c) => c.url.includes('compare/main...main')), 'default branch compared to itself')
})

test('active-now is false when agent work is old, even with fresh human commits', async () => {
  const now = Date.parse('2026-09-26T12:00:00Z')
  const iso = (m) => new Date(now - m * 60_000).toISOString()
  const { f } = stub((url) => {
    if (url.includes('/commits?')) {
      return json([
        { sha: 'a', commit: { message: 'x\n\nCo-Authored-By: Claude', committer: { date: iso(90) } } },
        { sha: 'b', commit: { message: 'human', committer: { date: iso(1) } } },
      ])
    }
    return json(url.includes('/actions/') ? { workflow_runs: [] } : [])
  })
  const a = await gh.repoActivity(gh.client(f, 't', () => now), 'o', 'r', 'main', now)
  assert.equal(a.activeNow, false)
  assert.equal(a.pending, 0)
})

test('parseFiles and parseRepos drop what does not validate', () => {
  assert.deepEqual(
    gh.parseFiles({ files: [{ filename: 'a.ts', additions: 1, deletions: 2 }, { filename: 'b', additions: -1, deletions: 0 }, null] }),
    [{ path: 'a.ts', added: 1, removed: 2 }],
  )
  assert.deepEqual(
    gh.parseRepos([
      { name: 'r', owner: { login: 'o' }, private: true, pushed_at: '2026-09-26T00:00:00Z', default_branch: 'trunk' },
      { name: '../x', owner: { login: 'o' } },
    ]),
    [{ owner: 'o', name: 'r', private: true, pushedAt: Date.parse('2026-09-26T00:00:00Z'), defaultBranch: 'trunk' }],
  )
})
