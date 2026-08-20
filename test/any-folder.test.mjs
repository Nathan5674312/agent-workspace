/**
 * POINT THE APP AT ANY FOLDER AND IT INDEXES THE WHOLE THING.
 *
 * The bug this exists for: `SKIP` in vault.ts was one specific vault's layout,
 * hardcoded — `graphify-out/`, `System/Skills/gstack/`, `System/Skill Sources/`,
 * `Templates/` and `Inbox/`, ported from a note server's `links.py` where they
 * had been tuned against a single person's notes.
 *
 * `Templates` and `Inbox` are Obsidian's OWN conventions. They ship in its
 * default vault and appear in most community starter kits. So opening any
 * ordinary vault silently dropped every file under either name, and
 * `checkRoots()` reported no problem — the tree just quietly had holes in it.
 *
 * Per-vault exclusions belong in `.obsidian/app.json` → `userIgnoreFilters`,
 * which `ignoreFilters()` already reads and which is the same setting
 * Obsidian's "Files and links → Excluded files" writes. One mechanism, owned
 * by the user, agreed on by both apps.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const vault = await import('../src/main/vault.ts')

const made = []
function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'any-folder-'))
  made.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return dir
}

test.after(() => {
  for (const d of made) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

test('an ordinary vault indexes every markdown file in it', async () => {
  const files = {
    'Home.md': '# Home\n\n[[Notes/Reading]] [[Projects/Website]]\n',
    'Notes/Reading.md': '# Reading\n\n[[Home]]\n',
    'Daily/2026-08-19.md': '# Today\n\n[[Home]]\n',
    'Projects/Website.md': '# Website\n\n[[Home]]\n',
    // Obsidian ships both of these in its default vault.
    'Templates/Daily note.md': '# {{date}}\n',
    'Inbox/Clipped.md': '# Clipped\n\n[[Notes/Reading]]\n',
  }
  vault._setVaultDirForTest(scratch(files))
  const notes = await vault.list()
  const seen = new Set(notes.map((n) => n.path))

  for (const rel of Object.keys(files)) {
    assert.ok(seen.has(rel), `${rel} is on disk but invisible to the app`)
  }
  assert.equal(notes.length, Object.keys(files).length)
})

test('Templates and Inbox are the specific regression', async () => {
  // Named on their own because these two are the ones that made a stock
  // Obsidian vault open with holes in it.
  vault._setVaultDirForTest(
    scratch({
      'Home.md': '# Home\n',
      'Templates/Meeting.md': '# Meeting\n',
      'Inbox/Voice memo.md': '# Memo\n',
    }),
  )
  const seen = new Set((await vault.list()).map((n) => n.path))
  assert.ok(seen.has('Templates/Meeting.md'), 'Templates/ is being dropped again')
  assert.ok(seen.has('Inbox/Voice memo.md'), 'Inbox/ is being dropped again')
})

test('no folder name from one particular vault is hardcoded any more', async () => {
  // These were in SKIP. They describe one person's vault, not a note app.
  vault._setVaultDirForTest(
    scratch({
      'Home.md': '# Home\n',
      'graphify-out/report.md': '# Report\n',
      'System/Skills/gstack/SKILL.md': '# Skill\n',
      'System/Skill Sources/x/SKILL.md': '# Skill\n',
    }),
  )
  const seen = new Set((await vault.list()).map((n) => n.path))
  assert.equal(seen.size, 4, `expected all 4 indexed, got ${[...seen].join(', ')}`)
})

test('the app still ignores its OWN backup directory', async () => {
  // The one exclusion that is true of every vault, because this app writes it.
  // Indexing it would count every historical copy of a note as a note.
  vault._setVaultDirForTest(
    scratch({
      'Home.md': '# Home\n',
      '.backups/Home.md/2026-08-19T00-00-00.md': '# old copy\n',
    }),
  )
  const seen = new Set((await vault.list()).map((n) => n.path))
  assert.ok(seen.has('Home.md'))
  assert.equal(seen.size, 1, 'a backup copy was counted as a note')
})

test("a vault's own userIgnoreFilters are still honoured", async () => {
  // Exclusions did not disappear, they moved to where the user controls them —
  // the same file Obsidian's "Excluded files" setting writes.
  vault._setVaultDirForTest(
    scratch({
      '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['Archive'] }),
      'Home.md': '# Home\n',
      'Archive/old.md': '# Old\n',
      'Notes/keep.md': '# Keep\n',
    }),
  )
  const seen = new Set((await vault.list()).map((n) => n.path))
  assert.ok(seen.has('Home.md'))
  assert.ok(seen.has('Notes/keep.md'))
  assert.ok(!seen.has('Archive/old.md'), 'userIgnoreFilters stopped being read')
})
