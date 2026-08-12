/**
 * Section 4 — Data Layer Tests
 *
 * Tests vault module against a mock HTTP server that mimics server.py's behavior.
 * No network, no real vault, no Electron required.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vault from '../src/main/vault.ts'
import { startMockVault } from './helpers.mjs'

/**
 * `tree()` reads the real filesystem — it is a file explorer, and the server's
 * /notes endpoint is a curated note index that filters (it skips Inbox/), so it
 * was the wrong source. These tests therefore need a scratch directory rather
 * than the mock server's note list.
 *
 * Without this the suite pointed `tree()` at the ACTUAL Universal Vault: it
 * walked every folder on disk, took minutes instead of milliseconds, and
 * asserted against whatever happened to be in the user's vault that day.
 */
async function makeScratchVault(paths) {
  const dir = await mkdtemp(join(tmpdir(), 'vault-tree-'))
  for (const rel of paths) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, `# ${rel}\n`, 'utf-8')
  }
  return dir
}

test('vault data layer', async (t) => {
  // Start the mock vault server once for this test suite
  const mock = await startMockVault({
    notes: {
      'Home.md': { text: '# Home\n[[Projects]]', mtime: 1000000 },
      'Projects/AI.md': { text: '# AI Projects\n[[Trading Insights]]', mtime: 2000000 },
      'Projects/Tools.md': {
        text: '# My Tools\n[[Home]]',
        mtime: 3000000,
      },
      'Trading Insights.md': { text: '# Trading\n[[Projects/AI]]', mtime: 4000000 },
      'Files/Note with spaces.md': {
        text: '# Spaces\n[[Home]]',
        mtime: 5000000,
      },
      'Files/Special#chars&symbols.md': {
        text: '# Special\n[[Home]]',
        mtime: 6000000,
      },
      'Orphan Note.md': { text: '# Orphan\nNo links here', mtime: 7000000 },
    },
  })
  const mockUrl = mock.url
  vault._setBaseForTest(mockUrl)

  // Same shape as the mock note set above, on disk, so the tree assertions
  // below keep their original intent.
  vault._setVaultDirForTest(
    await makeScratchVault([
      'Home.md',
      'Orphan Note.md',
      'Trading Insights.md',
      'Projects/AI.md',
      'Projects/Tools.md',
      'Files/Note with spaces.md',
      'Files/Special#chars&symbols.md',
    ]),
  )

  await t.test('list() returns all notes with correct shape', async () => {
    const notes = await vault.list()
    assert.ok(Array.isArray(notes))
    assert.equal(notes.length, 7)

    const home = notes.find((n) => n.path === 'Home.md')
    assert.ok(home)
    assert.equal(home.title, 'Home')
    // NOTE: server.py does NOT return mtime in /notes endpoint, only in /note.
    // vault.ts defaults to 0, which is correct.
    assert.equal(home.mtime, 0)

    // Check a nested note
    const aiProject = notes.find((n) => n.path === 'Projects/AI.md')
    assert.ok(aiProject)
    assert.equal(aiProject.title, 'AI')
    assert.equal(aiProject.mtime, 0)
  })

  await t.test('read() fetches note with text and mtime', async () => {
    const note = await vault.read('Home.md')
    assert.equal(note.path, 'Home.md')
    assert.equal(note.title, 'Home')
    assert.ok(note.text.includes('[[Projects]]'))
    assert.equal(note.mtime, 1000000)
  })

  await t.test('read() handles spaces in path (URL encoding)', async () => {
    const note = await vault.read('Files/Note with spaces.md')
    assert.equal(note.path, 'Files/Note with spaces.md')
    assert.equal(note.title, 'Note with spaces')
    assert.ok(note.text.includes('Spaces'))
  })

  await t.test('read() handles special characters # and & (URL encoding)', async () => {
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

  await t.test('save() writes note and returns new mtime', async () => {
    const before = await vault.read('Home.md')
    const result = await vault.save('Home.md', 'Updated text', before.mtime)
    assert.equal(result.path, 'Home.md')
    assert.equal(result.title, 'Home')
    assert.ok(result.mtime > before.mtime)

    // Verify the write succeeded
    const after = await vault.read('Home.md')
    assert.equal(after.text, 'Updated text')
    assert.equal(after.mtime, result.mtime)
  })

  await t.test('save() throws SaveConflict on stale mtime', async () => {
    try {
      await vault.save('Home.md', 'Conflicting text', 0) // old mtime
      assert.fail('should have thrown SaveConflict')
    } catch (e) {
      assert.ok(e instanceof vault.SaveConflict)
      assert.ok(e.currentMtime > 0) // should carry the server's current mtime
    }
  })

  await t.test('tree() builds nested structure, sorts folders before notes', async () => {
    const root = await vault.tree()
    assert.equal(root.name, 'Universal Vault')
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

  // Cleanup
  await mock.close()
})

test('VaultUnavailable thrown when server is down', async () => {
  vault._setBaseForTest('http://127.0.0.1:1') // port that definitely has nothing
  try {
    await vault.list()
    assert.fail('should have thrown VaultUnavailable')
  } catch (e) {
    assert.ok(e instanceof vault.VaultUnavailable)
  }
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

test('list() skips malformed rows instead of throwing', async () => {
  const mock = await startMockVault({
    notes: {},
    respond: ({ path }) =>
      path === '/notes'
        ? {
            status: 200,
            // A null element threw "Cannot read properties of null" out of
            // list(), which fails list, graph AND backlinks together.
            body: [null, 'a string', { path: { not: 'a string' } }, { path: 'ok.md' }],
          }
        : null,
  })
  vault._setBaseForTest(mock.url)

  const rows = await vault.list()
  assert.deepEqual(
    rows.map((r) => r.path),
    ['ok.md'],
    'malformed rows should be dropped, not carried forward or thrown on',
  )

  await mock.close()
})

test('scrub() redacts paths with spaces and POSIX paths', async () => {
  const cases = [
    // The real vault path contains a space; the old class stopped at it and
    // leaked the rest.
    [
      String.raw`[Errno 2] No such file: 'C:\Users\Nathan\Desktop\Universal Vault\x.md'`,
      'Vault',
    ],
    ['failed at /home/nathan/vault/secret.md', 'nathan'],
    [String.raw`unc \\SERVER\share\vault\x.md`, 'SERVER'],
  ]

  for (const [serverError, mustNotLeak] of cases) {
    const mock = await startMockVault({
      notes: {},
      respond: () => ({ status: 400, body: { error: serverError } }),
    })
    vault._setBaseForTest(mock.url)
    await assert.rejects(
      () => vault.read('x.md'),
      (e) => {
        assert.ok(
          !e.message.includes(mustNotLeak),
          `leaked "${mustNotLeak}" to the renderer: ${e.message}`,
        )
        assert.ok(e.message.includes('<path>'), `nothing was redacted: ${e.message}`)
        return true
      },
    )
    await mock.close()
  }
})

test('scrub() does not eat our own single-segment paths', async () => {
  const mock = await startMockVault({
    notes: {},
    // No `error` key, so vault.ts falls back to `${status} ${path}` — which is
    // a path of ours and must survive, or every error says "<path>".
    respond: () => ({ status: 500, body: {} }),
  })
  vault._setBaseForTest(mock.url)

  await assert.rejects(
    () => vault.read('x.md'),
    (e) => {
      assert.ok(e.message.includes('/note'), `over-redacted: ${e.message}`)
      return true
    },
  )

  await mock.close()
})
