/**
 * Bookmarks — src/shared/bookmarks.ts.
 *
 * This module writes a file ANOTHER PROGRAM owns. Obsidian's Bookmarks plugin
 * reads and rewrites `.obsidian/bookmarks.json`, so the failures worth guarding
 * are not "the panel looks wrong" but "we silently destroyed something Obsidian
 * put there": a saved search dropped because this app has no concept of one, a
 * group flattened away, an empty group tidied up.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  addBookmark,
  bookmarkLabel,
  flattenBookmarks,
  isBookmarked,
  isOpenable,
  parseBookmarks,
  removeBookmark,
  serializeBookmarks,
} from '../src/shared/bookmarks.ts'

/** A file in Obsidian's real shape, including kinds this app cannot act on. */
const REAL = JSON.stringify({
  items: [
    { type: 'file', ctime: 1, path: 'Home.md' },
    { type: 'search', ctime: 2, query: 'tag:#idea' },
    { type: 'graph', ctime: 3 },
    {
      type: 'group',
      ctime: 4,
      title: 'Reading',
      items: [
        { type: 'file', ctime: 5, path: 'Business/Plan.md' },
        { type: 'folder', ctime: 6, path: 'Daily' },
      ],
    },
  ],
})

test('a malformed or half-written file reads as empty, never throws', () => {
  // Obsidian can be caught mid-write. Throwing here would blank the panel with
  // an exception; an empty list is the honest reading and destroys nothing,
  // because nothing is written until the user acts.
  for (const bad of ['', '{', 'null', '[]', '{"items":"nope"}', 'not json']) {
    assert.deepEqual(parseBookmarks(bad), [], JSON.stringify(bad))
  }
})

test('groups are walked, and every kind survives the flatten', () => {
  const flat = flattenBookmarks(parseBookmarks(REAL))
  assert.equal(flat.length, 5, 'an entry was lost')
  assert.deepEqual(
    flat.map((f) => f.bookmark.type),
    ['file', 'search', 'graph', 'file', 'folder'],
  )
  // The group a bookmark came out of is carried, so the panel can show it.
  assert.equal(flat.find((f) => f.bookmark.path === 'Business/Plan.md').group, 'Reading')
  assert.equal(flat.find((f) => f.bookmark.path === 'Home.md').group, '')
})

test('adding never disturbs what Obsidian put there', () => {
  const before = parseBookmarks(REAL)
  const after = addBookmark(before, 'New.md')
  // Everything that was there is still there, unchanged and in order.
  assert.deepEqual(after.slice(0, before.length), before)
  assert.equal(after.length, before.length + 1)
  assert.deepEqual(after[after.length - 1].type, 'file')
  assert.equal(after[after.length - 1].path, 'New.md')
})

test('adding is idempotent, including for a note inside a group', () => {
  const items = parseBookmarks(REAL)
  assert.equal(addBookmark(items, 'Home.md'), items, 'a duplicate top-level entry was added')
  // The one that matters: already bookmarked INSIDE a group. A shallow check
  // would add a second copy at the top level and the note would appear twice.
  assert.equal(addBookmark(items, 'Business/Plan.md'), items, 'duplicated a grouped bookmark')
})

test('a new bookmark goes to the top level, never into someone else pile', () => {
  const after = addBookmark(parseBookmarks(REAL), 'New.md')
  const group = after.find((i) => i.type === 'group')
  assert.equal(group.items.length, 2, 'a group was modified by an add')
})

test('removing finds the note inside a group, and keeps the group', () => {
  const after = removeBookmark(parseBookmarks(REAL), 'Business/Plan.md')
  assert.equal(isBookmarked(after, 'Business/Plan.md'), false)
  const group = after.find((i) => i.type === 'group')
  assert.ok(group, 'the group was deleted along with its last file')
  assert.equal(group.items.length, 1, 'the folder bookmark in the group was lost')
})

test('removing never touches searches or graph bookmarks', () => {
  // The worst thing a shared file format can do: quietly delete what the other
  // program understands and this one does not.
  const after = removeBookmark(parseBookmarks(REAL), 'Home.md')
  assert.ok(after.some((i) => i.type === 'search'), 'a saved search was dropped')
  assert.ok(after.some((i) => i.type === 'graph'), 'a graph bookmark was dropped')
})

test('a round trip through serialize preserves every entry', () => {
  const items = parseBookmarks(REAL)
  assert.deepEqual(parseBookmarks(serializeBookmarks(items)), items)
  assert.ok(serializeBookmarks(items).endsWith('\n'), 'no trailing newline')
})

test('labels follow Obsidian rules, and a renamed bookmark wins', () => {
  assert.equal(bookmarkLabel({ type: 'file', path: 'Business/Plan.md' }), 'Plan')
  assert.equal(bookmarkLabel({ type: 'file', path: 'Plan.md', title: 'The plan' }), 'The plan')
  assert.equal(bookmarkLabel({ type: 'file', path: 'Plan.md', subpath: '#Risks' }), 'Plan #Risks')
  assert.equal(bookmarkLabel({ type: 'search', query: 'tag:#idea' }), 'Search: tag:#idea')
  assert.equal(bookmarkLabel({ type: 'folder', path: 'Daily' }), 'Daily')
})

test('only files and folders claim to be openable here', () => {
  assert.equal(isOpenable({ type: 'file', path: 'a.md' }), true)
  assert.equal(isOpenable({ type: 'folder', path: 'Daily' }), true)
  assert.equal(isOpenable({ type: 'search', query: 'x' }), false)
  assert.equal(isOpenable({ type: 'graph' }), false)
  assert.equal(isOpenable({ type: 'file' }), false, 'a file with no path is not openable')
})
