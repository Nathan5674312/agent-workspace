/**
 * BM25 over a whole message. The properties that matter, each one a way the
 * ranking could be quietly wrong: filler words carry nothing, a rare word beats
 * a common one, a note's name counts for more than its body, and plurals meet.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { terms, buildIndex, rank, pointerBlock } = await import(`file://${join(ROOT, 'src', 'shared', 'retrieve.ts')}`)
const vault = await import('../src/main/vault.ts')

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

// ------------------------------------------------------------------ the head start

test('the block is paths and how they were picked, never note text', () => {
  assert.equal(pointerBlock([], 'C:/v'), undefined, 'no matches, no block')
  const b = pointerBlock(['Fate/WiFi.md', 'Home.md'], 'C:/v')
  assert.match(b, /relative to C:\/v/)
  assert.match(b, /word overlap, not meaning/)
  assert.ok(b.endsWith('- Fate/WiFi.md\n- Home.md'))
})

test('related() ranks a whole message over the real walk, and skips what the explorer hides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'related-'))
  mkdirSync(join(dir, 'Fate'))
  mkdirSync(join(dir, '.trash'))
  writeFileSync(join(dir, 'Fate', 'WiFi Adapter.md'), 'the mediatek driver crashes and pings spike')
  writeFileSync(join(dir, 'Groceries.md'), 'milk eggs bread')
  writeFileSync(join(dir, '.trash', 'Old WiFi.md'), 'wifi adapter pings driver wifi adapter')
  vault._setVaultDirForTest(dir)
  const got = await vault.related('my wifi dongle keeps dropping and pings spike, did we ever figure out why')
  assert.equal(got[0], 'Fate/WiFi Adapter.md')
  assert.ok(!got.some((p) => p.startsWith('.trash')), 'a trashed note must not come back as a pointer')
  assert.ok(!got.includes('Groceries.md'), 'a note sharing no word is not a pointer')
  assert.deepEqual(await vault.related('what was it and why'), [], 'all stopwords: no lookup at all')
  assert.deepEqual(await vault.related('thanks!'), [], 'one word is an acknowledgement, not a question')
  assert.deepEqual(await vault.related('thanks!'), [], 'one word is an acknowledgement, not a question')
})

const supervisorSrc = readFileSync(join(ROOT, 'src', 'main', 'supervisor.ts'), 'utf8')
const agentHostSrc = readFileSync(join(ROOT, 'src', 'main', 'agentHost.ts'), 'utf8')

test('the parent looks up pointers every turn, and a failed lookup never fails the turn', () => {
  assert.match(supervisorSrc, /related\(text\)\s*\.then\(\(paths\) => pointerBlock\(paths, getVaultDir\(\)\)\)\s*\.catch\(\(\) => undefined\)/)
  assert.match(supervisorSrc, /const relatedBlock = await pointers\s*\n\s*\/\/[^\n]*\n\s*if \(child\.settled\) return/)
  assert.match(supervisorSrc, /related: relatedBlock,/)
})

test('the child puts the pointers in front of the request, not in the system prompt', () => {
  assert.match(agentHostSrc, /const prompt = msg\.related \? `\$\{msg\.related\}/)
  assert.ok(!/systemPrompt:\s*msg\.related/.test(agentHostSrc))
  assert.ok(!/from '\.\/vault\.js'/.test(agentHostSrc), 'the child still never touches the vault')
})
