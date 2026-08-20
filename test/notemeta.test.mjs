/**
 * notemeta — the shared normalisation behind the database view.
 *
 * Worth testing on its own because both of its jobs are about inputs this app
 * does not control: frontmatter written by hand, and a note server running a
 * version we cannot pin.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  parseYmd,
  areaOf,
  toMeta,
  statusTone,
  parseProposal,
  parseList,
  typeFamily,
  monthOf,
  NONE,
} from '../src/shared/notemeta.ts'

test('areaOf collapses 99 folders onto a groupable axis', async (t) => {
  await t.test('a nested folder becomes its first segment', () => {
    assert.equal(areaOf({ folder: 'Business/Claude Code Extension' }), 'Business')
    assert.equal(
      areaOf({ folder: 'System/Skills/ship/sections' }),
      'System',
      'depth must not matter — the point is one bucket per top-level area',
    )
  })

  await t.test('a single-segment folder is already an area', () => {
    assert.equal(areaOf({ folder: 'Projects' }), 'Projects')
  })

  await t.test('root notes keep the server sentinel', () => {
    assert.equal(areaOf({ folder: '(root)' }), '(root)')
    // An empty folder must not produce an empty group name, which would render
    // as a nameless section header.
    assert.equal(areaOf({ folder: '' }), '(root)')
  })
})

test('toMeta survives a note server it does not control', async (t) => {
  const full = {
    path: 'Business/Plan.md',
    title: 'Plan',
    folder: 'Business',
    type: 'project',
    status: 'ACTIVE',
    updated: '2026-08-15',
    depth: 2,
    orphan: false,
    // Real values rather than the 0 defaults, so the deepEqual below proves the
    // relation counts pass THROUGH rather than proving they fall back.
    links: 4,
    backlinks: 7,
    reachRoot: 'Home.md',
  }

  await t.test('a complete row passes through intact', () => {
    // `tags` is normalised to [] rather than omitted: the database maps over it
    // on every row, so absent has to be an empty list and not undefined.
    assert.deepEqual(toMeta(full), { ...full, mtime: 0, tags: [] })
  })

  await t.test('an OLDER server omitting status/updated yields blanks, not undefined', () => {
    // This is the case the defence exists for: server.py is a separate process
    // and these two fields were only added on 2026-08-15. `undefined` here
    // would crash the table's sort on undefined.localeCompare.
    const { status, updated, ...old } = full
    const m = toMeta(old)
    assert.equal(m.status, '')
    assert.equal(m.updated, '')
    assert.equal(typeof m.status, 'string', 'sorting calls localeCompare on this')
  })

  await t.test('a server that sends no relation counts yields 0, not undefined', () => {
    // Same defence, one field set later than the rest: the relation columns
    // render `n.links || —`, and `undefined` there would print the em-dash
    // correctly but sort as a blank rather than as a zero.
    const { links, backlinks, ...old } = full
    const m = toMeta(old)
    assert.equal(m.links, 0)
    assert.equal(m.backlinks, 0)
  })

  await t.test('a missing title falls back to the filename stem', () => {
    const m = toMeta({ path: 'Notes/No Frontmatter.md', folder: 'Notes' })
    assert.equal(m.title, 'No Frontmatter')
  })

  await t.test('garbage rows are dropped, not rendered', () => {
    for (const bad of [null, undefined, 42, 'a string', {}, { path: '' }, { title: 'no path' }]) {
      assert.equal(toMeta(bad), null, `should have rejected ${JSON.stringify(bad)}`)
    }
  })

  await t.test('orphan is strictly boolean', () => {
    // The server sends a real boolean; anything truthy-but-not-true (a string
    // "false" from some future encoder) must not silently flag a note.
    assert.equal(toMeta({ ...full, orphan: 'false' }).orphan, false)
    assert.equal(toMeta({ ...full, orphan: true }).orphan, true)
  })

  await t.test('depth is null when absent, never 0', () => {
    // 0 would mean "this IS Home"; absent means unknown. Conflating them puts
    // unreachable notes at the top of a depth sort.
    const { depth, ...noDepth } = full
    assert.equal(toMeta(noDepth).depth, null)
  })

  await t.test('NONE is a non-empty label for the empty bucket', () => {
    assert.ok(NONE.length > 0)
  })
})

test('statusTone reads freeform status prose', async (t) => {
  await t.test('the real values in this vault land in the right bucket', () => {
    assert.equal(statusTone('ACTIVE'), 'live')
    assert.equal(statusTone('CATALOGUED'), 'live')
    // A full sentence. An exact-match lookup table would miss every one of these.
    assert.equal(
      statusTone('FIXED on disk 2026-08-10 — live server still runs the old code'),
      'live',
    )
    assert.equal(statusTone('SPEC — not built'), 'soon')
    assert.equal(statusTone('PLAN — design only, not started'), 'soon')
    assert.equal(statusTone('PARKED — not started'), 'soon')
    assert.equal(statusTone('blocked-on-domain-access'), 'stop')
  })

  await t.test('an unknown word gets no tone rather than a guessed one', () => {
    // A wrong colour asserts something about the note nobody wrote.
    assert.equal(statusTone('north-star'), 'none')
    assert.equal(statusTone('banana'), 'none')
    assert.equal(statusTone(''), 'none')
  })

  await t.test('separator and case do not matter, only the leading word', () => {
    for (const s of ['blocked', 'BLOCKED', 'Blocked: waiting', 'blocked—on—x', 'blocked_on_x']) {
      assert.equal(statusTone(s), 'stop', `failed on ${JSON.stringify(s)}`)
    }
  })

  await t.test('a leading non-letter does not shift the word that is read', () => {
    // "— ACTIVE" must not read as "" and fall through to none.
    assert.equal(statusTone('— ACTIVE'), 'live')
    assert.equal(statusTone('  2026 blocked'), 'stop')
  })
})

test('parseProposal reads what an agent left in the Inbox', async (t) => {
  // Verbatim shape of a real capture on disk.
  const real = [
    '---',
    'proposed_title: "Daily Market Analysis Routine"',
    'proposed_folder: Trading',
    'alternatives: [System, Business]',
    'proposed_type: playbook',
    'captured: 2026-08-06',
    '---',
    '',
    'The system must never ask the user to maintain it.',
  ].join('\n')

  await t.test('the proposal is extracted whole', () => {
    const p = parseProposal('Inbox/20260806-130827.md', real)
    assert.equal(p.title, 'Daily Market Analysis Routine')
    assert.equal(p.folder, 'Trading')
    assert.deepEqual(p.alternatives, ['System', 'Business'])
    assert.equal(p.type, 'playbook')
    assert.equal(p.captured, '2026-08-06')
    assert.equal(p.body, 'The system must never ask the user to maintain it.')
    assert.ok(!p.body.includes('---'), 'frontmatter leaked into the body')
  })

  await t.test('a capture with NO frontmatter still renders', () => {
    // One of the ten real items is exactly this. A queue that throws on the
    // scruffiest thing in it is useless precisely when it matters.
    const p = parseProposal('Inbox/20260806-125145.md', 'george flowberry broke')
    assert.equal(p.title, '20260806-125145', 'should fall back to the filename')
    assert.equal(p.folder, '')
    assert.deepEqual(p.alternatives, [])
    assert.equal(p.body, 'george flowberry broke')
  })

  await t.test('an unterminated frontmatter block is not swallowed', () => {
    // Without the end-marker check, everything after `---` would vanish.
    const p = parseProposal('Inbox/x.md', '---\nproposed_folder: Trading\nno end marker')
    assert.equal(p.folder, '', 'must not trust a block that never closed')
    assert.ok(p.body.includes('no end marker'), 'body was swallowed')
  })

  await t.test('an empty alternatives list yields no empty strings', () => {
    const p = parseProposal('Inbox/x.md', '---\nalternatives: []\n---\nbody')
    assert.deepEqual(p.alternatives, [], 'split produced a phantom entry')
  })
})

test('typeFamily sorts freeform types into four categories', async (t) => {
  await t.test('hyphenated types key off their first word', () => {
    // The reason this is not an exact-value table: the vault writes
    // `master-index` and `design-system`, and neither would ever match.
    assert.equal(typeFamily('master-index'), 'structure')
    assert.equal(typeFamily('design-system'), 'reference')
  })

  await t.test('case does not matter', () => {
    assert.equal(typeFamily('PROJECT'), 'work')
    assert.equal(typeFamily('Daily'), 'routine')
  })

  await t.test('an unknown type is never guessed into a family', () => {
    // Same rule statusTone holds: a wrong category asserts something about the
    // note that nobody wrote, and renders as the plain chip instead.
    assert.equal(typeFamily('flowberry'), 'none')
    assert.equal(typeFamily(''), 'none')
  })
})

test('monthOf groups dates without ever constructing one', async (t) => {
  await t.test('an ISO date yields its year and month', () => {
    assert.equal(monthOf('2026-08-15'), '2026-08')
  })

  await t.test('a non-ISO date groups as unset rather than shifting', () => {
    // `new Date('2026-8-1')` parses and then moves under the local timezone,
    // which would file a note into the wrong month with no way to see it.
    assert.equal(monthOf('2026-8-1'), '')
    assert.equal(monthOf('August 2026'), '')
    assert.equal(monthOf(''), '')
  })
})

test('parseList reads the one-line frontmatter list both ways', async (t) => {
  await t.test('a bracketed list', () => {
    assert.deepEqual(parseList('[design, ui]'), ['design', 'ui'])
  })

  await t.test('a bare comma list, and quoted values', () => {
    assert.deepEqual(parseList('design, ui'), ['design', 'ui'])
    assert.deepEqual(parseList('"design", "ui"'), ['design', 'ui'])
  })

  await t.test('empty and ragged input yield no phantom entries', () => {
    assert.deepEqual(parseList(''), [])
    assert.deepEqual(parseList('[]'), [])
    assert.deepEqual(parseList('design, , ui'), ['design', 'ui'])
  })
})

test('toMeta accepts tags from either shape on the wire', async (t) => {
  const base = { path: 'a.md', title: 'A', folder: 'Business' }

  await t.test('an array from this app own main process', () => {
    assert.deepEqual(toMeta({ ...base, tags: ['design', 'ui'] }).tags, ['design', 'ui'])
  })

  await t.test('a raw string from an older server', () => {
    assert.deepEqual(toMeta({ ...base, tags: '[design, ui]' }).tags, ['design', 'ui'])
  })

  await t.test('absent tags are an empty list, never undefined', () => {
    // The database maps over this on every row; undefined would throw.
    assert.deepEqual(toMeta(base).tags, [])
    assert.deepEqual(toMeta({ ...base, tags: null }).tags, [])
  })

  await t.test('a ragged array drops non-strings instead of rendering them', () => {
    assert.deepEqual(toMeta({ ...base, tags: ['ui', 3, null, ''] }).tags, ['ui'])
  })
})

test('parseYmd turns hand-written frontmatter into a real day, or nothing', async (t) => {
  await t.test('an ISO date yields its parts', () => {
    assert.deepEqual(parseYmd('2026-08-18'), { y: 2026, m: 8, d: 18 })
    // A time after the date is fine — the day is what a calendar needs.
    assert.deepEqual(parseYmd('2026-01-02T13:45:00Z'), { y: 2026, m: 1, d: 2 })
    assert.deepEqual(parseYmd('  2026-12-31  '), { y: 2026, m: 12, d: 31 })
  })

  await t.test('a day that does not exist is not a date', () => {
    // The whole reason for the round trip: these parse as three plausible
    // numbers, and `new Date` would roll them forward into March silently.
    assert.equal(parseYmd('2026-02-30'), null)
    assert.equal(parseYmd('2025-02-29'), null)
    assert.equal(parseYmd('2026-13-01'), null)
    assert.equal(parseYmd('2026-00-10'), null)
    assert.equal(parseYmd('2026-01-32'), null)
  })

  await t.test('a leap day in a leap year IS a date', () => {
    assert.deepEqual(parseYmd('2028-02-29'), { y: 2028, m: 2, d: 29 })
  })

  await t.test('anything not ISO-shaped is refused rather than guessed', () => {
    // `new Date()` accepts every one of these. That is exactly the problem:
    // it would place notes on days their author never wrote.
    for (const bad of ['2026-8-1', 'August 2026', '18/08/2026', '2026', '', 'soon', 'yesterday']) {
      assert.equal(parseYmd(bad), null, `${JSON.stringify(bad)} should not parse`)
    }
  })

  await t.test('the day never shifts, whatever the local timezone', () => {
    // The bug this guards: `new Date('2026-08-18')` is UTC midnight, which in
    // any negative-offset zone renders as the 17th. Parsing digits cannot shift.
    const parsed = parseYmd('2026-08-18')
    assert.equal(parsed.d, 18)
    assert.equal(new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).getUTCDate(), 18)
  })
})
