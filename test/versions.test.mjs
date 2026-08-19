/**
 * Version history — src/main/versions.ts against a scratch vault.
 *
 * Drives the REAL save() to make the backups rather than writing fixture files
 * that look like backups. That is the whole point of the suite: the lister and
 * `backup()` in vault.ts agree on a filename convention that nothing else
 * checks, and a fixture written by hand would assert that the lister matches
 * ITSELF while a change to `backup()` broke the panel silently.
 *
 * No Electron, no vault, no network — same shape as section4-data-layer.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vault from '../src/main/vault.ts'

/**
 * Every mutating vault call needs an actor, and none of them defaults to one.
 * These suites exercise the USER path — the person clicked or typed — which is
 * the path that must never prompt. The agent path is covered by consent.test.mjs.
 */
const USER = { kind: 'user' }

import * as versions from '../src/main/versions.ts'

/**
 * Windows file timestamps come off the system clock, whose tick is coarse. Two
 * saves closer together than this can land on the same millisecond, which
 * collapses two backups onto one filename and one `at`. Real editing is never
 * that fast; the test has to be slowed down to look like it.
 */
const TICK = 40
const settle = () => new Promise((r) => setTimeout(r, TICK))

test('version history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-versions-'))
  await mkdir(join(dir, 'Projects'), { recursive: true })
  vault._setVaultDirForTest(dir)

  await t.test('a note that has never been overwritten has no versions', async () => {
    // Not even `.backups/` exists yet. An empty history is the honest answer;
    // a missing directory must not fail the panel.
    assert.deepEqual(await versions.versions('Projects/AI.md'), [])

    await vault.save('Projects/AI.md', 'v1\n', 0, USER)
    // The create wrote no backup — there was no previous text to keep.
    assert.deepEqual(await versions.versions('Projects/AI.md'), [])
  })

  await t.test('each save leaves the PREVIOUS text, newest first', async () => {
    let note = await vault.read('Projects/AI.md')
    await settle()
    note = await vault.save('Projects/AI.md', 'v2\n', note.mtime, USER)
    await settle()
    await vault.save('Projects/AI.md', 'v3\n', note.mtime, USER)

    const list = await versions.versions('Projects/AI.md')
    assert.equal(list.length, 2)

    // Newest first, and `at` is a real timestamp rather than 0 or NaN.
    assert.ok(list[0].at > list[1].at, `${list[0].at} should be newer than ${list[1].at}`)
    for (const v of list) {
      assert.ok(Number.isFinite(v.at) && v.at > 0)
      assert.ok(v.size > 0)
      // The id is relative to `.backups/`, forward-slashed, and mirrors the
      // note's own folder. It is NOT a vault path.
      assert.match(v.id, /^Projects\/AI\.md\./)
    }

    // The newest copy is the text as it was before the LAST save — v2, not v3.
    // A panel that showed v3 here would be offering to restore the file to
    // exactly what it already is.
    assert.equal(await versions.versionText(list[0].id), 'v2\n')
    assert.equal(await versions.versionText(list[1].id), 'v1\n')
    assert.equal(await readFile(join(dir, 'Projects', 'AI.md'), 'utf8'), 'v3\n')
  })

  await t.test('the retired note server\'s flat backups are listed too', async () => {
    // `.backups/<stamp>__<path with / as __>`, written by server.py and still
    // sitting in the real vault. Nothing in the app creates these any more, so
    // one is planted by hand — the point of the case is that the OLD name is
    // still found, which no amount of driving save() can prove.
    const legacy = join(dir, '.backups', '20260101-090000-000000__Projects__AI.md')
    await writeFile(legacy, 'ancient\n', 'utf8')
    // Backdated so its position is deterministic. This also pins the design:
    // `at` is the backup file's own mtime, not the stamp parsed out of its
    // name, so an old copy sorts old even though it was written just now.
    const then = new Date('2026-01-01T09:00:00Z')
    await utimes(legacy, then, then)

    const list = await versions.versions('Projects/AI.md')
    assert.equal(list.length, 3)
    // Oldest, so last. Both layouts sort on one key.
    assert.equal(list[2].id, '20260101-090000-000000__Projects__AI.md')
    assert.equal(list[2].at, then.getTime())
    assert.equal(await versions.versionText(list[2].id), 'ancient\n')

    // And it is listed ONCE. The two patterns must not both match one file.
    const ids = list.map((v) => v.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  await t.test('another note\'s backups are not listed', async () => {
    await vault.save('Home.md', 'home v1\n', 0, USER)
    await settle()
    const home = await vault.read('Home.md')
    await vault.save('Home.md', 'home v2\n', home.mtime, USER)

    const homeVersions = await versions.versions('Home.md')
    assert.equal(homeVersions.length, 1)
    assert.equal(await versions.versionText(homeVersions[0].id), 'home v1\n')

    // A root-level note's backups share a directory with the flat legacy ones,
    // so this is the case where a loose prefix match would cross-contaminate.
    const aiVersions = await versions.versions('Projects/AI.md')
    assert.equal(aiVersions.length, 3)
  })

  await t.test('restoring is a save: guarded, and backed up in turn', async () => {
    const before = await vault.read('Projects/AI.md')
    const list = await versions.versions('Projects/AI.md')
    const oldText = await versions.versionText(list[0].id) // 'v2\n'
    await settle()

    // This is exactly what the panel does — the same save() the Save button
    // calls, with the mtime read() handed out. There is no restore call and
    // nothing copies a file back over the note.
    const saved = await vault.save('Projects/AI.md', oldText, before.mtime, USER)
    assert.equal(await readFile(join(dir, 'Projects', 'AI.md'), 'utf8'), 'v2\n')
    assert.ok(saved.mtime > 0)

    // The restore kept a copy of what it replaced, so it is itself undoable.
    const after = await versions.versions('Projects/AI.md')
    assert.equal(after.length, list.length + 1)
    assert.equal(await versions.versionText(after[0].id), 'v3\n')
  })

  await t.test('a stale mtime still conflicts, and writes nothing', async () => {
    const stale = await vault.read('Projects/AI.md')
    await settle()
    // Someone else writes between the read and the restore.
    const current = await vault.save('Projects/AI.md', 'theirs\n', stale.mtime, USER)

    await assert.rejects(
      () => vault.save('Projects/AI.md', 'restored from history\n', stale.mtime, USER),
      (e) => e.name === 'SaveConflict' && e.currentMtime === current.mtime,
    )
    // The guard is the reason restore goes through save(). Nothing was written.
    assert.equal(await readFile(join(dir, 'Projects', 'AI.md'), 'utf8'), 'theirs\n')
  })

  await t.test('paths that climb out of .backups are refused', async () => {
    // Both arguments arrive from the renderer, which is untrusted, and
    // `versionText` is otherwise a read primitive. Note the second case: the
    // vault root itself is out of bounds here, so a version id cannot be used
    // to read a note the tree never offered.
    for (const bad of ['../../etc/passwd', '../Home.md', 'C:\\Windows\\win.ini']) {
      await assert.rejects(
        () => versions.versionText(bad),
        /escapes the backups directory/,
        `versionText should refuse ${bad}`,
      )
      await assert.rejects(
        () => versions.versions(bad),
        /escapes the backups directory/,
        `versions should refuse ${bad}`,
      )
    }

    for (const bad of ['', null, undefined, 42]) {
      await assert.rejects(() => versions.versions(bad), /non-empty string/)
      await assert.rejects(() => versions.versionText(bad), /non-empty string/)
    }
  })

  await t.test('a missing version reports itself without leaking a path', async () => {
    await assert.rejects(
      () => versions.versionText('Projects/AI.md.2020-01-01T00-00-00-000Z'),
      (e) => {
        assert.match(e.message, /could not be read/)
        // fs puts the absolute path in every message and this one crosses IPC
        // to the renderer. Same leak scrub() exists to stop in vault.ts.
        assert.ok(!e.message.includes(dir), `leaked the vault path: ${e.message}`)
        return true
      },
    )
  })
})
