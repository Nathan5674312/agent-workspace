/**
 * Section 4 — Data Layer Tests
 *
 * Drives the real src/main/vault.ts against a scratch directory. There is no
 * mock HTTP server any more and no server.py to mimic: read() and save() were
 * the last two calls on the wire and they read and write the vault directory
 * directly now. No network, no real vault, no Electron required.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import * as vault from '../src/main/vault.ts'

/**
 * Every mutating vault call needs an actor, and none of them defaults to one.
 * These suites exercise the USER path — the person clicked or typed — which is
 * the path that must never prompt. The agent path is covered by consent.test.mjs.
 */
const USER = { kind: 'user' }


/**
 * `tree()`, `list()` and `graph()` all read the real filesystem, so these tests
 * need a scratch directory. Without one the suite pointed them at the ACTUAL
 * Universal Vault: it walked every folder on disk, took minutes instead of
 * milliseconds, and asserted against whatever happened to be in the user's
 * vault that day.
 *
 * Accepts either an array of paths (content does not matter) or a
 * `{ path: text }` map. The map form exists because `list()` and `graph()` now
 * parse the FILES — frontmatter and wikilinks — where they used to parse the
 * mock server's JSON. A fixture of empty stubs would silently assert that a
 * vault with no links has no links.
 */
async function makeScratchVault(paths) {
  const dir = await mkdtemp(join(tmpdir(), 'vault-tree-'))
  const entries = Array.isArray(paths)
    ? paths.map((rel) => [rel, `# ${rel}\n`])
    : Object.entries(paths)
  for (const [rel, text] of entries) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf-8')
  }
  return dir
}

test('vault data layer', async (t) => {
  // ONE fixture, on disk, for every call in this suite. It used to be two — a
  // mock note set for read()/save() and a scratch directory for the rest —
  // which meant the suite could pass while the two disagreed about what was in
  // the vault. There is one source now, which is the point of the change.
  const dir = await makeScratchVault({
    'Home.md': '# Home\n[[Projects]]',
    'Orphan Note.md': '# Orphan\nNo links here',
    'Trading Insights.md': '# Trading\n[[Projects/AI]]',
    'Projects/AI.md': '# AI Projects\n[[Trading Insights]]',
    'Projects/Tools.md': '# My Tools\n[[Home]]',
    'Files/Note with spaces.md': '# Spaces\n[[Home]]',
    'Files/Special#chars&symbols.md': '# Special\n[[Home]]',
  })
  vault._setVaultDirForTest(dir)

  await t.test('list() returns all notes with correct shape', async () => {
    const notes = await vault.list()
    assert.ok(Array.isArray(notes))
    assert.equal(notes.length, 7)

    const home = notes.find((n) => n.path === 'Home.md')
    assert.ok(home)
    assert.equal(home.title, 'Home')
    // The index carries no mtime and never has. See the TRAP note on list():
    // a row is fine to open or to draw, but 0 is not a version.
    assert.equal(home.mtime, 0)

    // Check a nested note
    const aiProject = notes.find((n) => n.path === 'Projects/AI.md')
    assert.ok(aiProject)
    assert.equal(aiProject.title, 'AI')
    assert.equal(aiProject.mtime, 0)
  })

  await t.test('read() returns the file text and its mtime', async () => {
    const note = await vault.read('Home.md')
    assert.equal(note.path, 'Home.md')
    assert.equal(note.title, 'Home')
    assert.ok(note.text.includes('[[Projects]]'))

    // The mtime is the file's, not a number invented on the way through, and
    // it is what save()'s guard will be compared against.
    const st = await stat(join(dir, 'Home.md'))
    assert.equal(note.mtime, st.mtimeMs)
  })

  await t.test('read() gives the SAME mtime twice for an untouched file', async () => {
    // The whole guard rests on this. `mtimeMs` is a float64 of ~1.7e12 and a
    // repeat stat of a file nobody wrote to must compare exactly equal, or
    // every save would raise a conflict that is not there. This is the property
    // the nanosecond value could not hold once it crossed into a JS number.
    const a = await vault.read('Home.md')
    const b = await vault.read('Home.md')
    assert.equal(a.mtime, b.mtime)
    assert.ok(Number.isFinite(a.mtime) && a.mtime > 0)
  })

  await t.test('read() handles spaces in path', async () => {
    const note = await vault.read('Files/Note with spaces.md')
    assert.equal(note.path, 'Files/Note with spaces.md')
    assert.equal(note.title, 'Note with spaces')
    assert.ok(note.text.includes('Spaces'))
  })

  await t.test('read() handles special characters # and &', async () => {
    const note = await vault.read('Files/Special#chars&symbols.md')
    assert.equal(note.path, 'Files/Special#chars&symbols.md')
    assert.equal(note.title, 'Special#chars&symbols')
  })

  await t.test('read() throws on missing note', async () => {
    try {
      await vault.read('Nonexistent.md')
      assert.fail('should have thrown')
    } catch (e) {
      assert.ok(e instanceof Error)
    }
  })

  await t.test('save() writes the file and returns the new mtime', async () => {
    const before = await vault.read('Home.md')
    const result = await vault.save('Home.md', 'Updated text', before.mtime, USER)
    assert.equal(result.path, 'Home.md')
    assert.equal(result.title, 'Home')

    // On disk, not through our own reader — the file itself is the assertion.
    assert.equal(await readFile(join(dir, 'Home.md'), 'utf-8'), 'Updated text')
    assert.equal((await stat(join(dir, 'Home.md'))).mtimeMs, result.mtime)

    // And the stamp it returns is immediately usable as the next guard value.
    const again = await vault.save('Home.md', 'Updated twice', result.mtime, USER)
    assert.equal(await readFile(join(dir, 'Home.md'), 'utf-8'), 'Updated twice')
    assert.ok(Number.isFinite(again.mtime))
  })

  await t.test('save() throws SaveConflict on stale mtime, and writes nothing', async () => {
    const onDisk = await readFile(join(dir, 'Home.md'), 'utf-8')
    try {
      await vault.save('Home.md', 'Conflicting text', 0, USER) // never the disk value
      assert.fail('should have thrown SaveConflict')
    } catch (e) {
      assert.ok(e instanceof vault.SaveConflict)
      // Carries the disk's CURRENT mtime, which is what the conflict dialog
      // re-saves against.
      assert.equal(e.currentMtime, (await stat(join(dir, 'Home.md'))).mtimeMs)
    }
    assert.equal(
      await readFile(join(dir, 'Home.md'), 'utf-8'),
      onDisk,
      'a refused save touched the file anyway',
    )
  })


  await t.test('tree() builds nested structure, sorts folders before notes', async () => {
    const root = await vault.tree()
    // Was `assert.equal(root.name, 'Universal Vault')`, which passed against a
    // scratch directory called something else entirely — it was pinning a
    // hardcoded literal as if it were behaviour. The root must be named after
    // the folder actually being read, or the whole UI keeps calling every vault
    // by one machine's folder name.
    assert.equal(root.name, basename(dir))
    assert.equal(root.kind, 'folder')
    assert.ok(root.children)

    // Root level should have: Files folder, Home.md, Orphan Note.md, Projects folder, Trading Insights.md
    // Folders (Files, Projects) should sort before notes
    const folders = root.children.filter((c) => c.kind === 'folder')
    const notes = root.children.filter((c) => c.kind === 'note')
    assert.ok(folders.length >= 2, 'should have at least 2 folders')
    assert.ok(notes.length >= 3, 'should have at least 3 root notes')

    // Verify folders come before notes in the array (checking that sort works)
    let lastFolderIdx = -1
    let firstNoteIdx = root.children.length
    for (let i = 0; i < root.children.length; i++) {
      if (root.children[i].kind === 'folder') lastFolderIdx = i
      if (root.children[i].kind === 'note') firstNoteIdx = Math.min(firstNoteIdx, i)
    }
    assert.ok(lastFolderIdx < firstNoteIdx, 'all folders should come before all notes')

    // Check Files folder exists and contains spaced notes
    const filesFolder = root.children.find((c) => c.name === 'Files' && c.kind === 'folder')
    assert.ok(filesFolder, 'Files folder should exist')
    assert.ok(filesFolder.children)

    // Check Projects folder has correct structure
    const projectsFolder = root.children.find((c) => c.name === 'Projects' && c.kind === 'folder')
    assert.ok(projectsFolder)
    assert.ok(projectsFolder.children)
    assert.equal(projectsFolder.children.length, 2)
  })

  await t.test('tree() preserves all notes at any depth', async () => {
    const root = await vault.tree()
    const collected = []

    function collect(node) {
      if (node.kind === 'note') {
        collected.push(node.path)
      }
      if (node.children) {
        node.children.forEach(collect)
      }
    }

    collect(root)
    assert.equal(
      collected.length,
      7,
      `should preserve all 7 notes, got ${collected.length}`,
    )
  })

  await t.test('graph() resolves wikilinks case-insensitively', async () => {
    const g = await vault.graph()
    assert.ok(Array.isArray(g.nodes))
    assert.ok(Array.isArray(g.links))

    // Should find link from Projects/AI.md -> Trading Insights.md
    const projAiLinks = g.links.filter((l) => l.from === 'Projects/AI.md')
    const tradingLink = projAiLinks.find((l) => l.to === 'Trading Insights.md')
    assert.ok(tradingLink, 'should resolve Projects/AI -> Trading Insights')
  })

  await t.test('graph() ignores self-links', async () => {
    const g = await vault.graph()
    const selfLinks = g.links.filter((l) => l.from === l.to)
    assert.equal(selfLinks.length, 0, 'should not include self-links')
  })

  await t.test('graph() ignores links to nonexistent notes', async () => {
    const g = await vault.graph()
    // Home.md has [[Projects]] but there's no note named "Projects"
    const linksToProjects = g.links.filter((l) => l.to === 'Projects')
    assert.equal(
      linksToProjects.length,
      0,
      'should ignore links to nonexistent "Projects" note',
    )
  })

  await t.test('graph() does not blow up when a note fails to read', async () => {
    const g = await vault.graph()
    assert.ok(g.nodes.length > 0)
    assert.ok(Array.isArray(g.links))
  })

  await t.test('backlinks() deduplicates incoming links', async () => {
    const backlinks = await vault.backlinks('Home.md')
    assert.ok(Array.isArray(backlinks))
    // Multiple notes link to Home.md (Projects/Tools.md, Files/Note with spaces.md)
    // Each should appear once
    const unique = new Set(backlinks)
    assert.equal(
      unique.size,
      backlinks.length,
      'backlinks should be deduplicated',
    )
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// save() as a WRITER: the four behaviours the note server used to own.
//
// Each of these takes its own scratch vault, because they create files and the
// suite above counts them.

test('save() creates a note that does not exist yet', async () => {
  const dir = await makeScratchVault({ 'Home.md': '# Home' })
  vault._setVaultDirForTest(dir)

  // A path with no file has no version to lose, so the guard is skipped and 0
  // is the create stamp — server.py:765 did the same, and it is what makes
  // `save(path, '', 0)` the create call the new-note button is specified on.
  const made = await vault.save('Created.md', '# new\n', 0, USER)
  assert.equal(await readFile(join(dir, 'Created.md'), 'utf-8'), '# new\n')
  assert.ok(made.mtime > 0)
  assert.equal(made.title, 'Created')

  // Once it exists it is an ordinary note and the create stamp is refused.
  await assert.rejects(
    () => vault.save('Created.md', 'clobber', 0, USER),
    (e) => e instanceof vault.SaveConflict,
  )
  assert.equal(await readFile(join(dir, 'Created.md'), 'utf-8'), '# new\n')
})

test('save() writes into a folder that does not exist rather than inventing one', async () => {
  const dir = await makeScratchVault({ 'Home.md': '# Home' })
  vault._setVaultDirForTest(dir)

  // The temp file is staged in the TARGET's directory, exactly as the server's
  // atomic_write did, so a missing parent is an error and not a silent mkdir.
  // Creating folders is a separate control with its own dialog; a save that
  // conjures directories out of a typo'd path is how a vault grows junk.
  await assert.rejects(
    () => vault.save('Nope/Deep.md', 'text', 0, USER),
    (e) => e instanceof Error && !(e instanceof vault.SaveConflict),
  )
  await assert.rejects(() => stat(join(dir, 'Nope')))
})

test('save() keeps a pre-edit copy under .backups/', async () => {
  const { readdir } = await import('node:fs/promises')
  const dir = await makeScratchVault({ 'Projects/Backed.md': 'first' })
  vault._setVaultDirForTest(dir)

  const note = await vault.read('Projects/Backed.md')
  await vault.save('Projects/Backed.md', 'second', note.mtime, USER)

  const kept = await readdir(join(dir, '.backups', 'Projects'))
  const copy = kept.find((f) => f.startsWith('Backed.md.'))
  assert.ok(copy, `no backup was written: ${kept}`)
  assert.equal(
    await readFile(join(dir, '.backups', 'Projects', copy), 'utf-8'),
    'first',
    'the backup must hold the text as it was BEFORE the save',
  )
  // Not a `.md`, so a backup can never be indexed as a note even if SKIP moved.
  assert.ok(!copy.toLowerCase().endsWith('.md'), `backup looks like a note: ${copy}`)

  // And it is invisible to the app: `.backups/` is a dot-directory, so tree()
  // skips it, and SKIP keeps it out of the index.
  const root = await vault.tree()
  assert.ok(!(root.children ?? []).some((c) => c.name === '.backups'))
  assert.deepEqual(
    (await vault.list()).map((n) => n.path),
    ['Projects/Backed.md'],
  )
})

/**
 * ATOMICITY, observed rather than asserted about.
 *
 * `writeFileSync` opens the target with O_TRUNC: it empties the file and THEN
 * writes, so anything that goes wrong in between leaves a 0-byte note where the
 * user's text was. Temp-file-plus-rename never opens the target at all.
 *
 * The failure is forced by putting a DIRECTORY where the temp file wants to go,
 * which is deterministic on every platform and fails at exactly the moment a
 * bare writeFileSync would already have truncated the real file.
 */
test('a failed write cannot truncate the note', async () => {
  const { mkdir: makeDir } = await import('node:fs/promises')
  const dir = await makeScratchVault({ 'Home.md': 'the original text' })
  vault._setVaultDirForTest(dir)

  const note = await vault.read('Home.md')
  await makeDir(join(dir, 'Home.md.saving.tmp'))

  await assert.rejects(() => vault.save('Home.md', 'replacement', note.mtime, USER))

  assert.equal(
    await readFile(join(dir, 'Home.md'), 'utf-8'),
    'the original text',
    'the note was truncated or replaced by a write that failed',
  )
  // The note is still readable and still carries its original stamp, so the
  // user can simply save again.
  const after = await vault.read('Home.md')
  assert.equal(after.text, 'the original text')
  assert.equal(after.mtime, note.mtime)
})

test('a successful save leaves no temp file behind', async () => {
  const { readdir } = await import('node:fs/promises')
  const dir = await makeScratchVault({ 'Home.md': 'first' })
  vault._setVaultDirForTest(dir)

  const note = await vault.read('Home.md')
  await vault.save('Home.md', 'second', note.mtime, USER)

  const left = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(left, [], `temp files left in the vault: ${left}`)
})

/**
 * The regression the whole migration exists to prevent: nothing in this file
 * opens a socket any more, so no vault call can fail because a separate process
 * is not running. There is no `VaultUnavailable` left to throw.
 */
test('every vault call works with nothing running but this process', async () => {
  const dir = await makeScratchVault({
    'Home.md': '# Home\n[[Deep]]',
    'Deep.md': '# Deep\nnothing',
  })
  vault._setVaultDirForTest(dir)

  const notes = await vault.list()
  assert.equal(notes.length, 2)
  assert.deepEqual((await vault.graph()).links, [{ from: 'Home.md', to: 'Deep.md' }])

  const note = await vault.read('Home.md')
  assert.ok(note.text.includes('[[Deep]]'))
  await vault.save('Home.md', '# Home\nno links', note.mtime, USER)
  assert.equal(await readFile(join(dir, 'Home.md'), 'utf-8'), '# Home\nno links')

  assert.equal(vault.VaultUnavailable, undefined, 'the server error class outlived the server')
})

test('list() and graph() read the disk, not a note index', async () => {
  vault._setVaultDirForTest(
    await makeScratchVault({
      'Home.md': '# Home\n[[Deep]]',
      'Deep.md': '# Deep\nnothing',
    }),
  )

  const notes = await vault.list()
  assert.equal(notes.length, 2)

  const g = await vault.graph()
  assert.deepEqual(g.links, [{ from: 'Home.md', to: 'Deep.md' }])
})

// ─────────────────────────────────────────────────────────────────────────────
// Regressions found by the deep review + stress run.

test('tree() follows a junction and terminates on a cycle', async () => {
  const { symlink } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'vault-link-'))
  await mkdir(join(root, 'real'))
  await writeFile(join(root, 'real', 'inside.md'), '# inside')

  try {
    // Junctions into the vault are a documented convention on this machine.
    await symlink(join(root, 'real'), join(root, 'mirror'), 'junction')
  } catch {
    return // no permission to create links here; nothing to assert
  }
  // A link pointing back at an ancestor. Following links without a cycle guard
  // recurses until the stack gives out.
  try {
    await symlink(root, join(root, 'real', 'loop'), 'junction')
  } catch {
    /* best effort */
  }

  vault._setVaultDirForTest(root)
  const tree = await Promise.race([
    vault.tree(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('tree() hung')), 10_000)),
  ])

  const names = (tree.children ?? []).map((c) => c.name)
  // The Dirent for a junction reports isDirectory() === false, so `mirror` and
  // everything under it used to be absent from the explorer, silently.
  assert.ok(names.includes('mirror'), `linked folder missing from tree: ${names}`)
  const mirror = tree.children.find((c) => c.name === 'mirror')
  assert.ok(
    (mirror.children ?? []).some((c) => c.name === 'inside.md'),
    'linked folder listed but its contents were not',
  )
})

/**
 * Was 'list() skips malformed rows instead of throwing', against a mock that
 * served `[null, 'a string', …]` — untrusted JSON from another process. The
 * rows come off the disk now, so the untrusted thing is the FILE, and the same
 * invariant has to hold: one unparseable note must not fail list, graph and
 * backlinks together.
 */
test('list() survives files it cannot parse', async () => {
  vault._setVaultDirForTest(
    await makeScratchVault({
      'ok.md': '---\ntitle: Fine\ntype: note\n---\n# ok\n[[also ok]]',
      // Frontmatter that opens and never closes: `indexOf('\n---')` finds no
      // terminator, and a reader that assumed one would slice past the end.
      'unterminated.md': '---\ntitle: Broken\nstill going',
      // A `:` in prose above any frontmatter, and a value containing colons.
      'colons.md': 'no frontmatter here: but a colon\n[[ok]]',
      'also ok.md': '# also ok',
    }),
  )

  const rows = await vault.list()
  assert.deepEqual(
    rows.map((r) => r.path).sort(),
    ['also ok.md', 'colons.md', 'ok.md', 'unterminated.md'],
    'every readable file should be indexed, however scruffy its frontmatter',
  )

  // The unterminated block yields no frontmatter at all rather than a title of
  // "Broken" — matching writer.py's parse_fm, which returns None for it.
  assert.equal(rows.find((r) => r.path === 'unterminated.md').title, 'unterminated')
  assert.equal(rows.find((r) => r.path === 'ok.md').type, 'note')

  // And the links still resolve around the damage.
  const g = await vault.graph()
  assert.ok(g.links.some((l) => l.from === 'ok.md' && l.to === 'also ok.md'))
})

/**
 * scrub() used to redact Python's OSError strings. It now redacts Node's, which
 * are the same hazard from a new source: `ENOENT: no such file or directory,
 * open 'C:\…\Universal Vault\x.md'` names the absolute path, and that error is
 * thrown to the renderer. The scratch vault lives under the user's Temp
 * directory, so the OS username is really in the string this asserts on.
 */
test('a failed read does not leak the vault path to the renderer', async () => {
  const dir = await makeScratchVault({ 'Home.md': '# Home' })
  vault._setVaultDirForTest(dir)

  await assert.rejects(
    () => vault.read('Missing.md'),
    (e) => {
      assert.ok(!e.message.includes(dir), `leaked the vault path: ${e.message}`)
      assert.ok(!/Nathan/i.test(e.message), `leaked the OS username: ${e.message}`)
      assert.ok(e.message.includes('<path>'), `nothing was redacted: ${e.message}`)
      // The sentence has to survive, or the renderer shows "<path>" and nothing
      // a person can act on.
      assert.match(e.message, /no such file|ENOENT/i)
      return true
    },
  )
})

test('a failed save does not leak the vault path either', async () => {
  // Both entry points throw fs errors; scrubbing one and not the other is the
  // failure mode a per-callsite guard produces.
  const dir = await makeScratchVault({ 'Home.md': '# Home' })
  vault._setVaultDirForTest(dir)

  await assert.rejects(
    () => vault.save('Missing/Deep.md', 'text', 0, USER),
    (e) => {
      assert.ok(!e.message.includes(dir), `leaked the vault path: ${e.message}`)
      assert.ok(!/Nathan/i.test(e.message), `leaked the OS username: ${e.message}`)
      return true
    },
  )
})

test("scrub() does not eat our own messages", async () => {
  // Our own strings carry no path and must arrive whole, or every error the
  // renderer can show reads "<path>" and says nothing.
  const dir = await makeScratchVault({ 'Home.md': '# Home' })
  vault._setVaultDirForTest(dir)

  for (const [call, expected] of [
    [() => vault.read(''), 'vault: path must be a non-empty string'],
    [() => vault.save('', 'x', 0, USER), 'vault: path must be a non-empty string'],
    [() => vault.save('Home.md', 'x', null, USER), 'vault: mtime must be a finite number'],
    [() => vault.read('../escaped.md'), 'vault: path escapes the vault'],
  ]) {
    await assert.rejects(call, (e) => {
      assert.equal(e.message, expected)
      return true
    })
  }
})

/**
 * checkRoots() — was a comparison of TWO roots, the app's and the note
 * server's, which could silently disagree. There is one root now, so what it
 * checks is that the root is a real directory with notes in it. Both failures
 * are silent and expensive otherwise: an empty explorer, an empty database, and
 * nothing on screen saying the path is wrong.
 */
const ROOT_FIXTURE = [
  'Home.md',
  'AGENTS.md',
  'Projects/AI.md',
  'Projects/Tools.md',
  'Business/Plan.md',
  'Trading/ICT.md',
]

test('checkRoots() reports an unusable vault root', async (t) => {
  await t.test('a populated root reports nothing', async () => {
    vault._setVaultDirForTest(await makeScratchVault(ROOT_FIXTURE))
    assert.equal(await vault.checkRoots(), null)
  })

  await t.test('a missing directory is reported with the path', async () => {
    const gone = join(tmpdir(), 'vault-does-not-exist-' + Date.now())
    vault._setVaultDirForTest(gone)
    const msg = await vault.checkRoots()
    assert.ok(msg, 'a nonexistent vault root went unreported')
    assert.ok(msg.includes(gone), `message does not name the directory: ${msg}`)
  })

  await t.test('a file where a directory should be is reported', async () => {
    const dir = await makeScratchVault(['Home.md'])
    const notADir = join(dir, 'Home.md')
    vault._setVaultDirForTest(notADir)
    assert.ok(await vault.checkRoots(), 'a file used as a vault root went unreported')
  })

  await t.test('an empty directory is reported with the path', async () => {
    const empty = await makeScratchVault([])
    vault._setVaultDirForTest(empty)
    const msg = await vault.checkRoots()
    assert.ok(msg, 'a vault root with no notes went unreported')
    assert.ok(msg.includes(empty), `message does not name the directory: ${msg}`)
  })

  await t.test('a root holding only skipped paths counts as empty', async () => {
    // Templates/ and the vendored skill bundles are files, not notes. A root
    // containing nothing else indexes to zero rows, and the honest answer is
    // the same as an empty directory rather than a silent blank table.
    vault._setVaultDirForTest(
      await makeScratchVault(['Templates/Note.md', 'System/Skill Sources/x/SKILL.md']),
    )
    assert.ok(await vault.checkRoots(), 'a root with no indexable notes went unreported')
  })
})
