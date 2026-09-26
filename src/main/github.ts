/**
 * The GitHub surface's main-process half: the token, and the transport.
 *
 * THE TOKEN NEVER LEAVES THIS FILE. It is encrypted with `safeStorage` (DPAPI on
 * Windows) into its own file in userData — not settings.json, which is plain
 * JSON a person or a script may open — and it is never sent over IPC, never
 * logged, and never put in an error message. The renderer is told only whether
 * someone is signed in and as whom.
 *
 * Every request here is started by a person: the sign-in button, or opening the
 * GitHub surface, whose 60 s poll stops when it is hidden. Logic, and every
 * request shape, lives in src/shared/github.ts, which is pure and tested.
 */
import { app, safeStorage, shell } from 'electron'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  client,
  isClientId,
  isClientSecret,
  isName,
  isSha,
  parseFiles,
  parseRepos,
  pollForToken,
  repoActivity,
  requestDeviceCode,
  type Client,
  type DeviceCode,
  type FileChange,
  type Repo,
  type RepoActivity,
} from '../shared/github.js'
import { CH, type GitHubStatus, type GitHubSignIn } from '../shared/ipc.js'
import { getGithubClientId, setGithubClientId } from './settings.js'
import type { Handle } from './ipc.js'

const tokenPath = () => join(app.getPath('userData'), 'github-token.bin')

let token: string | null = null
let login: string | null = null
let api: Client | null = null
let pending: DeviceCode | null = null
/** Bumped on every sign-in start and sign-out, so a stale poll loop knows it lost. */
let generation = 0

function loadToken(): void {
  if (token !== null) return
  try {
    if (!safeStorage.isEncryptionAvailable()) return
    token = safeStorage.decryptString(readFileSync(tokenPath()))
    api = client(fetch, token)
  } catch {
    // Missing on first run, or undecryptable (another Windows user, a restored
    // profile). Either way: signed out.
    token = null
  }
}

function saveToken(t: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('This system cannot encrypt the sign-in, so it was not kept.')
  }
  const tmp = `${tokenPath()}.tmp`
  writeFileSync(tmp, safeStorage.encryptString(t))
  renameSync(tmp, tokenPath())
  token = t
  api = client(fetch, t)
}

function status(): GitHubStatus {
  loadToken()
  return { clientIdSet: getGithubClientId() !== null, signedIn: token !== null, login }
}

async function whoAmI(): Promise<void> {
  if (!api || login) return
  const u = (await api.get('/user').catch(() => null)) as { login?: unknown } | null
  if (typeof u?.login === 'string') login = u.login
}

async function signIn(): Promise<GitHubSignIn> {
  const clientId = getGithubClientId()
  if (!clientId) throw new Error('Paste the OAuth App Client ID first.')
  generation++
  pending = await requestDeviceCode(fetch, clientId)
  // requestDeviceCode already refused anything that is not https://github.com/.
  void shell.openExternal(pending.verificationUri)
  return {
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    expiresAt: Date.now() + pending.expiresIn * 1000,
  }
}

/** Resolves once the person has entered the code, or rejects with why not. */
async function finishSignIn(): Promise<GitHubStatus> {
  const clientId = getGithubClientId()
  const code = pending
  if (!clientId || !code) throw new Error('No sign-in in progress.')
  const mine = generation
  const t = await pollForToken(fetch, clientId, code, {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    cancelled: () => generation !== mine,
  })
  if (generation !== mine) throw new Error('Sign-in was cancelled.')
  pending = null
  saveToken(t)
  await whoAmI()
  return status()
}

function signOut(): GitHubStatus {
  generation++
  pending = null
  token = null
  login = null
  api = null
  rmSync(tokenPath(), { force: true })
  return status()
}

function need(): Client {
  loadToken()
  if (!api) throw new Error('Not signed in to GitHub.')
  return api
}

async function repos(): Promise<Repo[]> {
  const c = need()
  void whoAmI()
  return parseRepos(await c.get('/user/repos?sort=pushed&per_page=50'))
}

function activity(owner: string, name: string, defaultBranch: string): Promise<RepoActivity> {
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    throw new Error('No default branch.')
  }
  return repoActivity(need(), owner, name, defaultBranch, Date.now())
}

async function files(owner: string, name: string, sha: string): Promise<FileChange[]> {
  if (!isName(owner) || !isName(name) || !isSha(sha)) throw new Error('Not a commit.')
  return parseFiles(await need().get(`/repos/${owner}/${name}/commits/${sha}`))
}

function setClientId(id: string): GitHubStatus {
  const trimmed = String(id ?? '').trim()
  if (isClientSecret(trimmed)) {
    throw new Error('That is the client secret, not the Client ID. Fate never needs the secret; copy the Client ID above it (starts with Ov23li).')
  }
  if (trimmed !== '' && !isClientId(trimmed)) {
    throw new Error('That does not look like a GitHub Client ID.')
  }
  setGithubClientId(trimmed === '' ? null : trimmed)
  return status()
}

/** Only github.com pages: PR and workflow-run links come from the API, not from a person. */
function open(url: string): void {
  if (typeof url === 'string' && url.startsWith('https://github.com/')) void shell.openExternal(url)
}

export function register(handle: Handle): void {
  handle(CH.githubStatus, () => status())
  handle(CH.githubSetClientId, (id: string) => setClientId(id))
  handle(CH.githubSignIn, () => signIn())
  handle(CH.githubFinishSignIn, () => finishSignIn())
  handle(CH.githubSignOut, () => signOut())
  handle(CH.githubRepos, () => repos())
  handle(CH.githubActivity, (o: string, n: string, b: string) => activity(o, n, b))
  handle(CH.githubFiles, (o: string, n: string, s: string) => files(o, n, s))
  handle(CH.githubOpen, (url: string) => open(url))
}
