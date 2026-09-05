/**
 * What the update panel is allowed to tell a user changed.
 *
 * The payload is public-internet JSON rendered next to an Install button, so
 * every case below is a malformed one that must not reach the renderer, or a
 * count that must not be overstated. The two that matter most are the totals
 * (summed from the files actually shown, never taken on trust) and truncation
 * (GitHub stops at 250 commits and 300 files and says so nowhere).
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { parseCompare, compareUrl } = await import('../src/shared/changelog.ts')

const commit = (message, sha = 'abc123') => ({ sha, commit: { message } })
const file = (filename, additions, deletions) => ({ filename, additions, deletions })

const payload = (over = {}) => ({
  total_commits: 2,
  commits: [commit('first thing'), commit('second thing')],
  files: [file('src/a.ts', 10, 2), file('src/b.ts', 5, 3)],
  ...over,
})

// ── the ordinary case ──────────────────────────────────────────────

test('a comparison becomes subjects, locations and line counts', () => {
  const c = parseCompare(payload())
  assert.deepEqual(c.commits, ['first thing', 'second thing'])
  assert.deepEqual(c.files, [
    { path: 'src/a.ts', added: 10, removed: 2 },
    { path: 'src/b.ts', added: 5, removed: 3 },
  ])
  assert.equal(c.added, 15)
  assert.equal(c.removed, 5)
  assert.equal(c.truncated, false)
})

test('only the subject survives a multi-line commit message', () => {
  const c = parseCompare(payload({ commits: [commit('the subject\n\nthe body\nmore body')] }))
  assert.deepEqual(c.commits, ['the subject'])
})

test('an absurd subject is trimmed rather than rendered whole', () => {
  const c = parseCompare(payload({ commits: [commit('x'.repeat(5000))] }))
  assert.equal(c.commits[0].length, 120)
})

// ── totals are summed, never trusted ───────────────────────────────

test('the total matches the files printed under it, not a field', () => {
  // A file with an unusable count is dropped, so a total taken from elsewhere
  // would disagree with the list the user can see.
  const c = parseCompare(
    payload({ files: [file('src/a.ts', 10, 2), file('src/bad.ts', 'lots', 3)] }),
  )
  assert.deepEqual(c.files, [{ path: 'src/a.ts', added: 10, removed: 2 }])
  assert.equal(c.added, 10)
  assert.equal(c.removed, 2)
})

test('negative and non-finite counts are not line counts', () => {
  const c = parseCompare(
    payload({ files: [file('src/a.ts', -5, 2), file('src/b.ts', NaN, 1), file('ok.ts', 1, 1)] }),
  )
  assert.deepEqual(c.files, [{ path: 'ok.ts', added: 1, removed: 1 }])
})

// ── truncation, which the panel has to be able to admit to ─────────

test('more commits in the range than in the payload is truncation', () => {
  const c = parseCompare(payload({ total_commits: 400 }))
  assert.equal(c.truncated, true)
})

test('hitting the file ceiling is truncation', () => {
  const files = Array.from({ length: 300 }, (_, i) => file(`src/f${i}.ts`, 1, 0))
  assert.equal(parseCompare(payload({ files })).truncated, true)
})

test('a comparison inside both ceilings is not truncated', () => {
  assert.equal(parseCompare(payload()).truncated, false)
})

// ── refusals ───────────────────────────────────────────────────────

for (const [what, raw] of [
  ['null', null],
  ['a string', 'not a comparison'],
  ['a number', 7],
  ['an array', []],
]) {
  test(`${what} is not a comparison`, () => {
    assert.equal(parseCompare(raw), null)
  })
}

test('identical refs describe no update', () => {
  assert.equal(parseCompare({ status: 'identical', total_commits: 0, commits: [], files: [] }), null)
})

test('a payload whose every entry is malformed describes no update', () => {
  const c = parseCompare({
    total_commits: 0,
    commits: [{ commit: { message: 42 } }],
    files: [{ filename: '' }],
  })
  assert.equal(c, null)
})

test('missing commits and files keys are absent, not a crash', () => {
  assert.equal(parseCompare({ total_commits: 0 }), null)
})

// ── the url ────────────────────────────────────────────────────────

test('the compare url names both ends', () => {
  assert.equal(
    compareUrl('v1.0.0', 'v1.0.1'),
    'https://api.github.com/repos/Nathan5674312/agent-workspace/compare/v1.0.0...v1.0.1',
  )
})

// ── which versions were missed ─────────────────────────────────────
// Pushing two or more releases before someone opens the app is the ordinary
// case, not the edge one: the panel names a single latest version, so without
// this the size of the gap is invisible.

const { parseReleases } = await import('../src/shared/changelog.ts')

const rel = (tag, over = {}) => ({ tag_name: tag, draft: false, prerelease: false, ...over })

test('every release newer than the running one, newest first', () => {
  const list = [rel('v1.0.3'), rel('v1.0.2'), rel('v1.0.1'), rel('v1.0.0'), rel('v0.9.0')]
  assert.deepEqual(parseReleases(list, '1.0.0'), ['1.0.3', '1.0.2', '1.0.1'])
})

test('the running version and older ones are not "newer"', () => {
  assert.deepEqual(parseReleases([rel('v1.0.0'), rel('v0.9.9')], '1.0.0'), [])
})

test('order does not depend on the order GitHub returned', () => {
  const list = [rel('v1.0.1'), rel('v1.0.3'), rel('v1.0.2')]
  assert.deepEqual(parseReleases(list, '1.0.0'), ['1.0.3', '1.0.2', '1.0.1'])
})

test('drafts and prereleases are excluded, as /releases/latest excludes them', () => {
  const list = [rel('v1.0.3', { draft: true }), rel('v1.0.2', { prerelease: true }), rel('v1.0.1')]
  assert.deepEqual(parseReleases(list, '1.0.0'), ['1.0.1'])
})

test('a retagged version is listed once, not as two updates', () => {
  assert.deepEqual(parseReleases([rel('v1.0.1'), rel('1.0.1')], '1.0.0'), ['1.0.1'])
})

test('a tag that is not a version is skipped rather than guessed at', () => {
  const list = [rel('nightly'), rel('v1.0.1'), rel(''), { tag_name: 42 }]
  assert.deepEqual(parseReleases(list, '1.0.0'), ['1.0.1'])
})

test('a prerelease sorts before the release it precedes', () => {
  // 1.0.1-beta.1 is older than 1.0.1, so a user on 1.0.1 is offered neither.
  assert.deepEqual(parseReleases([rel('v1.0.1-beta.1'), rel('v1.0.1')], '1.0.1'), [])
})

for (const [what, raw] of [
  ['a non-array', { releases: [] }],
  ['null', null],
  ['a string', 'nope'],
]) {
  test(`${what} is not a release list`, () => {
    assert.deepEqual(parseReleases(raw, '1.0.0'), [])
  })
}

test('an unreadable running version means saying nothing about the gap', () => {
  assert.deepEqual(parseReleases([rel('v1.0.1')], 'not-a-version'), [])
})
