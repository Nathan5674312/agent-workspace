/**
 * Search: the matching rules, and the offsets the highlight is drawn from.
 *
 * The offsets are the part worth testing hardest. A result row slices the line
 * three ways on `at` and `length`, so an offset that is one out does not throw
 * — it highlights the wrong word, on every row, silently. Trimming and snipping
 * both move text, and both have to move the offset with it.
 *
 * Runs against the real vault at the bottom, like wikilink-write and templates
 * do, because the rules here were written for a vault of this shape.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  countHits,
  isSearchable,
  normalizeQuery,
  rankNotes,
  searchText,
  titleMatches,
  SNIPPET_MAX,
} from '../src/shared/search.ts'

// ------------------------------------------------------------------ the query

test('a query under two characters is not worth reading the vault for', () => {
  assert.equal(isSearchable(''), false)
  assert.equal(isSearchable(' '), false)
  assert.equal(isSearchable('a'), false)
  assert.equal(isSearchable('  a  '), false, 'whitespace is not length')
  assert.equal(isSearchable('ab'), true)
})

test('the query is trimmed, because a trailing space is a typo not a term', () => {
  assert.equal(normalizeQuery('  roadmap \n'), 'roadmap')
})

// ------------------------------------------------------------------ matching

test('matching is case-insensitive and finds every line, once each', () => {
  const text = ['alpha', 'Beta beta BETA', 'gamma', 'beta'].join('\n')
  const { hits } = searchText(text, 'beta')
  assert.deepEqual(hits.map((h) => h.line), [1, 3])
  assert.equal(hits[0].text, 'Beta beta BETA', 'one hit per LINE, not per occurrence')
})

test('the query is never compiled as a pattern', () => {
  // A person types `.` and `*` and `(`. A regex build would match everything,
  // or throw on the unbalanced paren, and both are worse than finding nothing.
  const text = 'a.b\nxxx\nc(d'
  assert.deepEqual(searchText(text, 'a.b').hits.map((h) => h.line), [0])
  assert.deepEqual(searchText(text, '.*').hits.map((h) => h.line), [])
  assert.doesNotThrow(() => searchText(text, '('))
  assert.deepEqual(searchText(text, 'c(d').hits.map((h) => h.line), [2])
})

test('an empty query matches nothing rather than everything', () => {
  assert.deepEqual(searchText('anything at all', '').hits, [])
  assert.equal(titleMatches('Anything', ''), false)
})

test('a title match is found independently of the body', () => {
  assert.equal(titleMatches('Roadmap', 'road'), true)
  assert.equal(titleMatches('Roadmap', 'ROAD'), true)
  assert.equal(titleMatches('Roadmap', 'zzz'), false)
})

// ------------------------------------------------------------------- offsets

test('the offset survives left-trimming, or the highlight lands on the wrong word', () => {
  const text = '        indented needle here'
  const [hit] = searchText(text, 'needle').hits
  assert.equal(hit.text, 'indented needle here', 'the row shows the trimmed line')
  assert.equal(
    hit.text.slice(hit.at, hit.at + hit.length),
    'needle',
    'slicing on the reported offset must reproduce the query',
  )
})

test('the offset survives snipping a long line', () => {
  // The match sits far past SNIPPET_MAX, so the window has to move to it.
  const line = 'x'.repeat(4000) + 'needle' + 'y'.repeat(4000)
  const [hit] = searchText(line, 'needle').hits
  assert.ok(hit.text.length <= SNIPPET_MAX + 2, `snippet was ${hit.text.length}`)
  assert.equal(hit.text.slice(hit.at, hit.at + hit.length), 'needle')
  assert.ok(hit.text.startsWith('…'), 'a cut head says it was cut')
  assert.ok(hit.text.endsWith('…'), 'a cut tail says it was cut')
})

test('a match at the very end of a long line is still inside the window', () => {
  const line = 'z'.repeat(4000) + 'needle'
  const [hit] = searchText(line, 'needle').hits
  assert.equal(hit.text.slice(hit.at, hit.at + hit.length), 'needle')
  assert.ok(!hit.text.endsWith('…'), 'nothing follows the match, so nothing is elided after it')
})

test('a short line is returned whole, with no ellipsis', () => {
  const [hit] = searchText('a needle here', 'needle').hits
  assert.equal(hit.text, 'a needle here')
  assert.equal(hit.text.slice(hit.at, hit.at + hit.length), 'needle')
})

test('CRLF does not leave a carriage return in the result row', () => {
  const [hit] = searchText('alpha\r\nneedle here\r\nomega', 'needle').hits
  assert.equal(hit.text, 'needle here')
  assert.ok(!hit.text.includes('\r'))
})

test('the offset survives a lowercase that CHANGES LENGTH', () => {
  // 'İ'.toLowerCase() is two UTF-16 code units, so a fast lowercased indexOf
  // reports an index into a longer string. Measured before the fix: offset 7 in
  // a 7-character line, which rendered an EMPTY highlight — the match was not
  // marked at all. The renderer slices on this number, so it has to index the
  // string it is slicing.
  const line = 'İİİ abc'
  const [hit] = searchText(line, 'abc').hits
  assert.equal(hit.text.slice(hit.at, hit.at + hit.length), 'abc')
  // And the query itself can contain one.
  const [h2] = searchText('x İstanbul y', 'İst').hits
  assert.equal(h2.text.slice(h2.at, h2.at + h2.length).toLowerCase(), 'i̇st'.toLowerCase())
})

test('a late match on a SHORT line is still windowed into view', () => {
  // The row is one clipped line in a narrow sidebar. Windowing only lines over
  // SNIPPET_MAX left the common case broken: an ordinary prose line whose match
  // sits 60 characters in showed 25 characters of unrelated text and no mark.
  const line = 'a'.repeat(60) + 'needle tail'
  const [hit] = searchText(line, 'needle').hits
  assert.ok(hit.at <= 12, `match sits ${hit.at} chars in, too far to be visible`)
  assert.equal(hit.text.slice(hit.at, hit.at + hit.length), 'needle')
  assert.ok(hit.text.startsWith('…'), 'a windowed head says it was cut')
})

// ------------------------------------------------------------------- capping

test('hits past the per-note cap are COUNTED, not dropped silently', () => {
  const text = Array.from({ length: 40 }, () => 'needle').join('\n')
  const { hits, truncated } = searchText(text, 'needle', 5)
  assert.equal(hits.length, 5)
  assert.equal(truncated, 35, '"5 of 40" and "5" are different facts')
})

// ------------------------------------------------------------------- ranking

test('title matches come first, then hit count, then path for stability', () => {
  const notes = [
    { path: 'b.md', title: 'B', titleMatch: false, hits: [{}, {}], truncated: 0 },
    { path: 'a.md', title: 'A', titleMatch: false, hits: [{}, {}], truncated: 0 },
    { path: 'z.md', title: 'Z', titleMatch: false, hits: [{}, {}, {}], truncated: 0 },
    { path: 'n.md', title: 'N', titleMatch: true, hits: [], truncated: 0 },
  ]
  const order = rankNotes(notes).map((n) => n.path)
  assert.deepEqual(order, ['n.md', 'z.md', 'a.md', 'b.md'])
  // Ranking must not mutate: the caller may still hold the original order.
  assert.equal(notes[0].path, 'b.md')
})

test('truncated hits count toward the ranking, or a capped note sinks unfairly', () => {
  const few = { path: 'few.md', title: 'F', titleMatch: false, hits: [{}, {}, {}, {}], truncated: 0 }
  const many = { path: 'many.md', title: 'M', titleMatch: false, hits: [{}, {}, {}], truncated: 90 }
  assert.deepEqual(rankNotes([few, many]).map((n) => n.path), ['many.md', 'few.md'])
})

test('countHits totals the shown, the truncated, and the name-only match', () => {
  // The name-only row used to count ZERO, so a query matching a filename and
  // nothing in its body printed "0 results in 1 note" directly above a
  // clickable result. It is a result; it counts as one.
  assert.equal(
    countHits([
      { path: 'a', title: 'a', titleMatch: false, hits: [{}, {}], truncated: 3 },
      { path: 'b', title: 'b', titleMatch: true, hits: [], truncated: 0 },
    ]),
    6,
  )
  // A name match that ALSO has body hits is not double-counted.
  assert.equal(
    countHits([{ path: 'c', title: 'c', titleMatch: true, hits: [{}, {}], truncated: 0 }]),
    2,
  )
})

// ------------------------------------------------------------- the real vault

const VAULT = 'C:/Users/Nathan/Desktop/Universal Vault'

test('every hit in the real vault reproduces its own query when sliced', {
  skip: !existsSync(VAULT) && 'vault not on this machine',
}, () => {
  // The invariant that matters, checked against real prose rather than fixtures:
  // whatever the trimming and snipping did, slicing the row on the reported
  // offset must give back the query. Anything else highlights the wrong text.
  const QUERIES = ['the', 'vault', 'roadmap', 'agent', '](', '  ']
  let checked = 0
  let files = 0
  const walk = (dir, depth = 0) => {
    if (depth > 3 || files > 250) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (files > 250) return
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.name.endsWith('.md')) {
        files++
        let text
        try {
          text = readFileSync(full, 'utf-8')
        } catch {
          continue
        }
        for (const q of QUERIES) {
          if (!isSearchable(q)) continue
          for (const hit of searchText(text, q).hits) {
            assert.equal(
              hit.text.slice(hit.at, hit.at + hit.length).toLowerCase(),
              q.toLowerCase(),
              `${full} line ${hit.line}: offset does not reproduce ${JSON.stringify(q)}`,
            )
            assert.ok(hit.text.length <= SNIPPET_MAX + 2, `${full}: snippet too long`)
            assert.ok(!hit.text.includes('\n'), `${full}: a row spans lines`)
            checked++
          }
        }
      }
    }
  }
  walk(VAULT)
  assert.ok(checked > 200, `only ${checked} hits checked across ${files} files`)
  console.log(`      ${checked} real hits across ${files} notes, every offset exact`)
})
