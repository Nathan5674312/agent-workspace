/**
 * notemeta — the shared normalisation behind the database view.
 *
 * Worth testing on its own because both of its jobs are about inputs this app
 * does not control: frontmatter written by hand, and a note server running a
 * version we cannot pin.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { areaOf, toMeta, statusTone, parseProposal, NONE } from '../src/shared/notemeta.ts'

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
  }

  await t.test('a complete row passes through intact', () => {
    assert.deepEqual(toMeta(full), { ...full, mtime: 0 })
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
