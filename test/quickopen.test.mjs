/**
 * QUICK OPEN: the palette that finds a note by name while you type.
 *
 * The rule it lives or dies by is that an initialism works. Nobody types
 * "roadmapStates" to reach `roadmapStates.ts`; they type `rmst` and expect it
 * first. A subsequence match alone gives that — and gives it to half the vault
 * as well, so the scoring is the real subject here: a letter that starts a
 * word has to outweigh any number of letters found mid-word, or the right
 * answer sits below thirty wrong ones and the palette is useless.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { quickOpen, titleOf } = await import('../src/shared/quickopen.ts')

const VAULT = [
  'Fate/Roadmap/02 - Search and Retrieval.md',
  'Fate/Roadmap/12 - Website and Domain.md',
  'Fate/Skills Index.md',
  'System/Skills/reddit-voice/SKILL.md',
  'System/CLAUDE Configs/agent-workspace CLAUDE.md',
  'Daily/2026-09-07.md',
  'Home.md',
  'AGENTS.md',
]

const titles = (hits) => hits.map((h) => h.title)

test('a note name typed in full is the first answer', () => {
  assert.equal(quickOpen(VAULT, 'Home')[0].title, 'Home')
  assert.equal(quickOpen(VAULT, 'agents')[0].title, 'AGENTS')
})

test('an initialism finds the note nobody would type out', () => {
  // w, a, d are the initials of "Website and Domain" and appear nowhere else
  // in that order. Nobody types the title; everybody types this.
  assert.match(quickOpen(VAULT, 'wad')[0].title, /Website and Domain/)
})

/**
 * MEASURED ON THE REAL VAULT, and the reason `scoreOne` runs twice.
 *
 * `wad` used to rank `USB WiFi Adapter Problem` above the note whose initials
 * they are, because the earliest `d` after "Website and" is the one ending
 * "and" — an interior hit — so the third letter of a perfect initialism scored
 * one point. Looking ahead for a `d` that starts a word finds "Domain".
 */
test('an initialism is not beaten by a coincidence earlier in the string', () => {
  const paths = ['Fate/USB WiFi Adapter Problem.md', 'Fate/Roadmap/12 - Website and Domain.md']
  const [first] = quickOpen(paths, 'wad')
  assert.match(first.title, /Website and Domain/)
  const marked = first.ranges.map(([at, len]) => first.label.slice(at, at + len)).join('')
  assert.equal(marked, 'WaD', 'the marks must be the three initials, not two of them and a stray')
})

test('letters starting words beat the same letters buried mid-word', () => {
  const hits = quickOpen(VAULT, 'sr')
  // "Search and Retrieval": both letters start words. Everything else that
  // contains an s then an r has them inside words.
  assert.match(hits[0].title, /Search and Retrieval/)
})

test('a slash makes the query about the folder, and the row says so', () => {
  const [first] = quickOpen(VAULT, 'roadmap/12')
  assert.equal(first.path, 'Fate/Roadmap/12 - Website and Domain.md')
  assert.equal(first.label, first.path, 'a path query must highlight the path, not the name')
})

test('a query whose letters are not all there matches nothing', () => {
  assert.deepEqual(quickOpen(VAULT, 'zzz'), [])
})

test('the ranges cover the letters that matched, in order', () => {
  const [hit] = quickOpen(VAULT, 'home')
  const marked = hit.ranges.map(([at, len]) => hit.label.slice(at, at + len)).join('')
  assert.equal(marked.toLowerCase(), 'home')
})

test('adjacent letters are one range, so the row draws one mark not four', () => {
  const [hit] = quickOpen(VAULT, 'home')
  assert.equal(hit.ranges.length, 1)
})

test('an empty query offers the vault as given, capped', () => {
  const hits = quickOpen(VAULT, '', 3)
  assert.equal(hits.length, 3)
  assert.deepEqual(titles(hits), VAULT.slice(0, 3).map(titleOf))
})

test('the limit is honoured, and the best survive it', () => {
  const hits = quickOpen(VAULT, 's', 2)
  assert.equal(hits.length, 2)
})

test('a shorter name wins a tie, being the more specific answer', () => {
  const paths = ['Skills.md', 'Skills and Other Things We Also Do Here.md']
  assert.equal(quickOpen(paths, 'skills')[0].title, 'Skills')
})

test('titleOf drops the folder and the extension, and only the extension', () => {
  assert.equal(titleOf('Fate/Roadmap/12 - Website and Domain.md'), '12 - Website and Domain')
  assert.equal(titleOf('Home.md'), 'Home')
  assert.equal(titleOf('.gitignore'), '.gitignore', 'a dotfile has no extension to drop')
})

/**
 * A note named in Turkish is all it takes: `'İ'.toLowerCase()` is TWO UTF-16
 * units, so a lowercase copy of the title is longer than the title and every
 * index found in it points one character further along the original. The marks
 * then sit on the wrong letters, or past the end. `search.ts` guards the same
 * case under `indexOfCI`; this one had to learn it too.
 */
test('a title whose lowercase is longer still marks the right letters', () => {
  const paths = ['Notes/İstanbul plan.md']
  const [hit] = quickOpen(paths, 'plan')
  assert.ok(hit, 'a title with İ in it stopped matching entirely')
  const marked = hit.ranges.map(([at, len]) => hit.label.slice(at, at + len)).join('')
  assert.equal(marked.toLowerCase(), 'plan')
})
