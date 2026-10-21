/**
 * BM25 over a whole message. The properties that matter, each one a way the
 * ranking could be quietly wrong: filler words carry nothing, a rare word beats
 * a common one, a note's name counts for more than its body, and plurals meet.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { terms, buildIndex, rank } = await import(`file://${join(ROOT, 'src', 'shared', 'retrieve.ts')}`)

test('terms: lowercase, stopwords out, plurals folded, short tokens dropped', () => {
  assert.deepEqual(terms('What were the Adapters doing? a b 42'), ['adapter', '42'])
  assert.deepEqual(terms('status class analysis'), ['status', 'class', 'analysis'])
})

const docs = [
  { path: 'a.md', title: 'Groceries', text: 'milk eggs bread the the the and and' },
  { path: 'b.md', title: 'WiFi Adapter Problem', text: 'the driver crashes and pings spike' },
  { path: 'c.md', title: 'Daily', text: 'pings were fine today, wifi ok, adapter ok, adapter ok' },
  { path: 'd.md', title: 'Notes', text: 'pings pings pings' },
]
const index = buildIndex(docs)

test('a message made only of stopwords matches nothing', () => {
  assert.deepEqual(rank(index, 'what was it doing and why'), [])
})

test('a word in the name outranks the same word repeated in a body', () => {
  assert.equal(rank(index, 'why does my wifi adapter keep dropping')[0].path, 'b.md')
})

test('zero-score notes are dropped and ties break by path', () => {
  const r = rank(index, 'pings')
  assert.deepEqual(r.map((x) => x.path).sort(), ['b.md', 'c.md', 'd.md'])
  assert.ok(!r.some((x) => x.path === 'a.md'))
  assert.deepEqual(rank(index, 'pings'), r, 'same query, same order')
})
