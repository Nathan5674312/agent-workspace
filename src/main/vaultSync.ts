/**
 * KEEP THE VAULT AND ITS GITHUB REPO THE SAME, while Fate is open.
 *
 * Nathan's setup, not a product default: his vault is a git repo with a
 * private remote, agents work in it on this machine AND in the cloud against
 * the remote, and he wants either side's work on the other without lifting a
 * finger. So, when the setting is on: once at launch, then every two minutes,
 *   1. commit local changes, but only once nothing has been touched for 30 s,
 *      so an agent's half-written note is never captured mid-write;
 *   2. fetch, and merge whatever the remote has;
 *   3. push.
 * Conflicts never stop it and never lose anything; the rules are in
 * shared/gitsync.ts.
 *
 * Off by default, and inert on any vault that is not the top of a git repo with
 * a remote branch: a user whose vault happens to be a repo must never find their
 * notes committed and pushed because they installed an app.
 *
 * It runs git, the user's own, with the user's own credentials. Nothing here
 * holds a token.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import { EV } from '../shared/ipc.js'
import {
  INTERVAL_MS,
  IDLE,
  QUIET_MS,
  changedPaths,
  conflictName,
  resolution,
  summarise,
  type SyncStatus,
} from '../shared/gitsync.js'
import { getVaultDir, invalidateGraph } from './vault.js'

type Git = (args: string[]) => Promise<string>

const gitIn = (cwd: string): Git => (args) =>
  new Promise((done, fail) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      // Both streams on failure: git says some refusals ("nothing to commit")
      // on stdout, and the caller has to be able to tell them apart.
      (err, stdout, stderr) => (err ? fail(new Error(`${stderr}\n${stdout}`.trim() || err.message)) : done(stdout)),
    )
  })

/** Same, for a blob that may not be text. */
const showBlob = (cwd: string, spec: string): Promise<Buffer> =>
  new Promise((done, fail) => {
    execFile('git', ['show', spec], { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? fail(err) : done(stdout as Buffer),
    )
  })

export type SyncResult =
  | { ok: false; unavailable: string }
  | { ok: true; committed: number; pulled: number; pushed: number; conflicts: string[]; waiting: boolean }

/**
 * Real paths, both sides: git reports the long name for a folder that reached
 * us as an 8.3 short one (`C:\Users\RUNNER~1\...` on a GitHub runner, any
 * `LONGFO~1` here), and a junction resolves to where it points. Compared
 * lexically, the vault looked like it sat inside some other repo and sync
 * quietly did nothing.
 */
const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}
const same = (a: string, b: string): boolean => real(a).toLowerCase() === real(b).toLowerCase()
const day = (now: number): string => new Date(now).toISOString().slice(0, 10)

/**
 * One pass. Exported for the test, which drives it against real repositories;
 * `now` is a parameter so "is anyone still typing" can be decided either way.
 */
export async function syncOnce(dir: string, now: number = Date.now()): Promise<SyncResult> {
  const git = gitIn(dir)

  // Only the TOP of a repo: a vault inside some larger repo is not this
  // feature's to commit.
  let top: string
  try {
    top = (await git(['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return { ok: false, unavailable: 'This vault is not a git repository.' }
  }
  if (!same(top, dir)) return { ok: false, unavailable: 'This vault sits inside a larger git repository, not at its top.' }
  try {
    await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  } catch {
    return { ok: false, unavailable: 'This branch has no remote branch to sync with.' }
  }
  // Someone (a person, an agent) is mid-merge by hand. Theirs to finish.
  if (existsSync(join(dir, '.git', 'MERGE_HEAD'))) {
    return { ok: false, unavailable: 'A merge is already in progress in this vault. Finish it, and sync resumes.' }
  }

  // 1. Local changes, once they have settled.
  // -uall: an untracked folder is listed file by file, so "still typing" is
  // judged on the notes in it rather than on the folder's own timestamp.
  const changed = changedPaths(await git(['status', '--porcelain=v1', '-z', '-uall']))
  const typing = changed.some((p) => {
    try {
      return now - statSync(join(dir, p)).mtimeMs < QUIET_MS
    } catch {
      return false // deleted: nothing is being typed into it
    }
  })
  let committed = 0
  if (changed.length && !typing) {
    await git(['add', '-A'])
    try {
      await git(['commit', '--quiet', '-m', `sync: ${hostname()} ${new Date(now).toISOString()}`])
      committed = changed.length
    } catch (e) {
      // Staging can leave nothing to record (a change that was only line
      // endings). That is "nothing to commit", not a failed sync.
      if (!/nothing to commit|nothing added/i.test((e as Error).message)) throw e
    }
  }

  // 2. Whatever the remote has.
  await git(['fetch', '--quiet'])
  const pulled = Number((await git(['rev-list', '--count', 'HEAD..@{u}'])).trim())
  const conflicts: string[] = []
  if (pulled > 0) {
    // Uncommitted work that is still moving stays out of a merge: next round.
    if (changed.length && typing) {
      return { ok: true, committed, pulled: 0, pushed: 0, conflicts, waiting: true }
    }
    try {
      await git(['merge', '--no-edit', '--quiet', '@{u}'])
    } catch (e) {
      const stuck = (await git(['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
      if (stuck.length === 0) {
        await git(['merge', '--abort']).catch(() => {})
        throw e
      }
      for (const path of stuck) conflicts.push(...(await keepBoth(dir, git, path, now)))
      await git(['commit', '--no-edit', '--quiet'])
    }
  }

  // 3. Ours, to the remote.
  const pushed = Number((await git(['rev-list', '--count', '@{u}..HEAD'])).trim())
  if (pushed > 0) await git(['push', '--quiet'])

  return { ok: true, committed, pulled, pushed, conflicts, waiting: changed.length > 0 && typing }
}

/** Resolve one conflicted path without losing either side. Returns any copy written. */
async function keepBoth(dir: string, git: Git, path: string, now: number): Promise<string[]> {
  const has = (stage: 2 | 3) => git(['cat-file', '-e', `:${stage}:${path}`]).then(() => true, () => false)
  const plan = resolution({ ours: await has(2), theirs: await has(3) })
  if (plan === 'keep-theirs') {
    // We deleted, they edited: the edit comes back.
    await git(['checkout', '--theirs', '--', path])
    await git(['add', '--', path])
    return []
  }
  if (plan === 'keep-ours') {
    // They deleted, we edited: ours is already in the working tree.
    await git(['add', '--', path])
    return []
  }
  const copy = conflictName(path, day(now), (p) => existsSync(join(dir, p)))
  mkdirSync(dirname(join(dir, copy)), { recursive: true })
  writeFileSync(join(dir, copy), await showBlob(dir, `:3:${path}`))
  await git(['checkout', '--ours', '--', path])
  await git(['add', '--', path, copy])
  return [copy]
}

// ------------------------------------------------------------------ while the app runs

let status: SyncStatus = { ...IDLE }
let timer: ReturnType<typeof setInterval> | null = null

export const getStatus = (): SyncStatus => ({ ...status, conflicts: [...status.conflicts] })

/** One pass now, unless one is already running. Never throws: failure is a status line. */
export async function runNow(): Promise<SyncStatus> {
  if (status.running || !status.enabled) return getStatus()
  status = { ...status, running: true }
  try {
    const r = await syncOnce(getVaultDir())
    if (!r.ok) {
      status = { ...status, available: false, why: r.unavailable, lastError: null }
    } else {
      status = {
        ...status,
        available: true,
        why: null,
        lastAt: Date.now(),
        lastError: null,
        lastSummary: summarise(r),
        conflicts: r.conflicts,
      }
      // New notes arrived from the other side: the open window re-reads the
      // folder, the same signal an outside agent's write sends.
      if (r.pulled > 0) {
        invalidateGraph()
        for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(EV.vaultChanged, null)
      }
    }
  } catch (e) {
    // Offline, credentials, a lock another git process holds: next round retries.
    status = { ...status, lastError: e instanceof Error ? e.message : String(e) }
  } finally {
    status = { ...status, running: false }
  }
  return getStatus()
}

/**
 * Turn it on or off. On means a pass now, then one every INTERVAL_MS, and the
 * returned promise is that first pass, so a caller can answer with what it did.
 */
export function configure(enabled: boolean): Promise<SyncStatus> {
  if (timer) clearInterval(timer)
  timer = null
  status = { ...status, enabled }
  if (!enabled) return Promise.resolve(getStatus())
  const first = runNow()
  timer = setInterval(() => void runNow(), INTERVAL_MS)
  timer.unref?.()
  return first
}
