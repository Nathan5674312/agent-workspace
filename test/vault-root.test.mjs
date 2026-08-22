/**
 * The three failures that made a vault look fine and be wrong.
 *
 * All of them shared a shape: something in `vault.ts` is relative to
 * VAULT_DIR, the configured root was one level too high, and NOTHING said so.
 * Measured on the real machine at the time: 379 explicitly-excluded files came
 * back, notes went 280 -> 1419, links FELL 653 -> 563, and 1419 of 1419 notes
 * were flagged orphan.
 *
 * These assert the guards, not the anecdote. Same shape as vault-mkdir: the
 * real module against scratch directories.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const vault = await import('../src/main/vault.ts')

/** Build a directory tree from a {relative path: contents} map. */
async function build(spec) {
  const dir = await mkdtemp(join(tmpdir(), 'vaultroot-'))
  for (const [rel, body] of Object.entries(spec)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
  return dir
}

const rows = async () => new Map((await vault.list()).map((n) => [n.path, n]))

// ---------------------------------------------------------------- the root

/**
 * A vault opened from its PARENT must index exactly as it does opened directly.
 *
 * These four replace two tests that asserted a WARNING here instead. The
 * warning was the wrong repair and was rejected as such: it told the user not
 * to point the app above a vault rather than making that work. Everything it
 * described was real — notes 281 -> 1420, links FALLING 657 -> 567, 1344 of
 * 1420 orphan — and all of it came from three separate root-anchored
 * assumptions, each now fixed at its source. These pin the outcome the warning
 * was standing in for.
 */
test('a nested vault keeps its OWN exclusions when opened from the parent', async () => {
  // ignoreFilters() read <root>/.obsidian/app.json and nothing else, so from
  // one level up a vault's userIgnoreFilters were not merely mis-anchored, they
  // were never found — the parent's app.json, or none, answered instead.
  const dir = await build({
    'Real Vault/.obsidian/app.json': JSON.stringify({
      userIgnoreFilters: ['Skills/bundled'],
    }),
    'Real Vault/Home.md': 'Hello [[Note]]',
    'Real Vault/Note.md': 'A note',
    'Real Vault/Skills/bundled/SKILL.md': 'third-party noise',
    'Real Vault/Skills/bundled/OTHER.md': 'more noise',
  })

  vault.setVaultDir(join(dir, 'Real Vault'))
  const inside = (await vault.list()).map((n) => n.path).sort()
  assert.deepEqual(inside, ['Home.md', 'Note.md'], 'precondition: the filter works at the root')

  vault.invalidateGraph()
  vault.setVaultDir(dir)
  const above = (await vault.list()).map((n) => n.path).sort()
  assert.deepEqual(
    above,
    ['Real Vault/Home.md', 'Real Vault/Note.md'],
    'the vault stopped honouring its own excluded-files list from one level up',
  )
})

test('a root with its own .obsidian still honours a nested vault below it', async () => {
  // Pointing Obsidian at a folder CREATES an .obsidian/ in it, so the parent
  // very often carries the marker too — C:\Users\Nathan\Desktop\.obsidian\ was
  // written by Obsidian at 19:19 on the day this was found. The parent having
  // one must not stop the child's filters being read.
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Real Vault/.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['Junk'] }),
    'Real Vault/Home.md': 'Hello [[Note]]',
    'Real Vault/Note.md': 'A note',
    'Real Vault/Junk/Ignored.md': 'excluded by the vault itself',
  })
  vault.setVaultDir(dir)
  const paths = (await vault.list()).map((n) => n.path)
  assert.ok(
    !paths.some((p) => p.includes('Junk')),
    "the parent's own .obsidian suppressed the child's filters",
  )
})

test('a path-form wikilink still resolves when the vault is opened from above', async () => {
  // [[Daily/_Template]] is a path relative to ITS vault's root. Only `n.path`
  // was registered as a key, so from one level up it became
  // "real vault/daily/_template" while the link still said "daily/_template"
  // and matched nothing at all. Measured on the real vault: 100 of 657 edges
  // silently disappeared, 0 gained — dropped, not mis-routed.
  const dir = await build({
    'Real Vault/.obsidian/app.json': '{}',
    'Real Vault/Home.md': 'see [[Daily/_Template|the template]]',
    'Real Vault/Daily/_Template.md': 'the template',
  })

  vault.setVaultDir(join(dir, 'Real Vault'))
  assert.equal(
    (await vault.graph()).links.find((l) => l.from === 'Home.md')?.to,
    'Daily/_Template.md',
    'precondition: the path form resolves at the root',
  )

  vault.invalidateGraph()
  vault.setVaultDir(dir)
  assert.equal(
    (await vault.graph()).links.find((l) => l.from === 'Real Vault/Home.md')?.to,
    'Real Vault/Daily/_Template.md',
    'the edge was dropped rather than re-anchored',
  )
})

test('a root above a vault no longer warns about being above a vault', async () => {
  // The behaviour asked for in as many words: open any folder and have it work,
  // rather than be told off for opening it.
  const dir = await build({
    'Real Vault/.obsidian/app.json': '{}',
    'Real Vault/Home.md': 'Hello [[Note]]',
    'Real Vault/Note.md': 'back to [[Home]]',
  })
  vault.setVaultDir(dir)
  assert.equal(await vault.checkRoots(), null)
})

test('a real vault root passes', async () => {
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': 'Hello [[Note]]',
    'Note.md': 'A note',
  })
  vault.setVaultDir(dir)
  assert.equal(await vault.checkRoots(), null)
})

// --------------------------------------------------------- reachability root

test('pickRoot prefers Home.md at the root', () => {
  const notes = [{ path: 'Home.md' }, { path: 'Hub.md' }]
  // Hub has more inbound links and still loses: the declared root is the point.
  assert.equal(vault.pickRoot(notes, new Map([['Hub.md', 99]])), 'Home.md')
})

test('pickRoot falls back to the best-connected note', () => {
  const notes = [{ path: 'A.md' }, { path: 'B.md' }, { path: 'C.md' }]
  const inbound = new Map([
    ['A.md', 2],
    ['B.md', 7],
    ['C.md', 1],
  ])
  assert.equal(vault.pickRoot(notes, inbound), 'B.md')
})

test('pickRoot is stable when the best is tied', () => {
  const notes = [{ path: 'Z.md' }, { path: 'A.md' }]
  const tied = new Map([
    ['Z.md', 3],
    ['A.md', 3],
  ])
  // Ties break on path, so a rescan cannot silently rewire every depth.
  assert.equal(vault.pickRoot(notes, tied), 'A.md')
  assert.equal(vault.pickRoot([...notes].reverse(), tied), 'A.md')
})

test('pickRoot returns null only when nothing links to anything', () => {
  assert.equal(vault.pickRoot([{ path: 'A.md' }], new Map()), null)
})

test('a vault with no Home.md still measures reachability from somewhere', async () => {
  // THE BUG: this used to leave every note with depth null and orphan true,
  // because the BFS started at a Home.md that was not in the graph.
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Index.md': 'The hub: [[One]] and [[Two]]',
    'One.md': 'see [[Index]]',
    'Two.md': 'see [[Index]]',
    'Lost.md': 'nobody links here and it links nowhere',
  })
  vault.setVaultDir(dir)
  const r = await rows()

  assert.equal(r.get('Index.md').reachRoot, 'Index.md', 'the hub should be the root')
  assert.equal(r.get('Index.md').depth, 0)
  assert.equal(r.get('One.md').depth, 1)
  assert.equal(r.get('One.md').orphan, false)
  // Exactly one genuine orphan, not four.
  assert.equal([...r.values()].filter((n) => n.orphan).length, 1)
  assert.equal(r.get('Lost.md').orphan, true)
})

test('every row carries the root its orphan flag was measured from', async () => {
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': '[[A]]',
    'A.md': 'a',
  })
  vault.setVaultDir(dir)
  for (const n of (await rows()).values()) assert.equal(n.reachRoot, 'Home.md')
})

// ----------------------------------------------------- traversal budget

test('a tree deeper than the cap is truncated, and says so', async () => {
  // The walk had no bound of any kind. Pointing the vault at a home directory
  // was measured at >30s and never finished; a drive root at 27.5s and 44 560
  // folders. Both are one click away in a picker that opens inside your vault.
  const dir = await build({ '.obsidian/app.json': '{}', 'Home.md': 'root' })
  // 20 levels, past MAX_TREE_DEPTH of 16, with a note at the bottom.
  const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/')
  await build({}) // no-op, keeps the helper honest about returning a fresh dir
  await mkdir(join(dir, deep), { recursive: true })
  await writeFile(join(dir, deep, 'Buried.md'), 'too deep', 'utf8')

  vault.setVaultDir(dir)
  const notes = await vault.list()

  assert.ok(
    !notes.some((n) => n.path.endsWith('Buried.md')),
    'a note past the depth cap was indexed anyway',
  )
  const msg = vault.getTreeTruncation()
  assert.ok(msg, 'truncating silently is the failure this cap exists to avoid')
  assert.match(msg, /deeper than/i)
  // And the boot check must lead with it, because every count below a
  // truncated walk is a floor rather than a total.
  assert.match((await vault.checkRoots()) ?? '', /deeper than/i)
})

test('a walk that completes reports no truncation', async () => {
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': '[[A]]',
    'Deep/Deeper/A.md': 'a',
  })
  vault.setVaultDir(dir)
  await vault.list()
  assert.equal(vault.getTreeTruncation(), null, 'a stale truncation would condemn a healthy vault')
})

// ------------------------------------------------------- link resolution

test('a duplicate filename resolves to the nearest note, not the first scanned', async () => {
  // 633 files in the real vault are named SKILL.md. First-wins made every
  // reference to any of them point at whichever sorted first.
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': 'root',
    'Alpha/SKILL.md': 'alpha skill, see [[Home]]',
    'Alpha/Use.md': 'uses [[SKILL]]',
    'Beta/SKILL.md': 'beta skill',
    'Beta/Use.md': 'uses [[SKILL]]',
  })
  vault.setVaultDir(dir)
  const g = await vault.graph()
  const to = (from) => g.links.filter((l) => l.from === from).map((l) => l.to)

  assert.deepEqual(to('Alpha/Use.md'), ['Alpha/SKILL.md'], 'Alpha linked out of its folder')
  assert.deepEqual(to('Beta/Use.md'), ['Beta/SKILL.md'], 'Beta linked out of its folder')
})

test('a link from a subfolder resolves upward before jumping across the vault', async () => {
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': 'root',
    'Work/Index.md': 'the work index',
    'Work/Deep/Deeper/Note.md': 'see [[Index]]',
    'Other/Index.md': 'unrelated index',
  })
  vault.setVaultDir(dir)
  const g = await vault.graph()
  const target = g.links.find((l) => l.from === 'Work/Deep/Deeper/Note.md')?.to
  assert.equal(target, 'Work/Index.md', 'resolved across the vault instead of up its own tree')
})

test('a filename always beats another note\'s frontmatter title', async () => {
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': 'see [[Target]]',
    'Target.md': 'the real file',
    'Impostor.md': '---\ntitle: Target\n---\naliased',
  })
  vault.setVaultDir(dir)
  const g = await vault.graph()
  assert.deepEqual(
    g.links.filter((l) => l.from === 'Home.md').map((l) => l.to),
    ['Target.md'],
  )
})

test('an unresolvable collision is at least stable across rescans', async () => {
  const dir = await build({
    '.obsidian/app.json': '{}',
    'Home.md': 'see [[Dup]]',
    'Zed/Dup.md': 'one',
    'Ann/Dup.md': 'two',
  })
  vault.setVaultDir(dir)
  const first = (await vault.graph()).links.find((l) => l.from === 'Home.md')?.to
  vault.invalidateGraph()
  const second = (await vault.graph()).links.find((l) => l.from === 'Home.md')?.to
  assert.equal(first, second, 'the same link resolved two ways on two scans')
  assert.ok(first, 'it must still resolve to something')
})
