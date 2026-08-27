/**
 * Block-level references — the parser, the resolver, and the writer.
 *
 * Three properties are what this feature is, and each can be wrong while
 * looking right:
 *
 *   1. The link parser must KEEP the address it used to discard, without
 *      changing a single answer the graph builder gets from it. A regex change
 *      under `parseWikilinks` is a change to every edge in the vault.
 *   2. A reference must land on the RIGHT line, and say so when it cannot. A
 *      resolver that quietly falls back to line 0 looks like it works.
 *   3. Writing an id must never produce one Obsidian cannot follow, and must
 *      never produce the same id twice in one file.
 *
 * Pure modules against strings — no Electron, no DOM, no filesystem.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  parseWikilinkRefs,
  parseWikilinks,
} from '../src/shared/wikilink.ts'
import {
  anchorLine,
  blockIdRefusal,
  blockIds,
  ensureBlockId,
  lineOfOffset,
  lineRange,
} from '../src/shared/blockref.ts'

// ------------------------------------------------------------- the parser

test('the suffix is captured, not discarded', () => {
  assert.deepEqual(parseWikilinkRefs('[[Note]]'), [
    { target: 'Note', fragment: null, alias: null },
  ])
  assert.deepEqual(parseWikilinkRefs('[[Note#Heading]]'), [
    { target: 'Note', fragment: 'Heading', alias: null },
  ])
  assert.deepEqual(parseWikilinkRefs('[[Note#^a1b2c3]]'), [
    { target: 'Note', fragment: '^a1b2c3', alias: null },
  ])
  assert.deepEqual(parseWikilinkRefs('[[Note#^a1b2c3|as I put it]]'), [
    { target: 'Note', fragment: '^a1b2c3', alias: 'as I put it' },
  ])
  assert.deepEqual(parseWikilinkRefs('[[Note|alias]]'), [
    { target: 'Note', fragment: null, alias: 'alias' },
  ])
  // Obsidian's same-note form. Empty target, and that is the meaning.
  assert.deepEqual(parseWikilinkRefs('[[#^a1b2c3]]'), [
    { target: '', fragment: '^a1b2c3', alias: null },
  ])
})

test('an embed is the same address with a ! outside it', () => {
  // `![[Note#^id]]` — the bang sits outside the match, so it always has. This
  // pins that it still does after the regex change, because an embed that
  // stopped parsing would silently drop a link from the list.
  assert.deepEqual(parseWikilinkRefs('![[Note#^a1b2c3]]'), [
    { target: 'Note', fragment: '^a1b2c3', alias: null },
  ])
})

test('two blocks of one note are two links', () => {
  // The whole point. Deduping on the note would collapse these to one row and
  // reintroduce, in the view, exactly the loss the parser just stopped making.
  const refs = parseWikilinkRefs('[[Note#^aaa]] and [[Note#^bbb]] and [[Note#^aaa]]')
  assert.equal(refs.length, 2)
  assert.deepEqual(
    refs.map((r) => r.fragment),
    ['^aaa', '^bbb'],
  )
})

test('parseWikilinks is unchanged — the graph must not move', () => {
  // Copied from review-s2-vault-pane.test.mjs deliberately. Those assertions
  // guard the graph; these guard that the block-reference work did not disturb
  // them, in the file whose change would have caused it.
  assert.deepEqual(parseWikilinks('see [[Home]] and [[Projects/AI]]'), [
    'Home',
    'Projects/AI',
  ])
  assert.deepEqual(parseWikilinks('[[Home|the home note]]'), ['Home'])
  assert.deepEqual(parseWikilinks('[[Home#Section]]'), ['Home'])
  assert.deepEqual(parseWikilinks('[[Home#^a1b2c3]]'), ['Home'])
  assert.deepEqual(parseWikilinks('[[Home]] [[Home]] [[home]]'), ['Home', 'home'])
  assert.deepEqual(parseWikilinks('no links here'), [])
  assert.deepEqual(parseWikilinks('[[]] [[   ]]'), [])
  assert.deepEqual(parseWikilinks('[single] [[Real]]'), ['Real'])
  // A fragment-only link names no note, so it is not an edge.
  assert.deepEqual(parseWikilinks('[[#Heading]] [[#^abc]]'), [])
})

test('an unclosed [[ still cannot swallow the file', () => {
  // The newline ban in every character class is load-bearing and survived the
  // rewrite: without it this matches across three paragraphs and invents a link.
  assert.deepEqual(parseWikilinks('[[open\n\nlater [[Real]] here'), ['Real'])
})

// ------------------------------------------------------------- reading ids

const NOTE = [
  '---',
  'title: Sample',
  '---',
  '',
  '# Top heading',
  '',
  'A paragraph that has been cited. ^a1b2c3',
  '',
  '## Nested ##',
  '',
  '| a | b |',
  '| - | - |',
  '',
  '^table-id',
  '',
  'A hand-written one. ^decision-3',
  '',
].join('\n')

test('both of Obsidian\'s id forms are read', () => {
  const ids = blockIds(NOTE)
  assert.equal(ids.get('a1b2c3'), 6, 'appended to a paragraph')
  assert.equal(ids.get('table-id'), 13, 'alone on its own line, after a table')
  assert.equal(ids.get('decision-3'), 15, 'hand-written ids are read too')
  assert.equal(ids.size, 3)
})

test('a caret that nobody wrote as an id is not one', () => {
  // `x^2` is arithmetic, and the whitespace-or-start rule is the only thing
  // between it and a phantom block id.
  assert.equal(blockIds('the value is x^2\n').size, 0)
  assert.equal(blockIds('a ^has spaces\n').size, 0)
  assert.equal(blockIds('a ^under_score\n').size, 0, 'underscore is not legal')
})

test('a duplicate id resolves to the first, as Obsidian does', () => {
  // Not endorsed — `ensureBlockId` refuses to create one. But these files are
  // also written by Obsidian and a human, so reading one has to agree with the
  // other reader rather than throwing.
  const ids = blockIds('one ^dup\ntwo ^dup\n')
  assert.equal(ids.get('dup'), 0)
})

// ----------------------------------------------------------- resolving one

test('a block reference lands on its line', () => {
  assert.equal(anchorLine(NOTE, '^a1b2c3'), 6)
  assert.equal(anchorLine(NOTE, '^table-id'), 13)
})

test('a heading reference lands on its heading', () => {
  assert.equal(anchorLine(NOTE, 'Top heading'), 4)
  assert.equal(anchorLine(NOTE, 'top HEADING'), 4, 'matched as a human reads it')
  assert.equal(anchorLine(NOTE, 'Nested'), 8, 'closing hashes are not part of it')
  assert.equal(anchorLine(NOTE, 'Top heading#Nested'), 8, 'the deepest segment wins')
})

test('an address that matches nothing says so instead of guessing', () => {
  // The failure that matters. Falling back to 0 would scroll the user to the
  // top of the note and look exactly like a reference that worked.
  assert.equal(anchorLine(NOTE, '^nope'), null)
  assert.equal(anchorLine(NOTE, 'No Such Heading'), null)
  assert.equal(anchorLine(NOTE, ''), null)
  // A heading and a block id are different namespaces: `^a1b2c3` is not a
  // heading, and `Top heading` is not an id.
  assert.equal(anchorLine(NOTE, '^Top heading'), null)
})

test('the line offsets a textarea selection needs', () => {
  assert.deepEqual(lineRange('aa\nbbb\nc', 0), { start: 0, end: 2 })
  assert.deepEqual(lineRange('aa\nbbb\nc', 1), { start: 3, end: 6 })
  assert.deepEqual(lineRange('aa\nbbb\nc', 2), { start: 7, end: 8 })
  assert.deepEqual(lineRange('aa\nbbb\nc', 9), { start: 0, end: 0 }, 'out of range')

  assert.equal(lineOfOffset('aa\nbbb\nc', 0), 0)
  assert.equal(lineOfOffset('aa\nbbb\nc', 2), 0, 'the end of a line is still on it')
  assert.equal(lineOfOffset('aa\nbbb\nc', 3), 1)
  assert.equal(lineOfOffset('aa\nbbb\nc', 8), 2)
})

// -------------------------------------------------------------- writing one

test('an id is appended after exactly one space', () => {
  const out = ensureBlockId('# H\n\nA paragraph.\n', 2)
  assert.equal(out.ok, true)
  assert.match(out.text, /^# H\n\nA paragraph\. \^[a-z0-9]{6}\n$/)
  assert.equal(out.id.length, 6)
  assert.match(out.id, /^[a-z0-9]{6}$/)
})

test('trailing whitespace does not become two spaces', () => {
  const out = ensureBlockId('A paragraph.   \n', 0)
  assert.equal(out.ok, true)
  assert.match(out.text, /^A paragraph\. \^[a-z0-9]{6}\n$/)
})

test('asking twice is the same answer and the same text', () => {
  // Idempotence is what stops the button marking a clean note dirty for nothing
  // and what stops two ids landing on one line.
  const first = ensureBlockId('A paragraph.\n', 0)
  assert.equal(first.ok, true)
  const second = ensureBlockId(first.text, 0)
  assert.equal(second.ok, true)
  assert.equal(second.id, first.id)
  assert.equal(second.text, first.text)
})

test('a new id never collides with one already in the file', () => {
  // The one rule Obsidian does not enforce. Run enough times that a generator
  // ignoring the file would have to be lucky every single time.
  for (let i = 0; i < 200; i++) {
    const out = ensureBlockId('one ^aaaaaa\ntwo ^bbbbbb\nthree\n', 2)
    assert.equal(out.ok, true)
    assert.ok(out.id !== 'aaaaaa' && out.id !== 'bbbbbb', out.id)
  }
})

test('lines Obsidian cannot link into are refused, not written', () => {
  // Emitting a reference the other reader of these files cannot follow is worse
  // than declining, because the user finds out in Obsidian, later, alone.
  assert.match(blockIdRefusal('| a | b |'), /table/)
  assert.match(blockIdRefusal('> a quote'), /quote/)
  assert.match(blockIdRefusal('> [!note] a callout'), /callout/)
  assert.match(blockIdRefusal('```ts'), /code fence/)
  assert.match(blockIdRefusal('## A heading'), /\[\[Note#Heading\]\]/)
  assert.match(blockIdRefusal('   '), /empty/)
  assert.equal(blockIdRefusal('An ordinary paragraph.'), null)
  assert.equal(blockIdRefusal('- a list item'), null)
})

test('a refusal changes nothing', () => {
  const text = '| a | b |\n'
  const out = ensureBlockId(text, 0)
  assert.equal(out.ok, false)
  assert.match(out.refusal, /table/)
  // No `text` on a refusal at all, so no caller can write one back by accident.
  assert.equal('text' in out, false)
})

test('a line that does not exist is refused rather than appended', () => {
  const out = ensureBlockId('one line\n', 40)
  assert.equal(out.ok, false)
  assert.match(out.refusal, /no line/i)
})

test('an id written here is read back by the parser it was written for', () => {
  // End to end on the two halves that must agree: write an id, address it with
  // a wikilink, resolve the wikilink back to the line it was written on.
  const written = ensureBlockId('# H\n\nCite me.\n\nNot me.\n', 2)
  assert.equal(written.ok, true)
  const [link] = parseWikilinkRefs(`See [[Sample#^${written.id}]].`)
  assert.equal(link.target, 'Sample')
  assert.equal(anchorLine(written.text, link.fragment), 2)
})
