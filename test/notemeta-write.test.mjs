/**
 * setFrontmatter — the only function in this app that edits a note nobody has
 * open in the editor.
 *
 * Tested harder than its size suggests because the database view now writes
 * through it, which means it runs against notes the user is not looking at. A
 * writer that mangles a note you cannot see is worse than one that refuses: the
 * damage is silent, and `.backups/` is the only thing between it and a real
 * vault. Every case here is a shape that exists in Nathan's own vault.
 *
 * The load-bearing property is ROUND TRIP: whatever this writes,
 * `parseFrontmatter` must read back as the same value, or the table shows one
 * thing and the file says another — the exact split the write-back exists to
 * close.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { setFrontmatter, parseFrontmatter, stripFrontmatter } from '../src/shared/notemeta.ts'

const NOTE = ['---', 'title: Alpha', 'type: reference', 'status: draft', '---', '', 'Body text.', ''].join('\n')

test('an existing key is replaced in place', () => {
  const out = setFrontmatter(NOTE, 'status', 'active')
  assert.equal(parseFrontmatter(out).status, 'active')
  // Everything else survives, including order.
  assert.match(out, /---\ntitle: Alpha\ntype: reference\nstatus: active\n---/)
  assert.equal(stripFrontmatter(out), 'Body text.')
})

test('a new key is appended to the end of the block, not the top', () => {
  const out = setFrontmatter(NOTE, 'updated', '2026-08-27')
  assert.equal(parseFrontmatter(out).updated, '2026-08-27')
  // `title` still opens the block — that is the order a human reads it in.
  assert.match(out, /^---\ntitle: Alpha\n/)
  assert.match(out, /status: draft\nupdated: 2026-08-27\n---/)
})

test('an empty value deletes the key rather than writing a blank one', () => {
  const out = setFrontmatter(NOTE, 'status', '')
  assert.equal(parseFrontmatter(out).status, undefined)
  assert.doesNotMatch(out, /status:/)
  // The neighbours are untouched.
  assert.equal(parseFrontmatter(out).type, 'reference')
  assert.equal(stripFrontmatter(out), 'Body text.')
})

test('clearing a key that was never there changes nothing at all', () => {
  assert.equal(setFrontmatter(NOTE, 'nosuch', ''), NOTE)
})

test('a note with no frontmatter gets a block, and only when there is a value', () => {
  const bare = '# Heading\n\nSome text.\n'
  assert.equal(setFrontmatter(bare, 'status', ''), bare, 'grew a block to say nothing')

  const out = setFrontmatter(bare, 'status', 'active')
  assert.equal(parseFrontmatter(out).status, 'active')
  assert.equal(stripFrontmatter(out), '# Heading\n\nSome text.')
})

test('an unterminated --- is left alone', () => {
  // A horizontal rule at the top of a note, or a block half typed. Writing into
  // it would invent a closing fence the file does not have.
  const rule = '---\nnot really frontmatter\n\n# Heading\n'
  assert.equal(setFrontmatter(rule, 'status', 'active'), rule)
})

test('list items, comments and indented lines are never mistaken for the key', () => {
  const listy = [
    '---',
    'title: Alpha',
    'tags:',
    '  - status',       // indented, and named exactly like the key
    '# status: nope',   // a comment
    '-  status: nope',  // a list item
    'status: draft',    // the real one, last
    '---',
    '',
    'Body.',
    '',
  ].join('\n')
  const out = setFrontmatter(listy, 'status', 'active')
  assert.equal(parseFrontmatter(out).status, 'active')
  assert.match(out, /  - status\n/, 'the tags list item was rewritten')
  assert.match(out, /# status: nope\n/, 'the comment was rewritten')
  assert.match(out, /-  status: nope\n/, 'the list item was rewritten')
  assert.equal((out.match(/^status:/gm) ?? []).length, 1)
})

test('CRLF stays CRLF, LF stays LF', () => {
  const crlf = NOTE.split('\n').join('\r\n')
  const replaced = setFrontmatter(crlf, 'status', 'active')
  assert.match(replaced, /\r\nstatus: active\r\n/)
  assert.doesNotMatch(replaced.split('\r\n').join(''), /\n/, 'a bare LF was introduced')

  const appended = setFrontmatter(crlf, 'updated', '2026-08-27')
  assert.match(appended, /\r\nupdated: 2026-08-27\r\n---/)

  // And the LF file is not "helpfully" converted.
  assert.doesNotMatch(setFrontmatter(NOTE, 'status', 'active'), /\r/)
})

test('a value that would parse back as something else is quoted, and only then', () => {
  const round = (v) => parseFrontmatter(setFrontmatter(NOTE, 'status', v)).status

  // Bare, because bare is what a human writing this file would type.
  for (const plain of ['active', 'in progress', 'v1.2', 'a-b_c', "Nathan's"]) {
    assert.equal(round(plain), plain, `round trip failed for ${plain}`)
    assert.match(setFrontmatter(NOTE, 'status', plain), new RegExp(`status: ${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`))
  }
  // Quoted, because these do not survive bare.
  for (const tricky of ['[draft]', '{a}', '*star', '&anchor', '>fold', 'a: b', 'x #tag', '"quoted"']) {
    assert.equal(round(tricky), tricky, `round trip failed for ${tricky}`)
  }
})

test('a pasted newline cannot forge a second key', () => {
  const out = setFrontmatter(NOTE, 'status', 'active\nowner: someone-else')
  assert.equal(parseFrontmatter(out).owner, undefined, 'a second key was forged')
  assert.equal(parseFrontmatter(out).status, 'active owner: someone-else')
})

test('the body is never touched, including a --- inside it', () => {
  const withRule = ['---', 'status: draft', '---', '', 'Intro.', '', '---', '', 'After the rule.', ''].join('\n')
  const out = setFrontmatter(withRule, 'status', 'active')
  assert.equal(stripFrontmatter(out), stripFrontmatter(withRule))
  assert.equal((out.match(/^---$/gm) ?? []).length, 3)
})
