/**
 * POINT THE VAULT AT ANY FOLDER ON THE MACHINE AND EVERY VIEW WORKS.
 *
 * The app was built against one Obsidian vault and quietly assumed it. Measured
 * across ten real locations before this, only two worked end to end; the other
 * eight failed in one of three ways:
 *
 *   1. ONLY `.md` EXISTED. `Downloads`, `Documents`, `Pictures`,
 *      `System32\drivers\etc` and this repo's own `src/` each showed an empty
 *      explorer and zero database rows while being full of files.
 *   2. ONLY `[[wikilinks]]` COUNTED. `agent-workspace` produced 24 notes and 0
 *      links, `cc-extension` 10 and 0 — not because those repos are
 *      unconnected but because a README says `[spec](docs/SPEC.md)`.
 *   3. EXCLUSIONS WERE ANCHORED TO THE ROOT. Opening a vault's SUBfolder made
 *      every `System/…` filter miss, so `Universal Vault\System` indexed 1179
 *      files against 13 links.
 *
 * These pin the fixed contract. They are deliberately about folders that are
 * NOT vaults, because that is the case the app kept getting wrong.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const vault = await import('../src/main/vault.ts')

/** Build a directory from a {relative path: contents} map. Buffers allowed. */
async function build(spec) {
  const dir = await mkdtemp(join(tmpdir(), 'anyloc-'))
  for (const [rel, body] of Object.entries(spec)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body)
  }
  vault.invalidateGraph()
  vault.setVaultDir(dir)
  return dir
}

const paths = async () => (await vault.list()).map((n) => n.path).sort()
const content = (g) => g.links.filter((l) => l.kind === 'content')
const structure = (g) => g.links.filter((l) => l.kind === 'structure')

/** Is every node reachable from every other, ignoring edge direction? */
function connected(g) {
  if (g.nodes.length < 2) return true
  const adj = new Map()
  const link = (a, b) => {
    const l = adj.get(a)
    if (l) l.push(b)
    else adj.set(a, [b])
  }
  for (const l of g.links) {
    link(l.from, l.to)
    link(l.to, l.from)
  }
  const seen = new Set([g.nodes[0]])
  const q = [g.nodes[0]]
  for (let i = 0; i < q.length; i++) {
    for (const n of adj.get(q[i]) ?? []) {
      if (seen.has(n)) continue
      seen.add(n)
      q.push(n)
    }
  }
  return seen.size === g.nodes.length
}

// ------------------------------------------------------------- any file type

test('a folder with no markdown at all is still indexed', async () => {
  await build({
    'main.py': 'print("hi")',
    'config.yaml': 'key: value',
    'notes.txt': 'plain text',
    'Makefile': 'all:\n\techo hi\n', // no extension at all
  })
  assert.deepEqual(await paths(), ['Makefile', 'config.yaml', 'main.py', 'notes.txt'])
})

test('a binary is LISTED but never read as text', async () => {
  // Listed, because a folder of photographs that renders empty is the bug.
  // Never read, because the editor round-trips through a string and a UTF-8
  // decode of a PNG does not display it badly, it destroys it on save.
  await build({
    'photo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
    'readme.txt': 'text',
  })
  assert.deepEqual(await paths(), ['photo.png', 'readme.txt'])
  await assert.rejects(() => vault.read('photo.png'), /not a text file/)
  assert.equal((await vault.read('readme.txt')).text, 'text')
})

test('an unknown extension is treated as text rather than skipped', async () => {
  // The denylist direction matters: an allowlist of "text extensions" makes
  // every format nobody thought of open as an empty folder.
  await build({ 'thing.wibble': 'see [[other]]', 'other.md': 'x' })
  assert.ok((await paths()).includes('thing.wibble'))
})

// ------------------------------------------------------- connections, unaided

test('markdown links connect a repo that has never seen a wikilink', async () => {
  const g = await (async () => {
    await build({
      'README.md': 'the [spec](docs/SPEC.md) and the [guide](./docs/GUIDE.md)',
      'docs/SPEC.md': 'spec',
      'docs/GUIDE.md': 'guide',
    })
    return vault.graph()
  })()
  const from = content(g)
    .filter((l) => l.from === 'README.md')
    .map((l) => l.to)
    .sort()
  assert.deepEqual(from, ['docs/GUIDE.md', 'docs/SPEC.md'])
})

test('a bare relative path in source connects to the file it names', async () => {
  await build({
    'src/app.ts': "import './util.ts'\nsee src/deep/thing.ts for the rest",
    'src/util.ts': 'util',
    'src/deep/thing.ts': 'thing',
  })
  const to = content(await vault.graph())
    .filter((l) => l.from === 'src/app.ts')
    .map((l) => l.to)
    .sort()
  assert.deepEqual(to, ['src/deep/thing.ts', 'src/util.ts'])
})

test('a folder with NO links of any kind still renders as one connected graph', async () => {
  // The `Pictures` case: 26 files, 0 possible content links. Without the
  // structural edges this is a field of unconnected dots, which is what "the
  // graph is broken everywhere except my vault" actually looked like.
  await build({
    'a.png': Buffer.from([1, 2, 3]),
    'b.png': Buffer.from([4, 5, 6]),
    'shots/c.png': Buffer.from([7, 8, 9]),
    'shots/d.png': Buffer.from([10, 11, 12]),
  })
  const g = await vault.graph()
  assert.equal(g.nodes.length, 4)
  assert.equal(content(g).length, 0, 'there is nothing here that could be a content link')
  assert.ok(structure(g).length > 0, 'no structural edges were emitted')
  assert.ok(connected(g), 'the graph is in pieces')
})

test('structural edges never inflate the counts the database reports', async () => {
  // They are drawn, not counted. `orphan`, `links` and `backlinks` stay
  // content-only, or the Orphans filter and the "How linked" grouping would
  // silently start reporting that everything is connected to something.
  await build({ 'a.md': 'no links', 'b.md': 'no links either' })
  const rows = await vault.list()
  assert.ok(connected(await vault.graph()), 'precondition: joined by structure')
  for (const r of rows) {
    assert.equal(r.links, 0, `${r.path} counted a structural edge as its own link`)
    assert.equal(r.backlinks, 0, `${r.path} counted a structural edge as a backlink`)
    assert.equal(r.orphan, true, `${r.path} stopped being an orphan without being linked`)
  }
})

// ------------------------------------------------- the root can sit anywhere

test('opening a SUBfolder of a vault still honours that vault\'s exclusions', async () => {
  // The filters live one level UP from the open root, so the walk never passes
  // them. Measured: `Universal Vault\System` indexed 1179 files against 13
  // links because every `System/…` prefix stopped matching from inside System.
  const dir = await build({
    '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ['System/Skills/bundled'] }),
    'System/Keep.md': 'kept',
    'System/Skills/bundled/SKILL.md': 'excluded by the vault itself',
    'System/Skills/mine/SKILL.md': 'kept',
  })

  vault.invalidateGraph()
  vault.setVaultDir(join(dir, 'System'))
  const inside = await paths()
  assert.ok(!inside.some((p) => p.includes('bundled')), `bundled leaked in: ${inside}`)
  assert.deepEqual(inside, ['Keep.md', 'Skills/mine/SKILL.md'])
})

test('the same files are indexed whether opened at, above, or below the vault', async () => {
  const dir = await build({
    'Vault/.obsidian/app.json': '{}',
    'Vault/Home.md': 'see [[Note]]',
    'Vault/Note.md': 'back to [[Home]]',
  })

  vault.invalidateGraph()
  vault.setVaultDir(join(dir, 'Vault'))
  const at = await paths()
  assert.deepEqual(at, ['Home.md', 'Note.md'])
  const atLinks = content(await vault.graph()).length

  vault.invalidateGraph()
  vault.setVaultDir(dir)
  const above = (await paths()).map((p) => p.replace(/^Vault\//, ''))
  assert.deepEqual(above, at, 'the same vault indexed differently from one level up')
  assert.equal(
    content(await vault.graph()).length,
    atLinks,
    'edges were lost or invented by moving the root',
  )
})
