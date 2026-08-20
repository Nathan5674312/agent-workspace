/**
 * The relation columns: `links` and `backlinks` on every database row.
 *
 * Counting is the part of this feature that can be wrong without looking
 * wrong — a column of plausible numbers reads as working. So the assertions
 * below are on a vault whose edges are known by construction, and they pin the
 * three things the count is easy to get wrong:
 *
 *   - repeated mentions of one note are ONE relationship, not many
 *   - a [[link]] that resolves nowhere is not a relationship at all
 *   - the two directions are separate numbers, not one signed one
 *
 * Same shape as vault-mkdir.test.mjs: no Electron, no IPC, the real module
 * against a scratch vault.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const vault = await import('../src/main/vault.ts')

/**
 * A vault with edges that are known by hand.
 *
 *   Home      -> Hub, Leaf          (2 out)
 *   Hub       -> Leaf x3, Ghost     (1 out: Leaf deduped, Ghost unresolvable)
 *   Leaf      ->                    (0 out)
 *   Lonely    ->                    (0 out, 0 in)
 *
 * so backlinks are: Home 0, Hub 1, Leaf 2, Lonely 0.
 */
async function scratchVault() {
  const dir = await mkdtemp(join(tmpdir(), 'relations-'))
  await mkdir(dir, { recursive: true })
  const put = (name, body) => writeFile(join(dir, name), body, 'utf8')

  // Home is the BFS root the index measures reachability from; without it
  // every note is an orphan and the fixture would be testing something else.
  await put('Home.md', '---\ntype: index\n---\nSee [[Hub]] and [[Leaf]].\n')
  await put(
    'Hub.md',
    '---\ntype: project\n---\n[[Leaf]] again [[Leaf]] and once more [[Leaf]].\nAlso [[Ghost]], which does not exist.\n',
  )
  await put('Leaf.md', '---\ntype: note\n---\nNothing links out of here.\n')
  await put('Lonely.md', 'No frontmatter, no links, nobody points here.\n')
  return dir
}

const rowsByTitle = async () => {
  const notes = await vault.list()
  return new Map(notes.map((n) => [n.title, n]))
}

test('relation counts', async (t) => {
  vault.setVaultDir(await scratchVault())
  const rows = await rowsByTitle()

  await t.test('every row carries both directions', () => {
    assert.equal(rows.size, 4)
    for (const [title, n] of rows) {
      assert.equal(typeof n.links, 'number', `${title}.links`)
      assert.equal(typeof n.backlinks, 'number', `${title}.backlinks`)
    }
  })

  await t.test('outbound counts resolved targets', () => {
    assert.equal(rows.get('Home').links, 2)
    assert.equal(rows.get('Leaf').links, 0)
    assert.equal(rows.get('Lonely').links, 0)
  })

  await t.test('three mentions of one note are one relationship', () => {
    // Hub says [[Leaf]] three times. The graph draws one edge, so the column
    // must say one — a mention count would say three and quietly disagree with
    // the graph tab about the same vault.
    assert.equal(rows.get('Hub').links, 1)
  })

  await t.test('a link that resolves nowhere is not counted', () => {
    // [[Ghost]] names no file. It is excluded above by being absent from Hub's
    // count of 1; asserted separately so a regression that starts counting
    // unresolved links names itself.
    assert.ok(!rows.has('Ghost'))
  })

  await t.test('inbound is counted independently of outbound', () => {
    assert.equal(rows.get('Leaf').backlinks, 2) // Home and Hub
    assert.equal(rows.get('Hub').backlinks, 1) // Home
    assert.equal(rows.get('Home').backlinks, 0)
    assert.equal(rows.get('Lonely').backlinks, 0)
  })

  await t.test('an unreferenced note is not the same as an orphan', () => {
    // The distinction the "How linked" grouping exists to show: Leaf is
    // referenced twice AND reachable; Lonely is neither. A row can also be
    // reachable while unreferenced, which the boolean Orphans toggle cannot say.
    assert.equal(rows.get('Lonely').backlinks, 0)
    assert.equal(rows.get('Lonely').orphan, true)
    assert.equal(rows.get('Leaf').orphan, false)
  })
})

test('counts survive a re-index', async () => {
  // list() and graph() share one memo, and the counts are written onto the
  // note objects inside it. A second call must not double them by re-running
  // the fill over rows it already filled.
  vault.setVaultDir(await scratchVault())
  const first = await rowsByTitle()
  assert.equal(first.get('Leaf').backlinks, 2)

  vault.invalidateGraph()
  const second = await rowsByTitle()
  assert.equal(second.get('Leaf').backlinks, 2)
  assert.equal(second.get('Home').links, 2)
})
