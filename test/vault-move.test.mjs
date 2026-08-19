/**
 * `vault.move` / `vault.undoMove` — the undo that has to exist before the
 * autonomy does.
 *
 * The thing under test is not "does the file end up in the right place". It is
 * the promise that makes unattended filing survivable: NOTHING IS EVER DELETED,
 * and every move can be put back. So most assertions here read the filesystem
 * after the call rather than trusting the return value or the thrown message —
 * a call that both throws AND writes would pass a rejects-only test, and that
 * is exactly the failure that costs a note.
 *
 * `nothingDeleted()` runs after every mutating step. It is the strongest claim
 * this feature makes and the cheapest one to break by accident later.
 *
 * No Electron, no IPC — same shape as vault-mkdir.test.mjs and versions.test.mjs.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir as mkdirp, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import * as vault from '../src/main/vault.ts'

/**
 * Every mutating vault call needs an actor, and none of them defaults to one.
 * These suites exercise the USER path — the person clicked or typed — which is
 * the path that must never prompt. The agent path is covered by consent.test.mjs.
 */
const USER = { kind: 'user' }


const exists = async (p) => !!(await stat(p).catch(() => null))

/** Every file under `dir`, including hidden ones, as relPath -> text. */
async function snapshot(dir, base = dir, out = new Map()) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) await snapshot(abs, base, out)
    else if (e.isFile()) out.set(relative(base, abs).split(sep).join('/'), await readFile(abs, 'utf8'))
  }
  return out
}

/**
 * The invariant: every file that existed still exists, either where it was or
 * byte-identical somewhere else (which is what `.trash/` is for).
 *
 * Content equality rather than path equality is the whole point — a move is
 * ALLOWED to empty a path, and is never allowed to lose what was in it.
 */
function nothingDeleted(before, after, what) {
  const bodies = [...after.values()]
  for (const [path, text] of before) {
    if (after.has(path)) continue
    assert.ok(
      bodies.includes(text),
      `${what}: "${path}" left no copy anywhere — this feature deleted a file`,
    )
  }
}

/** The journal, parsed. Read off disk every time, never cached — like main. */
async function journal(dir) {
  const text = await readFile(join(dir, '.trash', 'moves.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

/** Every note path tree() reports, flattened. */
function treePaths(node, out = []) {
  if (node.path) out.push(node.path)
  node.children?.forEach((c) => treePaths(c, out))
  return out
}

test('vault.move', async (t) => {
  /**
   * Two levels of scratch above the vault, both owned by this test, so
   * `../escaped.md` AND `../../escaped.md` land in directories whose entire
   * contents can be asserted. vault-mkdir.test.mjs learned this the hard way:
   * an escape assertion pointed at a shared location tests %TEMP%'s history
   * rather than the guard.
   */
  const top = await mkdtemp(join(tmpdir(), 'vault-move-'))
  const mid = join(top, 'mid')
  const dir = join(mid, 'vault')
  await mkdirp(dir, { recursive: true })
  vault._setVaultDirForTest(dir)

  await writeFile(join(dir, 'Note.md'), '# Note\n\nfiled by hand.\n', 'utf8')
  await writeFile(join(dir, 'Other.md'), '# Other\n', 'utf8')

  let moveId

  await t.test('a move copies to `to`, trashes the original, and journals it', async () => {
    const before = await snapshot(dir)
    const rec = await vault.move('Note.md', 'Archive/2026/Note.md', USER)
    const after = await snapshot(dir)

    assert.equal(await readFile(join(dir, 'Archive', '2026', 'Note.md'), 'utf8'),
      '# Note\n\nfiled by hand.\n')
    assert.equal(await exists(join(dir, 'Note.md')), false, 'the original path should be empty')

    // The original is in `.trash`, under its old relative path, byte for byte.
    const trashed = [...after].filter(([p]) => p.startsWith('.trash/') && p.includes('Note.md.'))
    assert.equal(trashed.length, 1, 'exactly one trashed original')
    assert.equal(trashed[0][1], '# Note\n\nfiled by hand.\n')

    const lines = await journal(dir)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].id, rec.id)
    assert.equal(lines[0].from, 'Note.md')
    assert.equal(lines[0].to, 'Archive/2026/Note.md')
    assert.equal(lines[0].trash, trashed[0][0].slice('.trash/'.length))
    assert.ok(Number.isFinite(lines[0].at))

    nothingDeleted(before, after, 'move')
    moveId = rec.id
  })

  await t.test('the journal is a file, so it survives a restart', async () => {
    // Nothing about the undo below lives in this process: the journal is
    // re-read off disk on every call, which is what makes an undo work in a
    // session that never saw the move.
    assert.ok(await exists(join(dir, '.trash', 'moves.jsonl')))
    const lines = await journal(dir)
    assert.equal(lines.filter((l) => l.id === moveId).length, 1)
  })

  await t.test('a destination that exists is REFUSED, and nothing changes', async () => {
    const before = await snapshot(dir)
    const e = await vault.move('Other.md', 'Archive/2026/Note.md', USER).catch((err) => err)
    // A distinct class, not a message: the renderer has to tell a collision
    // apart from a disk failure, and it cannot do that by matching strings.
    assert.equal(e.name, 'MoveConflict')
    assert.equal(e.path, 'Archive/2026/Note.md')
    assert.ok(!e.message.includes(dir), e.message)

    // The filesystem is the assertion. A call that threw AND wrote would pass
    // a rejects-only test.
    assert.deepEqual(await snapshot(dir), before)
  })

  await t.test('a source that is not there is REFUSED, and nothing changes', async () => {
    const before = await snapshot(dir)
    await assert.rejects(
      () => vault.move('Ghost.md', 'Archive/Ghost.md', USER),
      /nothing at that path to move/,
    )
    assert.deepEqual(await snapshot(dir), before)
  })

  await t.test('a folder is refused — this moves files, not trees', async () => {
    const before = await snapshot(dir)
    await assert.rejects(() => vault.move('Archive', 'Elsewhere', USER), /only a file can be moved/)
    assert.deepEqual(await snapshot(dir), before)
  })

  /**
   * The traversal guard, on BOTH ends. A move is a write to two locations, so
   * a guard on one of them is half a guard — and `to` is the dangerous half,
   * because that is where bytes land.
   */
  await t.test('a climbing path is REFUSED as `from` and as `to`', async () => {
    const before = await snapshot(dir)
    const bad = ['../escaped.md', '../../escaped.md', 'Archive/../../../escaped.md']

    for (const p of bad) {
      await assert.rejects(() => vault.move(p, 'Landed.md', USER), /escapes the vault/, `from ${p}`)
      await assert.rejects(() => vault.move('Other.md', p, USER), /escapes the vault/, `to ${p}`)
    }

    // Proof that nothing outside the vault was written: both scratch levels
    // above the root are owned by this test and must be untouched.
    assert.deepEqual(await readdir(mid), ['vault'])
    assert.deepEqual(await readdir(top), ['mid'])
    assert.deepEqual(await snapshot(dir), before)
  })

  await t.test('an absolute path outside the vault is REFUSED as `from` and as `to`', async () => {
    const before = await snapshot(dir)
    const bad = [join(top, 'escaped.md'), 'C:\\Windows\\Temp\\escaped.md', '/tmp/escaped.md']

    for (const p of bad) {
      await assert.rejects(() => vault.move(p, 'Landed.md', USER), /escapes the vault/, `from ${p}`)
      await assert.rejects(() => vault.move('Other.md', p, USER), /escapes the vault/, `to ${p}`)
    }

    assert.deepEqual(await readdir(mid), ['vault'])
    assert.deepEqual(await readdir(top), ['mid'])
    assert.equal(await exists(join(top, 'escaped.md')), false)
    assert.deepEqual(await snapshot(dir), before)
  })

  await t.test('a path the explorer hides is refused at either end', async () => {
    const before = await snapshot(dir)
    // Filing into `.trash/` or `.obsidian/` would report success and make the
    // note vanish from the sidebar, the database and the graph — and into
    // `.trash/` it would land on the journal's own bookkeeping.
    for (const p of ['.trash/x.md', '.obsidian/x.md', 'node_modules/x.md']) {
      await assert.rejects(() => vault.move('Other.md', p, USER), /does not show that path/, `to ${p}`)
      await assert.rejects(() => vault.move(p, 'Landed.md', USER), /does not show that path/, `from ${p}`)
    }
    assert.deepEqual(await snapshot(dir), before)
  })

  await t.test('a non-string path is refused at the boundary', async () => {
    // The `from: string` annotations are erased at runtime; the renderer sends
    // whatever it likes.
    for (const bad of [undefined, null, 42, {}, ['Note.md'], '']) {
      await assert.rejects(() => vault.move(bad, 'Landed.md', USER), /non-empty string/)
      await assert.rejects(() => vault.move('Other.md', bad, USER), /non-empty string/)
    }
  })

  await t.test('a trashed file appears in neither tree() nor list()', async () => {
    // `.trash` is in HIDDEN and starts with a dot, so tree() skips it — and
    // list()/graph() are built FROM tree(), which is why one exclusion covers
    // all three views. Asserted rather than assumed.
    const paths = treePaths(await vault.tree())
    assert.ok(paths.includes('Archive/2026/Note.md'), 'the moved note should be listed')
    assert.deepEqual(paths.filter((p) => p.startsWith('.trash')), [])
    assert.deepEqual(paths.filter((p) => p.includes('moves.jsonl')), [])

    const listed = (await vault.list()).map((n) => n.path)
    assert.ok(listed.includes('Archive/2026/Note.md'))
    assert.deepEqual(listed.filter((p) => p.startsWith('.trash')), [])
  })

  await t.test('undo puts the original back and clears the moved copy', async () => {
    const before = await snapshot(dir)
    await vault.undoMove(moveId, USER)
    const after = await snapshot(dir)

    assert.equal(await readFile(join(dir, 'Note.md'), 'utf8'), '# Note\n\nfiled by hand.\n')
    assert.equal(await exists(join(dir, 'Archive', '2026', 'Note.md')), false)

    // "Removed" means trashed, not unlinked: an undo must itself be survivable.
    nothingDeleted(before, after, 'undo')

    const lines = await journal(dir)
    assert.equal(lines.filter((l) => l.undo === moveId).length, 1, 'the undo is journalled')
  })

  await t.test('undoing the same move twice is REFUSED', async () => {
    const before = await snapshot(dir)
    await assert.rejects(() => vault.undoMove(moveId, USER), /already been undone/)
    assert.deepEqual(await snapshot(dir), before)
  })

  await t.test('an id that was never journalled is refused', async () => {
    await assert.rejects(() => vault.undoMove('not-an-id', USER), /no such move/)
    await assert.rejects(() => vault.undoMove('', USER), /non-empty string/)
  })

  await t.test('undo is REFUSED when the origin is occupied again', async () => {
    const rec = await vault.move('Other.md', 'Archive/Other.md', USER)
    // Someone wrote a NEW note at the old path in the meantime. Putting the
    // original back over it would be the silent overwrite this all exists to
    // prevent.
    await writeFile(join(dir, 'Other.md'), 'a different note entirely\n', 'utf8')

    const before = await snapshot(dir)
    const e = await vault.undoMove(rec.id, USER).catch((err) => err)
    assert.equal(e.name, 'MoveConflict')
    assert.equal(e.path, 'Other.md')
    assert.deepEqual(await snapshot(dir), before)

    // And it is still undoable once the path is free again.
    const lines = await journal(dir)
    assert.equal(lines.filter((l) => l.undo === rec.id).length, 0)
  })

  await t.test('repeated moves of the same path do not collide in the trash', async () => {
    // Same source path, twice, as fast as the loop goes: the timestamp suffix
    // alone can repeat inside one millisecond, and a collision there would
    // overwrite a trashed original — a delete wearing a different name.
    const bodies = ['first\n', 'second\n', 'third\n']
    for (const text of bodies) {
      await writeFile(join(dir, 'Churn.md'), text, 'utf8')
      await vault.move('Churn.md', `Archive/Churn-${text.trim()}.md`, USER)
    }
    const after = await snapshot(dir)
    const trashed = [...after].filter(([p]) => p.startsWith('.trash/') && p.includes('Churn.md.'))
    assert.equal(trashed.length, 3, 'every original kept, none overwritten')
    assert.deepEqual(trashed.map(([, t]) => t).sort(), [...bodies].sort())
  })

  await t.test('across everything above, no file was ever deleted', async () => {
    // The suite's own history is the fixture: every byte written into this
    // vault by any step must still be somewhere in it.
    const all = await snapshot(dir)
    const bodies = [...all.values()]
    for (const text of [
      '# Note\n\nfiled by hand.\n',
      '# Other\n',
      'a different note entirely\n',
      'first\n',
      'second\n',
      'third\n',
    ]) {
      assert.ok(bodies.includes(text), `content lost: ${JSON.stringify(text)}`)
    }
  })
})
