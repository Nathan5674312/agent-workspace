/**
 * The database's sorting and grouping logic, testable for the first time.
 *
 * It was not new code and it was not broken — it sat in DatabaseView.tsx,
 * which `node --test` cannot import because type stripping does not handle
 * JSX. That file already carried a note saying `statusTone` had been moved to
 * shared/notemeta.ts for exactly that reason; these three were the same kind of
 * logic on the wrong side of the same line.
 *
 * So this file is the point of that move. Every assertion below is behaviour
 * that shipped untested.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  linkBucket,
  sortField,
  groupValues,
  FAMILY_LABEL,
  inboxCount,
} from '../src/shared/notemeta.ts'

/** A row, with only the fields these three functions read. */
const note = (over = {}) => ({
  path: 'Notes/A.md',
  title: 'A',
  folder: 'Notes',
  type: '',
  status: '',
  tags: [],
  updated: '2026-08-18',
  links: 0,
  backlinks: 0,
  ...over,
})
const noFacets = () => []

// ------------------------------------------------------------- linkBucket

test('link buckets cover every count with no gap and no overlap', () => {
  const seen = new Map()
  for (let n = 0; n <= 200; n++) seen.set(n, linkBucket(n))
  assert.equal(seen.get(0), 'Unreferenced')
  assert.equal(seen.get(1), '1–2 backlinks')
  assert.equal(seen.get(2), '1–2 backlinks')
  assert.equal(seen.get(3), '3–5 backlinks')
  assert.equal(seen.get(5), '3–5 backlinks')
  assert.equal(seen.get(6), '6–10 backlinks')
  assert.equal(seen.get(10), '6–10 backlinks')
  assert.equal(seen.get(11), '11+ backlinks')
  assert.equal(seen.get(200), '11+ backlinks')
  // Five buckets, and every count landed in exactly one of them.
  assert.equal(new Set(seen.values()).size, 5)
})

test('the bucket labels sort the way the group sort will read them', () => {
  /**
   * THE REASON THE LABELS LEAD WITH DIGITS, asserted rather than trusted. The
   * group sort uses `localeCompare(numeric: true)`, so "11+" must fall after
   * "6–10" — under a plain string sort it would come second, putting the
   * busiest notes in the middle of the list.
   */
  const labels = [0, 1, 3, 6, 11].map(linkBucket)
  const sorted = [...labels].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )
  assert.deepEqual(sorted, [
    '1–2 backlinks',
    '3–5 backlinks',
    '6–10 backlinks',
    '11+ backlinks',
    'Unreferenced',
  ])
  assert.equal(sorted.at(-1), 'Unreferenced', 'unreferenced must sort last')
})

// -------------------------------------------------------------- sortField

test('counts sort as numbers, not as strings', () => {
  /**
   * `sortField` returns a STRING for the two count columns and relies on the
   * comparator passing `numeric: true`. If it ever stops doing that, 9 sorts
   * after 42 and the Links column is quietly wrong — so the contract is pinned
   * here rather than left as a comment.
   */
  const a = sortField(note({ backlinks: 9 }), 'backlinks')
  const b = sortField(note({ backlinks: 42 }), 'backlinks')
  assert.equal(typeof a, 'string')
  assert.ok(
    a.localeCompare(b, undefined, { numeric: true }) < 0,
    `9 must sort before 42, got ${a} vs ${b}`,
  )
  // And the plain string sort it depends on NOT being is the failure it avoids.
  assert.ok(a.localeCompare(b) > 0, 'a plain sort would put 9 after 42')
})

test('area comes from the folder, not from a field', () => {
  assert.equal(sortField(note({ folder: 'Fate/Roadmap' }), 'area'), 'Fate')
})

test('title sorts by title even though a note has a path', () => {
  assert.equal(sortField(note({ title: 'Zebra', path: 'aaa.md' }), 'title'), 'Zebra')
})

// ------------------------------------------------------------ groupValues

test('a multi-tagged note belongs to EVERY one of its tags', () => {
  // The whole reason this returns an array. A note tagged [design, ui] appears
  // under both headings, as a Notion multi-select does.
  const got = groupValues(note({ tags: ['design', 'ui'] }), 'tag', noFacets)
  assert.deepEqual(got, ['design', 'ui'])
})

test('every axis returns at least one bucket, so no row can vanish', () => {
  /**
   * THE ASSERTION THAT MATTERS MOST. A row grouped into zero buckets is a note
   * that is in the vault, passes the filter, and appears nowhere on screen —
   * a disappearance rather than an error. An empty-string bucket is fine; it
   * renders as the ungrouped heading.
   */
  const axes = [
    'area', 'family', 'type', 'status', 'tag',
    'facet', 'folder', 'month', 'linked', 'none',
  ]
  const rows = [
    note(),
    note({ tags: [], type: '', status: '', folder: '', updated: '' }),
    note({ tags: ['a'], type: 'project', status: 'live', backlinks: 30 }),
  ]
  for (const key of axes) {
    for (const row of rows) {
      const got = groupValues(row, key, noFacets)
      assert.ok(Array.isArray(got), `${key} did not return an array`)
      assert.ok(got.length >= 1, `${key} put a row in no bucket at all`)
    }
  }
})

test('an unknown type groups as ungrouped, not as a family it never claimed', () => {
  // `typeFamily` answers 'none' for anything it does not recognise, and the
  // grouping must not invent a home for it.
  assert.deepEqual(groupValues(note({ type: 'zzz-nonsense' }), 'family', noFacets), [''])
})

test('a known type groups under its family label', () => {
  const got = groupValues(note({ type: 'project' }), 'family', noFacets)
  assert.equal(got.length, 1)
  assert.ok(
    Object.values(FAMILY_LABEL).includes(got[0]),
    `${got[0]} is not one of the four family labels`,
  )
})

test('facets are multi-valued and come from the callback, not the note', () => {
  const facetsOf = (path) => (path === 'Notes/A.md' ? ['dated', 'hub'] : [])
  assert.deepEqual(groupValues(note(), 'facet', facetsOf), ['dated', 'hub'])
  assert.deepEqual(groupValues(note({ path: 'other.md' }), 'facet', facetsOf), [''])
})

test('grouping by "linked" reuses the bucket function, not a second copy', () => {
  // Two implementations of the same buckets is how the group headings and the
  // legend drift apart. Same function, so they cannot.
  for (const n of [0, 2, 7, 99]) {
    assert.deepEqual(
      groupValues(note({ backlinks: n }), 'linked', noFacets),
      [linkBucket(n)],
    )
  }
})

test('the family labels and the icon map cover the same four families', () => {
  /**
   * They were one object and are now two — labels here, icons in
   * DatabaseView.tsx, because a React component cannot live in shared/. Split
   * lists of the same four names are exactly the thing that drifts, so the
   * label side is pinned to the type that defines them.
   */
  assert.deepEqual(Object.keys(FAMILY_LABEL).sort(), [
    'reference',
    'routine',
    'structure',
    'work',
  ])
})

// ------------------------------------------------------------ inboxCount

test('the inbox badge counts notes without reading a single file', () => {
  /**
   * This replaced a `useState` plus an effect that called `getInbox()`, which
   * reads and parses EVERY file in Inbox/ — 33 reads on the author's vault, at
   * every launch and after every create, move and agent write, to produce one
   * digit. Measured with a probe in `vault.read`, which is also how the cost
   * was found at all.
   */
  const tree = {
    children: [
      { kind: 'folder', name: 'Notes', children: [{ kind: 'note' }, { kind: 'note' }] },
      {
        kind: 'folder',
        name: 'Inbox',
        children: [{ kind: 'note' }, { kind: 'note' }, { kind: 'note' }],
      },
    ],
  }
  assert.equal(inboxCount(tree), 3, 'counted the wrong folder, or the wrong kinds')
})

test('a vault with no Inbox folder counts zero rather than throwing', () => {
  assert.equal(inboxCount({ children: [{ kind: 'folder', name: 'Notes', children: [] }] }), 0)
  assert.equal(inboxCount({ children: [] }), 0)
  assert.equal(inboxCount({}), 0)
  assert.equal(inboxCount(null), 0)
})

test('only notes count — not folders, canvases or loose files', () => {
  // The same `kind === 'note'` filter getInbox applies, so the badge and the
  // Inbox view cannot disagree about how many things are waiting.
  const tree = {
    children: [
      {
        kind: 'folder',
        name: 'Inbox',
        children: [
          { kind: 'note' },
          { kind: 'canvas' },
          { kind: 'file' },
          { kind: 'folder' },
        ],
      },
    ],
  }
  assert.equal(inboxCount(tree), 1)
})
