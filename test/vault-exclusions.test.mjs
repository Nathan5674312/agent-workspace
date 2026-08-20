/**
 * Obsidian's own "Excluded files" list (`.obsidian/app.json` →
 * `userIgnoreFilters`), honoured by the vault data layer.
 *
 * Two things are under test and they are not the same thing:
 *
 *  1. The MATCHING RULE. These are vault-root-relative PATH PREFIXES, not the
 *     basenames HIDDEN matches, and a prefix must land on a segment boundary —
 *     `Notes/Private` must not also take `Notes/Private Stuff`. That case is
 *     lifted straight from the live vault, whose filters include
 *     `System/Skill Sources`.
 *  2. That `tree()`, `list()` and `graph()` give the SAME ANSWER. A note
 *     excluded from one but not the others is the defect this exists to remove:
 *     the graph would draw an edge to a node the explorer cannot show.
 *
 * app.json is a file the user edits, so it is untrusted input. Missing,
 * corrupt, or the wrong shape must mean zero extra exclusions and no throw —
 * the posture settings.ts:load() and network.ts's trust store already take.
 *
 * No Electron, no IPC — same shape as vault-mkdir.test.mjs and vault-move.test.mjs.
 */

// Rewrites the sources' NodeNext `./foo.js` specifiers to the `.ts` files they
// actually name, and stubs `electron`. Required by any suite that imports a
// main-process module — vault.ts reaches consent.ts and corner.ts through it.
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Loaded DYNAMICALLY, after the hook above has registered — see the note in
// vault-mkdir.test.mjs.
const vault = await import('../src/main/vault.ts')

/** Every `.md` path in the tree, flattened. */
function treeNotes(node, out = []) {
  if (node.kind === 'note') out.push(node.path)
  node.children?.forEach((c) => treeNotes(c, out))
  return out
}

const sorted = (a) => [...a].sort()

test('obsidian userIgnoreFilters', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'vault-exclusions-'))
  const dir = join(parent, 'vault')
  const appJson = join(dir, '.obsidian', 'app.json')

  await mkdir(join(dir, '.obsidian'), { recursive: true })
  await mkdir(join(dir, 'Notes', 'Private'), { recursive: true })
  await mkdir(join(dir, 'Notes', 'Private Stuff'), { recursive: true })

  // Home.md is where reachability is measured from, and it links to all three
  // so that every note would be a graph NODE with an inbound edge if it were
  // indexed. That is what makes an absence meaningful rather than incidental.
  await writeFile(join(dir, 'Home.md'), '[[Kept]] [[Secret]] [[Public]]\n')
  await writeFile(join(dir, 'Kept.md'), 'plain note\n')
  await writeFile(join(dir, 'Notes', 'Private', 'Secret.md'), 'hidden by obsidian\n')
  await writeFile(join(dir, 'Notes', 'Private Stuff', 'Public.md'), 'not hidden\n')

  vault._setVaultDirForTest(dir)

  /** Rewrite app.json (or remove it) and drop the index memo behind list/graph. */
  const setFilters = async (contents) => {
    if (contents === null) await rm(appJson, { force: true })
    else await writeFile(appJson, contents)
    // The index is memoised for 30s and nothing on disk invalidates it, so
    // without this every case after the first would assert on the first's scan.
    vault.invalidateGraph()
  }

  /** What each of the three consumers believes the vault contains. */
  const views = async () => ({
    tree: sorted(treeNotes(await vault.tree())),
    list: sorted((await vault.list()).map((n) => n.path)),
    graph: sorted((await vault.graph()).nodes),
  })

  const ALL = sorted([
    'Home.md',
    'Kept.md',
    'Notes/Private/Secret.md',
    'Notes/Private Stuff/Public.md',
  ])

  await t.test('a path prefix hides everything under it, in all three views', async () => {
    await setFilters(JSON.stringify({ userIgnoreFilters: ['Notes/Private'] }))
    const v = await views()
    const expected = sorted(['Home.md', 'Kept.md', 'Notes/Private Stuff/Public.md'])
    assert.deepEqual(v.tree, expected)
    assert.deepEqual(v.list, expected)
    assert.deepEqual(v.graph, expected)
  })

  await t.test('the prefix must land on a segment boundary', async () => {
    // The live vault filters `System/Skill Sources`. Matching the bare string
    // would also swallow `System/Skill Sources Extra`, which is a folder the
    // user never excluded. This is the assertion that stops that.
    await setFilters(JSON.stringify({ userIgnoreFilters: ['Notes/Private'] }))
    const v = await views()
    for (const view of Object.values(v)) {
      assert.ok(view.includes('Notes/Private Stuff/Public.md'), JSON.stringify(view))
      assert.ok(!view.includes('Notes/Private/Secret.md'), JSON.stringify(view))
    }
  })

  await t.test('the excluded note is not a graph edge target either', async () => {
    // Home.md links to [[Secret]]. An excluded note that still resolved as a
    // link target would put an edge on the canvas pointing at a node no view
    // can draw — the exact divergence this change exists to remove.
    await setFilters(JSON.stringify({ userIgnoreFilters: ['Notes/Private'] }))
    const g = await vault.graph()
    assert.equal(
      g.links.some((l) => l.to === 'Notes/Private/Secret.md'),
      false,
      JSON.stringify(g.links),
    )
    // The sibling that survived still links, so the absence above is the filter
    // working rather than link resolution being broken outright.
    assert.ok(g.links.some((l) => l.to === 'Notes/Private Stuff/Public.md'))
  })

  await t.test('a missing app.json excludes nothing and does not throw', async () => {
    await setFilters(null)
    const v = await views()
    assert.deepEqual(v.tree, ALL)
    assert.deepEqual(v.list, ALL)
    assert.deepEqual(v.graph, ALL)
  })

  await t.test('corrupt or wrong-shaped app.json excludes nothing and does not throw', async () => {
    // A user-writable file. Every one of these must fall back to defaults the
    // way settings.ts does, not empty the explorer.
    for (const bad of [
      '{ not json at all',
      '',
      'null',
      '[]',
      '"a string"',
      JSON.stringify({ promptDelete: false }), // key absent
      JSON.stringify({ userIgnoreFilters: 'Notes/Private' }), // not an array
      JSON.stringify({ userIgnoreFilters: null }),
      JSON.stringify({ userIgnoreFilters: [42, null, {}] }), // array of junk
    ]) {
      await setFilters(bad)
      const v = await views()
      assert.deepEqual(v.tree, ALL, bad)
      assert.deepEqual(v.list, ALL, bad)
      assert.deepEqual(v.graph, ALL, bad)
    }
  })

  await t.test('a /regex/ filter is skipped, not crashed on', async () => {
    // Obsidian also accepts a regex form in this field. It is deliberately not
    // implemented; the requirement is only that it costs nothing and takes
    // nothing with it. The plain prefix beside it must still work.
    await setFilters(
      JSON.stringify({ userIgnoreFilters: ['/^Notes.*/', 'Notes/Private'] }),
    )
    const v = await views()
    const expected = sorted(['Home.md', 'Kept.md', 'Notes/Private Stuff/Public.md'])
    assert.deepEqual(v.tree, expected)
    assert.deepEqual(v.list, expected)
    assert.deepEqual(v.graph, expected)
  })

  await t.test('a trailing slash on a filter changes nothing', async () => {
    await setFilters(JSON.stringify({ userIgnoreFilters: ['Notes/Private/'] }))
    const v = await views()
    const expected = sorted(['Home.md', 'Kept.md', 'Notes/Private Stuff/Public.md'])
    assert.deepEqual(v.tree, expected)
    assert.deepEqual(v.list, expected)
    assert.deepEqual(v.graph, expected)
  })

  await t.test('a filter naming one file excludes exactly that file', async () => {
    await setFilters(JSON.stringify({ userIgnoreFilters: ['Kept.md'] }))
    const v = await views()
    const expected = sorted([
      'Home.md',
      'Notes/Private/Secret.md',
      'Notes/Private Stuff/Public.md',
    ])
    assert.deepEqual(v.tree, expected)
    assert.deepEqual(v.list, expected)
    assert.deepEqual(v.graph, expected)
  })
})
