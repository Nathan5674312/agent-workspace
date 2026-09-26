/**
 * The GitHub surface's logic: device-flow sign-in, rate-limit backoff, and
 * turning the REST API's answers into "what are the agents doing in this repo".
 *
 * `fetch` is a PARAMETER everywhere, never the global, so `node --test` drives
 * every request shape with a stub and no network. src/main/github.ts supplies
 * the real one and owns the token; nothing here stores anything.
 *
 * Every payload is public-internet JSON and is checked field by field, the same
 * posture as changelog.ts: a field that does not validate is dropped, never
 * trusted.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export const API = 'https://api.github.com'
export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const TOKEN_URL = 'https://github.com/login/oauth/access_token'
/** Private repos are the point, and `repo` is the only scope that reads them. */
export const SCOPE = 'repo'

/** Same honest identity and pinned API version as src/main/update.ts. */
const HEADERS = {
  'user-agent': 'Fate-Desktop',
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null

// ------------------------------------------------------------------ input gates

/** GitHub client ids are `Iv1.…` / `Ov23li…`: short, no spaces, no slashes. */
export const isClientId = (s: unknown): s is string =>
  typeof s === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(s) && !isClientSecret(s)

/**
 * A client SECRET is 40 lowercase hex characters and sits right under the Client
 * ID on GitHub's page. It was pasted into the Client ID box on the first real
 * sign-in, and saved to plain settings.json, so it is refused by shape.
 */
export const isClientSecret = (s: unknown): boolean =>
  typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)

/**
 * An owner or repo name. These arrive from the renderer and are interpolated
 * into an API path, so `..` or a `/` would walk off the endpoint.
 */
export const isName = (s: unknown): s is string =>
  typeof s === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(s) && s !== '.' && s !== '..'

export const isSha = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s)

// ------------------------------------------------------------------ device flow

export type DeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** Seconds. */
  expiresIn: number
  /** Seconds between polls. */
  interval: number
}

/**
 * Ask GitHub for a user code. No client secret: device flow does not use one.
 *
 * The verification URI must be github.com, because main hands it to
 * `shell.openExternal` — a response that named another host is refused rather
 * than opened.
 */
export async function requestDeviceCode(f: Fetch, clientId: string): Promise<DeviceCode> {
  const res = await f(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': HEADERS['user-agent'],
    },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }).toString(),
  })
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null
  // The error body comes WITH a 400, so read it before judging the status; checking
  // res.ok first hid "device flow is off" behind a bare "(400)".
  if (j && str(j.error)) {
    // `device_flow_disabled` is the one people actually hit: the box was not ticked.
    throw new Error(
      j.error === 'device_flow_disabled'
        ? 'Device flow is off for this OAuth App. Tick "Enable Device Flow" in its settings.'
        : `GitHub: ${String(j.error_description ?? j.error)}`,
    )
  }
  if (res.status === 404) {
    throw new Error('GitHub does not know this Client ID. Copy it again from the OAuth App page.')
  }
  if (!res.ok || !j) throw new Error(`GitHub refused the sign-in request (${res.status}).`)
  const deviceCode = str(j.device_code)
  const userCode = str(j.user_code)
  const verificationUri = str(j.verification_uri)
  if (!deviceCode || !userCode || !verificationUri?.startsWith('https://github.com/')) {
    throw new Error('GitHub sent a sign-in response this app does not understand.')
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresIn: num(j.expires_in) ?? 900,
    interval: Math.max(num(j.interval) ?? 5, 1),
  }
}

/** One poll's outcome. Pure, so the state machine is tested without a clock. */
export type PollStep =
  | { kind: 'token'; token: string }
  | { kind: 'wait'; interval: number }
  | { kind: 'fail'; message: string }

/**
 * `authorization_pending` waits the same interval; `slow_down` MUST add 5
 * seconds (GitHub's rule, and it may send the new interval itself); anything
 * else is terminal.
 */
export function nextPoll(interval: number, j: unknown): PollStep {
  const r = (typeof j === 'object' && j !== null ? j : {}) as Record<string, unknown>
  const token = str(r.access_token)
  if (token) return { kind: 'token', token }
  switch (r.error) {
    case 'authorization_pending':
      return { kind: 'wait', interval }
    case 'slow_down':
      return { kind: 'wait', interval: num(r.interval) ?? interval + 5 }
    case 'expired_token':
      return { kind: 'fail', message: 'The code expired before it was entered. Start again.' }
    case 'access_denied':
      return { kind: 'fail', message: 'Sign-in was cancelled on GitHub.' }
    default:
      return {
        kind: 'fail',
        message: `GitHub: ${String(r.error_description ?? r.error ?? 'no token in the response')}`,
      }
  }
}

/**
 * Poll until a token, a refusal, the code's expiry, or `cancelled()`.
 * `sleep` and `now` are injected so the test runs without waiting.
 */
export async function pollForToken(
  f: Fetch,
  clientId: string,
  code: DeviceCode,
  opts: {
    sleep: (ms: number) => Promise<void>
    now: () => number
    cancelled: () => boolean
  },
): Promise<string> {
  const deadline = opts.now() + code.expiresIn * 1000
  let interval = code.interval
  while (opts.now() < deadline) {
    await opts.sleep(interval * 1000)
    if (opts.cancelled()) throw new Error('Sign-in was cancelled.')
    let j: unknown = null
    try {
      const res = await f(TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': HEADERS['user-agent'],
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: code.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      })
      j = await res.json()
    } catch {
      // A dropped connection mid-flow is not a refusal. Try again next tick.
      continue
    }
    const step = nextPoll(interval, j)
    if (step.kind === 'token') return step.token
    if (step.kind === 'fail') throw new Error(step.message)
    interval = step.interval
  }
  throw new Error('The code expired before it was entered. Start again.')
}

// ------------------------------------------------------------------ rate limits

/**
 * How long to hold off, in ms, from one response's headers. 0 means go ahead.
 *
 * Secondary limits send `retry-after`; primary ones send remaining=0 and a
 * reset epoch. A 200 with remaining=0 also blocks, so the NEXT call does not
 * spend a request finding out.
 */
export function rateLimitWait(status: number, h: Headers, now: number): number {
  const retry = Number(h.get('retry-after'))
  if ((status === 403 || status === 429) && retry > 0) return retry * 1000
  if (h.get('x-ratelimit-remaining') === '0') {
    const reset = Number(h.get('x-ratelimit-reset')) * 1000
    // 403/429 with no usable reset: GitHub's documented fallback is a minute.
    return reset > now ? reset - now : status === 200 ? 0 : 60_000
  }
  if (status === 429) return 60_000
  return 0
}

export class RateLimited extends Error {
  until: number
  constructor(until: number) {
    super(`GitHub rate limit reached. Retrying after ${new Date(until).toLocaleTimeString()}.`)
    this.until = until
  }
}

export type Client = { get: (path: string) => Promise<unknown>; blockedUntil: () => number }

/**
 * An authenticated GET with the backoff built in. While blocked it throws
 * WITHOUT a request, so a 60 s poll cannot hammer a limit it already hit.
 * 401 is its own message: the token was revoked, and the fix is signing in.
 */
export function client(f: Fetch, token: string, now: () => number = Date.now): Client {
  let blocked = 0
  return {
    blockedUntil: () => blocked,
    async get(path) {
      if (now() < blocked) throw new RateLimited(blocked)
      const res = await f(`${API}${path}`, {
        headers: { ...HEADERS, authorization: `Bearer ${token}` },
      })
      const wait = rateLimitWait(res.status, res.headers, now())
      if (wait > 0) blocked = now() + wait
      if (res.status === 401) throw new Error('GitHub no longer accepts this sign-in. Sign in again.')
      if (!res.ok) {
        if (wait > 0) throw new RateLimited(blocked)
        throw new Error(`GitHub answered ${res.status} for ${path.split('?')[0]}.`)
      }
      return res.json()
    },
  }
}

// ------------------------------------------------------------------ agents

const AGENT_TRAILER = /^co-authored-by:\s*claude\b/im
const AGENT_BRANCH = /^(claude|hands|bench)\//

export const isAgentCommit = (message: string): boolean => AGENT_TRAILER.test(message)
export const isAgentBranch = (name: string): boolean => AGENT_BRANCH.test(name)

/** "Active now" means agent work under 30 minutes old. */
export const ACTIVE_MS = 30 * 60 * 1000
export const isActive = (times: number[], now: number): boolean =>
  times.some((t) => now - t >= 0 && now - t < ACTIVE_MS)

// ------------------------------------------------------------------ shapes

export type Repo = {
  owner: string
  name: string
  private: boolean
  pushedAt: number | null
  defaultBranch: string
}

export type Commit = {
  sha: string
  subject: string
  author: string
  at: number
  agent: boolean
}

export type Branch = {
  name: string
  ahead: number
  behind: number
  /** Newest commit on the branch that the default branch lacks. */
  lastAt: number | null
  agent: boolean
}

export type PullRequest = {
  number: number
  title: string
  branch: string
  /** Null when the head lives in a fork, whose compare this app never ran. */
  ahead: number | null
  url: string
}

export type Run = { name: string; branch: string; url: string; startedAt: number | null }

export type RepoActivity = {
  landed: Commit[]
  landed24h: number
  landed7d: number
  branches: Branch[]
  pulls: PullRequest[]
  pending: number
  runs: Run[]
  activeNow: boolean
  /** Branches that were not compared because of MAX_BRANCHES. */
  skippedBranches: number
}

export type FileChange = { path: string; added: number; removed: number }

const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

export function parseRepos(raw: unknown): Repo[] {
  if (!Array.isArray(raw)) return []
  const out: Repo[] = []
  for (const r of raw as Record<string, unknown>[]) {
    const owner = str((r?.owner as Record<string, unknown> | undefined)?.login)
    const name = str(r?.name)
    if (!owner || !name || !isName(owner) || !isName(name)) continue
    out.push({
      owner,
      name,
      private: r.private === true,
      pushedAt: time(r.pushed_at),
      defaultBranch: str(r.default_branch) ?? 'main',
    })
  }
  return out
}

export function parseCommit(raw: unknown): Commit | null {
  const c = raw as Record<string, unknown> | null
  const sha = str(c?.sha)
  const inner = c?.commit as Record<string, unknown> | undefined
  const message = str(inner?.message)
  if (!sha || !message) return null
  const who = inner?.author as Record<string, unknown> | undefined
  const login = str((c?.author as Record<string, unknown> | null)?.login)
  const at = time((inner?.committer as Record<string, unknown> | undefined)?.date) ?? time(who?.date)
  return {
    sha,
    subject: message.split('\n', 1)[0].trim().slice(0, 160),
    author: login ?? str(who?.name) ?? 'unknown',
    at: at ?? 0,
    agent: isAgentCommit(message),
  }
}

export function parseFiles(raw: unknown): FileChange[] {
  const files = (raw as Record<string, unknown> | null)?.files
  if (!Array.isArray(files)) return []
  const out: FileChange[] = []
  for (const f of files as Record<string, unknown>[]) {
    const path = str(f?.filename)
    const added = num(f?.additions)
    const removed = num(f?.deletions)
    if (path && added !== null && removed !== null) out.push({ path, added, removed })
  }
  return out
}

/**
 * A repo with 200 stale branches would cost 200 compares per poll.
 * ponytail: first 30 by the API's order; cache compares by head sha if that
 * ever matters.
 */
export const MAX_BRANCHES = 30

const DAY = 24 * 60 * 60 * 1000

/** Everything the per-repo view shows, in one pass. */
export async function repoActivity(
  c: Client,
  owner: string,
  name: string,
  defaultBranch: string,
  now: number,
): Promise<RepoActivity> {
  if (!isName(owner) || !isName(name)) throw new Error('Not a repository name.')
  const base = `/repos/${owner}/${name}`
  const enc = encodeURIComponent
  const since = new Date(now - 7 * DAY).toISOString()

  const [rawCommits, rawBranches, rawPulls, rawRuns] = await Promise.all([
    c.get(`${base}/commits?sha=${enc(defaultBranch)}&since=${since}&per_page=100`),
    c.get(`${base}/branches?per_page=100`),
    c.get(`${base}/pulls?state=open&per_page=50`),
    c.get(`${base}/actions/runs?status=in_progress&per_page=20`).catch(() => null),
  ])

  const landed = (Array.isArray(rawCommits) ? rawCommits : [])
    .map(parseCommit)
    .filter((x): x is Commit => x !== null)

  const names = (Array.isArray(rawBranches) ? rawBranches : [])
    .map((b) => str((b as Record<string, unknown>)?.name))
    .filter((n): n is string => n !== null && n !== defaultBranch)
  const compared = names.slice(0, MAX_BRANCHES)

  const branches: Branch[] = []
  for (const b of await Promise.all(
    compared.map(async (n) => {
      const j = (await c
        .get(`${base}/compare/${enc(defaultBranch)}...${enc(n)}`)
        .catch(() => null)) as Record<string, unknown> | null
      if (!j) return null
      const commits = (Array.isArray(j.commits) ? j.commits : [])
        .map(parseCommit)
        .filter((x): x is Commit => x !== null)
      const ahead = num(j.ahead_by) ?? 0
      return {
        name: n,
        ahead,
        behind: num(j.behind_by) ?? 0,
        lastAt: commits.reduce<number | null>((m, x) => (m === null || x.at > m ? x.at : m), null),
        agent: isAgentBranch(n) || commits.some((x) => x.agent),
      }
    }),
  )) {
    if (b && b.ahead > 0) branches.push(b)
  }
  branches.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  const aheadOf = new Map(branches.map((b) => [b.name, b.ahead]))
  const pulls: PullRequest[] = []
  for (const p of (Array.isArray(rawPulls) ? rawPulls : []) as Record<string, unknown>[]) {
    const n = num(p?.number)
    const head = p?.head as Record<string, unknown> | undefined
    const ref = str(head?.ref)
    const url = str(p?.html_url)
    if (n === null || !ref || !url?.startsWith('https://github.com/')) continue
    const sameRepo =
      str((head?.repo as Record<string, unknown> | null)?.full_name) === `${owner}/${name}`
    pulls.push({
      number: n,
      title: str(p.title) ?? `#${n}`,
      branch: ref,
      ahead: sameRepo ? (aheadOf.get(ref) ?? 0) : null,
      url,
    })
  }

  const runs: Run[] = []
  const wf = (rawRuns as Record<string, unknown> | null)?.workflow_runs
  for (const r of (Array.isArray(wf) ? wf : []) as Record<string, unknown>[]) {
    const url = str(r?.html_url)
    if (!url?.startsWith('https://github.com/')) continue
    runs.push({
      name: str(r.name) ?? 'workflow',
      branch: str(r.head_branch) ?? '',
      url,
      startedAt: time(r.run_started_at) ?? time(r.created_at),
    })
  }

  const agentTimes = [
    ...landed.filter((x) => x.agent).map((x) => x.at),
    ...branches.filter((b) => b.agent && b.lastAt !== null).map((b) => b.lastAt as number),
  ]

  return {
    landed,
    landed24h: landed.filter((x) => now - x.at < DAY).length,
    landed7d: landed.length,
    branches,
    pulls,
    // Branches, not PRs: a same-repo PR's commits ARE its branch's, and
    // adding both would count them twice.
    pending: branches.reduce((s, b) => s + b.ahead, 0),
    runs,
    activeNow: isActive(agentTimes, now),
    skippedBranches: names.length - compared.length,
  }
}
