/**
 * DERIVED FACETS: TAGS NOBODY HAS TO MAINTAIN.
 *
 * The claim is that these are FACTS rather than guesses, so the tests are mostly
 * about the places a lazier version would start guessing and get away with it
 * until someone trusted it.
 *
 * Three matter more than the rest:
 *
 *   A date comes from the FILENAME and never from `mtime`. A filesystem
 *   timestamp is rewritten by a git checkout, a sync client, a backup restore
 *   and this app's own save, so deriving "when this note is about" from it would
 *   be wrong for whole folders at once, in a way nobody would think to check.
 *
 *   `about` needs a strict MAJORITY and at least three neighbours. A plurality
 *   version fires on three folders holding two notes each and says nothing; a
 *   two-neighbour version fires on a coincidence, constantly, on a sparse vault.
 *
 *   Nothing is emitted for the ordinary. There is no `leaf` facet, because a
 *   label on four notes in five carries no information and buries the ones that
 *   do.
 *
 * Pure module. No filesystem, no DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { facets, facetKeys, dateFromName, hubThreshold, neighbourhoods } = await import(
  '../src/shared/facets.ts'
)

/** Most tests do not care about the graph; this is a note with no links. */
const alone = { neighbours: [], degrees: [] }
const hood = (neighbours, degrees = [1, 1, 1, 1, 1]) => ({ neighbours, degrees })
const keys = (p, h = alone) => facetKeys(facets(p, h))

// -------------------------------------------------------------------- folder

test('every ancestor folder is a facet, so a filter can sit at any depth', () => {
  const k = keys('Fate/Roadmap/07 - Agents.md')
  assert.ok(k.includes('folder:Fate'))
  assert.ok(k.includes('folder:Fate/Roadmap'))
})

test('a note at the vault root has no folder facet rather than an empty one', () => {
  assert.deepEqual(
    facets('Home.md', alone).filter((f) => f.kind === 'folder'),
    [],
  )
})

test('coverage is total: every note in a folder gets one, with nothing written down', () => {
  // The entire argument for this file. tags: reached 131 of 1999 notes; this
  // reaches all of them because it is reading the path they already have.
  for (const p of ['a/b.md', 'x/y/z.md', 'Inbox/20260806-125145.md', 'Daily/2026-08-19.md']) {
    assert.ok(keys(p).some((k) => k.startsWith('folder:')), `${p} got no folder facet`)
  }
})

// ---------------------------------------------------------------------- date

test('both date shapes this vault actually uses are read', () => {
  assert.equal(dateFromName('Daily/2026-08-19.md'), '2026-08-19')
  assert.equal(dateFromName('Inbox/20260816-001623-765928.md'), '2026-08-16')
  assert.equal(dateFromName('Inbox/20260806-125145.md'), '2026-08-06')
})

test('a number that is not a date does not become one', () => {
  // The failure mode is silent: a wrong date looks exactly like a right one.
  assert.equal(dateFromName('07 - Agents That Act on the Vault.md'), null)
  assert.equal(dateFromName('12345678-notes.md'), null, 'month 34 was accepted')
  assert.equal(dateFromName('20261301-x.md'), null, 'month 13 was accepted')
  assert.equal(dateFromName('20260832-x.md'), null, 'day 32 was accepted')
  assert.equal(dateFromName('20260806.md'), null, 'a bare number matched without a separator')
})

test('the date facet says out loud that it did not come from a timestamp', () => {
  const f = facets('Daily/2026-08-19.md', alone).find((x) => x.kind === 'date')
  assert.equal(f.value, '2026-08-19')
  assert.match(f.why, /never from the file's timestamp/)
})

// --------------------------------------------------------------------- shape

test('a note nothing links to is an orphan', () => {
  const f = facets('Notes/Forgotten.md', alone).find((x) => x.kind === 'shape')
  assert.equal(f.value, 'orphan')
  assert.match(f.why, /only reachable by remembering it exists/)
})

test('nothing is said about an ordinary note', () => {
  // No 'leaf', no 'connected'. A label four notes in five carry is noise.
  const degrees = [1, 1, 1, 1, 1, 1, 1, 1, 9, 9]
  assert.deepEqual(
    facets('Notes/Ordinary.md', hood(['Notes/A.md'], degrees)).filter((f) => f.kind === 'shape'),
    [],
  )
})

test('a hub is the top tenth of THIS vault, not a fixed number', () => {
  // A constant right for 200 notes labels half of 12 000 a hub. Relative, so the
  // same note is a hub in a sparse vault and ordinary in a dense one.
  const sparse = [0, 1, 1, 1, 1, 1, 1, 1, 1, 4]
  const dense = Array.from({ length: 100 }, (_, i) => i)
  assert.equal(hubThreshold(sparse), 4)
  assert.equal(hubThreshold(dense), 90)

  const four = ['a.md', 'b.md', 'c.md', 'd.md']
  assert.ok(keys('X.md', hood(four, sparse)).includes('shape:hub'))
  assert.ok(!keys('X.md', hood(four, dense)).includes('shape:hub'))
})

test('a nearly empty vault does not crown a note with two links', () => {
  // The floor under the percentile. Without it the first note to get a second
  // link becomes a hub, which is true of the arithmetic and useless to a person.
  assert.equal(hubThreshold([0, 0, 2]), 3)
  assert.ok(!keys('X.md', hood(['a.md', 'b.md'], [0, 0, 2])).includes('shape:hub'))
})

test('an orphan is never also a hub', () => {
  const shapes = facets('X.md', hood([], [0])).filter((f) => f.kind === 'shape')
  assert.equal(shapes.length, 1)
  assert.equal(shapes[0].value, 'orphan')
})

// --------------------------------------------------------------------- about

test('a note is about where its neighbours live, when that is not where it lives', () => {
  // The case this exists for: captured into Inbox, entirely about the roadmap.
  const k = keys(
    'Inbox/20260816-001623-765928.md',
    hood(['Fate/Roadmap/07 - Agents.md', 'Fate/Roadmap/08 - Product.md', 'Fate/Roadmap/00 - INDEX.md']),
  )
  assert.ok(k.includes('about:Fate/Roadmap'))
})

test('a plurality is not enough, only a majority', () => {
  // Three folders holding two notes each says nothing at all.
  const k = keys('Inbox/x.md', hood(['A/1.md', 'A/2.md', 'B/1.md', 'B/2.md', 'C/1.md', 'C/2.md']))
  assert.ok(!k.some((x) => x.startsWith('about:')), 'a 2-of-6 plurality was reported as about')
})

test('two neighbours is a coincidence, not a signal', () => {
  const k = keys('Inbox/x.md', hood(['Fate/a.md', 'Fate/b.md']))
  assert.ok(!k.some((x) => x.startsWith('about:')))
})

test('a note whose neighbours share its own folder gets no about facet', () => {
  // It would only repeat the folder facet that is already there.
  const k = keys('Fate/x.md', hood(['Fate/a.md', 'Fate/b.md', 'Fate/c.md']))
  assert.ok(!k.some((x) => x.startsWith('about:')))
  assert.ok(k.includes('folder:Fate'))
})

test('being connected to your own branch of the tree is not news', () => {
  // Found by running this over the real vault, where half the `about` facets
  // produced were "this note in Fate/Inner Circle Barbershop is about Fate" —
  // true, and exactly what the folder facets already said. A parent, and a
  // child, are both suppressed.
  const parent = keys('Fate/Barbershop/02 - Instagram.md', hood(['Fate/a.md', 'Fate/b.md', 'Fate/c.md']))
  assert.ok(!parent.some((x) => x.startsWith('about:')), 'a parent folder was reported as about')

  const child = keys('Fate/x.md', hood(['Fate/Deep/a.md', 'Fate/Deep/b.md', 'Fate/Deep/c.md']))
  assert.ok(!child.some((x) => x.startsWith('about:')), 'a child folder was reported as about')
})

test('a genuinely different branch still reports, which is the whole point', () => {
  // The case worth keeping: a playbook filed under Fate, built out of
  // transcripts filed somewhere else. Nothing in the path says so.
  const k = keys(
    'Fate/Roy Lee/01 - Principles.md',
    hood(['Transcripts/Roy Lee/a.md', 'Transcripts/Roy Lee/b.md', 'Transcripts/Roy Lee/c.md']),
  )
  assert.ok(k.includes('about:Transcripts/Roy Lee'))
})

test('the about facet shows its working, because it is the surprising one', () => {
  const f = facets('Inbox/x.md', hood(['Fate/a.md', 'Fate/b.md', 'Fate/c.md'])).find(
    (x) => x.kind === 'about',
  )
  assert.match(f.why, /3 of 3 linked notes live in Fate/)
})

// ------------------------------------------------------------------ contract

test('every facet can explain itself', () => {
  // A facet that cannot justify itself is indistinguishable from one made up.
  const all = facets(
    'Inbox/20260816-001623-765928.md',
    hood(['Fate/Roadmap/a.md', 'Fate/Roadmap/b.md', 'Fate/Roadmap/c.md'], [1, 1, 1, 1, 3]),
  )
  assert.ok(all.length > 0)
  for (const f of all) {
    assert.ok(f.why && f.why.length > 20, `${f.kind}:${f.value} has no explanation`)
    assert.ok(f.value !== '', `${f.kind} has an empty value`)
  }
})

// -------------------------------------------------- the whole vault at once

test('neighbourhoods builds an undirected, deduplicated adjacency', () => {
  // Same rule the graph draws by: a note linking to another three times is one
  // neighbour, and both ends see each other.
  const { hoods } = neighbourhoods(
    ['a.md', 'b.md', 'c.md'],
    [
      { from: 'a.md', to: 'b.md' },
      { from: 'a.md', to: 'b.md' },
      { from: 'c.md', to: 'a.md' },
    ],
  )
  assert.deepEqual(hoods.get('a.md').neighbours.sort(), ['b.md', 'c.md'])
  assert.deepEqual(hoods.get('b.md').neighbours, ['a.md'])
  assert.deepEqual(hoods.get('c.md').neighbours, ['a.md'])
})

test('the hub threshold is computed once for the whole set, not per note', () => {
  // The reason this function exists. facets() defaults hubAt to
  // hubThreshold(degrees), which sorts the entire array — calling it per row is
  // 465 sorts of a 465-element array to produce one unchanging number.
  const paths = Array.from({ length: 20 }, (_, i) => `n${i}.md`)
  const links = paths.slice(1).map((p) => ({ from: 'n0.md', to: p }))
  const { hoods, hubAt } = neighbourhoods(paths, links)
  assert.equal(hubAt, hubThreshold([...hoods.values()][0].degrees))
  // And passing it explicitly gives the same answer as letting it default.
  const hood = hoods.get('n0.md')
  assert.deepEqual(facetKeys(facets('n0.md', hood, hubAt)), facetKeys(facets('n0.md', hood)))
})

test('an edge naming a note outside the set still counts for the end inside it', () => {
  // A link out of the vault says something about the note that made it.
  // Dropping it would understate that note's degree and could cost it `hub`.
  const { hoods } = neighbourhoods(['a.md'], [{ from: 'a.md', to: 'somewhere-else.md' }])
  assert.deepEqual(hoods.get('a.md').neighbours, ['somewhere-else.md'])
})

test('no links at all makes every note an orphan rather than throwing', () => {
  const { hoods, hubAt } = neighbourhoods(['a.md', 'b.md'], [])
  for (const p of ['a.md', 'b.md']) {
    assert.ok(facetKeys(facets(p, hoods.get(p), hubAt)).includes('shape:orphan'))
  }
})

test('facets are computed, never read from the note, so nothing can go stale', () => {
  // Same path and same graph, twice, with nothing stored in between.
  const h = hood(['Fate/a.md', 'Fate/b.md', 'Fate/c.md'])
  assert.deepEqual(keys('Inbox/x.md', h), keys('Inbox/x.md', h))
})
