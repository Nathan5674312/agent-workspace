/**
 * Vault <-> GitHub sync, against REAL repositories: a bare "remote" standing in
 * for GitHub, clone `a` for this PC, clone `b` for an agent working in the
 * cloud. Every test is one of the rules in shared/gitsync.ts, checked by
 * reading files, because a sync that reports success while a note is gone is
 * the failure this has to make impossible.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { syncOnce } = await import('../src/main/vaultSync.ts')
const gs = await import('../src/shared/gitsync.ts')

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const LATER = Date.now() + 3_600_000 // every file has long since settled
const read = (dir, p) => readFileSync(join(dir, p), 'utf8')

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vault-sync-'))
  const remote = join(root, 'remote.git')
  sh(root, 'init', '--quiet', '--bare', remote)
  const clone = (name) => {
    const d = join(root, name)
    sh(root, 'clone', '--quiet', '-c', 'core.autocrlf=false', remote, d)
    sh(d, 'config', 'user.name', 'Test')
    sh(d, 'config', 'user.email', 'test@example.com')
    return d
  }
  const a = clone('a')
  sh(a, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(a, 'Note.md'), 'one\n')
  sh(a, 'add', '-A')
  sh(a, 'commit', '--quiet', '-m', 'init')
  sh(a, 'push', '--quiet', '-u', 'origin', 'main')
  sh(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const b = clone('b')
  return { root, a, b }
}

test('the pure rules: conflict names count up, porcelain parses, deletions never win', () => {
  assert.equal(gs.conflictName('Notes/Plan.md', '2026-10-21'), 'Notes/Plan (conflict 2026-10-21 github).md')
  assert.equal(gs.conflictName('README', '2026-10-21'), 'README (conflict 2026-10-21 github)')
  const taken = new Set(['Plan (conflict 2026-10-21 github).md'])
  assert.equal(gs.conflictName('Plan.md', '2026-10-21', (p) => taken.has(p)), 'Plan (conflict 2026-10-21 github 2).md')
  assert.deepEqual(gs.changedPaths(' M a b.md\0?? new.md\0R  to.md\0from.md\0'), ['a b.md', 'new.md', 'to.md'])
  assert.equal(gs.resolution({ ours: true, theirs: true }), 'keep-both')
  assert.equal(gs.resolution({ ours: true, theirs: false }), 'keep-ours')
  assert.equal(gs.resolution({ ours: false, theirs: true }), 'keep-theirs')
})

test('it does nothing where it has no business: not a repo, no remote, inside a bigger repo, a merge in progress', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'vault-sync-plain-'))
  assert.match((await syncOnce(plain, LATER)).unavailable, /not a git repository/)

  const lonely = mkdtempSync(join(tmpdir(), 'vault-sync-lonely-'))
  sh(lonely, 'init', '--quiet')
  assert.match((await syncOnce(lonely, LATER)).unavailable, /no remote branch/)

  const { a } = world()
  mkdirSync(join(a, 'inner'))
  assert.match((await syncOnce(join(a, 'inner'), LATER)).unavailable, /inside a larger git repository/)

  writeFileSync(join(a, '.git', 'MERGE_HEAD'), '0'.repeat(40))
  writeFileSync(join(a, 'Untouched.md'), 'x\n')
  assert.match((await syncOnce(a, LATER)).unavailable, /merge is already in progress/)
  assert.match(sh(a, 'status', '--porcelain'), /\?\? Untouched\.md/, 'nothing was committed')
})

test('a settled change goes up, and the other side brings it down', async () => {
  const { a, b } = world()
  mkdirSync(join(a, 'Ideas'))
  writeFileSync(join(a, 'Ideas', 'New idea.md'), 'from this PC\n')
  const up = await syncOnce(a, LATER)
  assert.deepEqual({ committed: up.committed, pushed: up.pushed }, { committed: 1, pushed: 1 })
  assert.match(sh(a, 'log', '-1', '--format=%s'), /^sync: /)

  const down = await syncOnce(b, LATER)
  assert.equal(down.pulled, 1)
  assert.equal(read(b, 'Ideas/New idea.md'), 'from this PC\n')
  assert.equal((await syncOnce(b, LATER)).pulled, 0, 'a second pass finds nothing to do')
})

test('a note still being written is not committed, and does not block the remote', async () => {
  const { a, b } = world()
  writeFileSync(join(b, 'Cloud.md'), 'from the cloud\n')
  await syncOnce(b, LATER)

  writeFileSync(join(a, 'Busy.md'), 'half a thought')
  const r = await syncOnce(a, Date.now())
  assert.equal(r.committed, 0)
  assert.equal(r.waiting, true)
  assert.ok(!existsSync(join(a, 'Cloud.md')), 'no merge while local work is still moving')
  assert.match(sh(a, 'status', '--porcelain'), /\?\? Busy\.md/)

  const later = await syncOnce(a, LATER)
  assert.deepEqual({ committed: later.committed, pulled: later.pulled }, { committed: 1, pulled: 1 })
  assert.equal(read(a, 'Cloud.md'), 'from the cloud\n')
})

test('both sides edit one note: ours stays, theirs is kept beside it, nothing is lost', async () => {
  const { a, b } = world()
  writeFileSync(join(b, 'Note.md'), 'theirs\n')
  await syncOnce(b, LATER)
  writeFileSync(join(a, 'Note.md'), 'ours\n')

  const r = await syncOnce(a, LATER)
  const copy = `Note (conflict ${new Date(LATER).toISOString().slice(0, 10)} github).md`
  assert.deepEqual(r.conflicts, [copy])
  assert.equal(read(a, 'Note.md'), 'ours\n')
  assert.equal(read(a, copy), 'theirs\n')
  assert.equal(r.pushed > 0, true)
  assert.equal(sh(a, 'status', '--porcelain'), '', 'the merge is finished, not left half done')

  await syncOnce(b, LATER)
  assert.equal(read(b, 'Note.md'), 'ours\n')
  assert.equal(read(b, copy), 'theirs\n')
})

test('a deletion never wins over an edit, from either side', async () => {
  // We delete, the cloud edits: the edit comes back.
  {
    const { a, b } = world()
    writeFileSync(join(b, 'Note.md'), 'edited in the cloud\n')
    await syncOnce(b, LATER)
    rmSync(join(a, 'Note.md'))
    const r = await syncOnce(a, LATER)
    assert.equal(read(a, 'Note.md'), 'edited in the cloud\n')
    assert.deepEqual(r.conflicts, [])
  }
  // The cloud deletes, we edit: ours stays.
  {
    const { a, b } = world()
    rmSync(join(b, 'Note.md'))
    await syncOnce(b, LATER)
    writeFileSync(join(a, 'Note.md'), 'edited here\n')
    await syncOnce(a, LATER)
    assert.equal(read(a, 'Note.md'), 'edited here\n')
    await syncOnce(b, LATER)
    assert.equal(read(b, 'Note.md'), 'edited here\n', 'and it reaches the side that deleted it')
  }
})
