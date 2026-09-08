/**
 * SEARCHING BY WORD, which is what "fate food" is supposed to mean.
 *
 * Before this, the query was one string handed to an index-of, so `fate food`
 * looked for those nine characters in that order. A note whose first line says
 * "Fate" and whose fortieth says "food" — the note you are actually looking
 * for — did not match at all, and neither did "food for Fate". The panel came
 * back empty and the honest reading of that is that search is broken.
 *
 * The rule now, which is the one every other search box uses:
 *
 *   a NOTE matches when every term appears in it, anywhere;
 *   a LINE is shown when it contains any of them;
 *   "quoted words" are one term and must be found as written.
 *
 * The AND is per NOTE and not per line, and that distinction is the whole
 * feature: the words a person remembers are rarely on the same line.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { parseQuery, searchText, titleMatches, isSearchable, searchTerms } = await import(
  '../src/shared/search.ts'
)

const NOTE = ['Fate is the project.', '', 'Nothing here about lunch.', 'Then: fast food.'].join('\n')

test('a query splits into the words it is made of', () => {
  assert.deepEqual(parseQuery('fate food'), [
    { text: 'fate', phrase: false },
    { text: 'food', phrase: false },
  ])
})

test('runs of whitespace are not empty terms', () => {
  assert.deepEqual(parseQuery('  fate   food  ').map((t) => t.text), ['fate', 'food'])
})

test('quotes make one term out of several words', () => {
  assert.deepEqual(parseQuery('"fast food" fate'), [
    { text: 'fast food', phrase: true },
    { text: 'fate', phrase: false },
  ])
})

test('an unclosed quote searches what has been typed so far', () => {
  // Mid-type is the normal state of a search box. Refusing to run is worse.
  assert.deepEqual(parseQuery('"fast foo').map((t) => t.text), ['fast foo'])
})

test('two words on different lines still match the note', () => {
  const { all } = searchText(NOTE, 'fate food')
  assert.equal(all, true, 'the words were on lines 0 and 3, which is the ordinary case')
})

test('every line carrying any of the words is a result', () => {
  const { hits } = searchText(NOTE, 'fate food')
  assert.deepEqual(hits.map((h) => h.line), [0, 3])
})

test('a note holding only one of the words does not match', () => {
  const { all } = searchText('Fate, and nothing else.', 'fate food')
  assert.equal(all, false)
})

test('a quoted phrase is found as written, or not at all', () => {
  assert.equal(searchText(NOTE, '"fast food"').all, true)
  assert.equal(searchText(NOTE, '"food fast"').all, false)
})

test('one word behaves exactly as it always did', () => {
  const { hits, all } = searchText(NOTE, 'fate')
  assert.equal(all, true)
  assert.deepEqual(hits.map((h) => h.line), [0])
})

test('the highlight lands on the leftmost word of the line', () => {
  const line = 'fast food, and fate.'
  const [hit] = searchText(line, 'fate food').hits
  assert.equal(hit.text.slice(hit.at, hit.at + hit.length), 'food')
})

test('a name made of the same words matches in any order', () => {
  assert.equal(titleMatches('FAST Food', 'fast food'), true)
  assert.equal(titleMatches('Food, fast', 'fast food'), true)
  assert.equal(titleMatches('Fast cars', 'fast food'), false)
})

test('an empty query still matches nothing at all', () => {
  assert.deepEqual(parseQuery(''), [])
  assert.equal(searchText(NOTE, '').all, false)
  assert.equal(searchText(NOTE, '').hits.length, 0)
  assert.equal(titleMatches('anything', ''), false)
  assert.equal(isSearchable(''), false)
})

/**
 * ── AND THE COST OF SPLITTING A QUERY INTO WORDS ──
 *
 * Splitting turned `a b` from a rare three-character substring into "every note
 * containing an a AND a b", which is the vault. MEASURED on the real one before
 * this rule: `a b` returned 215 notes and `to the` 208, out of 479 — a
 * whole-vault read rendered as a result list, from two keystrokes.
 *
 * A bare term has to be two characters to count. A QUOTED one does not: `"a b"`
 * is somebody asking for that exact string, which is the narrow query the old
 * two-character floor assumed every query was.
 */
test('a one-letter word is not a search term', () => {
  assert.deepEqual(searchTerms('a b').map((t) => t.text), [])
  assert.equal(isSearchable('a b'), false)
  assert.deepEqual(searchTerms('fate a').map((t) => t.text), ['fate'])
})

test('quoting is how you ask for the short thing anyway', () => {
  assert.deepEqual(searchTerms('"a b"').map((t) => t.text), ['a b'])
  assert.equal(isSearchable('"a b"'), true)
})

test('the floor and the scan cannot disagree', () => {
  // A query the floor accepts must produce hits the scan can find, or the panel
  // runs a search that was never going to match anything.
  const q = 'fate a'
  assert.equal(isSearchable(q), true)
  assert.equal(searchText('Fate is the project.', q).all, true)
})
