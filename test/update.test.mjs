/**
 * The update check, which is pure except for one fetch that lives elsewhere.
 *
 * The stake: this code decides whether to tell a person their app is out of
 * date. Being wrong in either direction is bad — a false "up to date" hides the
 * fix they need, and a false "update available" sends them to download what
 * they already have, or worse, offers a downgrade.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_FEED,
  DOWNLOAD_PAGE,
  normalise,
  isVersion,
  compareVersions,
  parseFeed,
  decide,
} from '../src/shared/update.ts'

// ------------------------------------------------------------------ ordering

test('ordering is numeric, not lexicographic', () => {
  // The bug this pins: '10' < '9' as strings, so a string sort tells everyone
  // on 1.9.0 that 1.10.0 is older and hides the release.
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1)
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
})

test('a missing component is zero, not older', () => {
  // electron-builder writes two-part versions into some feeds. '1.0' and
  // '1.0.0' are the SAME build and offering an upgrade between them would send
  // a user to download what they are already running.
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0.0', '1.0'), 0)
  assert.equal(compareVersions('1', '1.0.1'), -1)
})

test('a leading v is a tag spelling, not a different version', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(normalise('  V1.2.3 '), '1.2.3')
})

test('a prerelease is OLDER than the release it precedes', () => {
  // Backwards here is the one outcome an update prompt must never produce:
  // every user on a stable 1.0.0 offered a "newer" 1.0.0-beta.1.
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta.2'), -1)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta.1'), 0)
  // And a prerelease of a HIGHER version still wins on the numbers.
  assert.equal(compareVersions('1.1.0-beta.1', '1.0.0'), 1)
})

test('equality is equality', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

// -------------------------------------------------------------------- shapes

test('only a narrow version shape is accepted', () => {
  for (const good of ['1', '1.0', '1.0.0', '1.0.0.0', '1.0.0-beta.1', 'v2.3.4']) {
    assert.ok(isVersion(good), `${good} should parse`)
  }
  for (const bad of ['', 'latest', '1.0.0.0.0', 'one.two', '1.0.0 ; rm -rf', '${x}']) {
    assert.ok(!isVersion(bad), `${bad} should NOT parse`)
  }
})

test('the feed is checked, not trusted', () => {
  assert.equal(parseFeed(null), null)
  assert.equal(parseFeed('1.0.1'), null, 'a bare string is not the contract')
  assert.equal(parseFeed([]), null)
  assert.equal(parseFeed({}), null)
  assert.equal(parseFeed({ version: 42 }), null, 'a number is not a version string')
  assert.equal(parseFeed({ version: 'latest' }), null)
})

test('a feed url that is not http(s) falls back rather than being followed', () => {
  // This value reaches shell.openExternal. `javascript:` and `file:` are the
  // reason isExternallyOpenable exists in main/index.ts, and the feed is a
  // second door into the same call.
  for (const hostile of [
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'not a url',
    '',
  ]) {
    const out = parseFeed({ version: '1.0.1', url: hostile })
    assert.deepEqual(out, { version: '1.0.1', url: DOWNLOAD_PAGE }, `followed ${hostile}`)
  }
  const ok = parseFeed({ version: '1.0.1', url: 'https://example.com/dl' })
  assert.deepEqual(ok, { version: '1.0.1', url: 'https://example.com/dl' })
})

test('a feed with no url at all still answers, using the download page', () => {
  assert.deepEqual(parseFeed({ version: 'v1.0.1' }), {
    version: '1.0.1',
    url: DOWNLOAD_PAGE,
  })
})

// -------------------------------------------------------------------- decide

test('newer feed version means available', () => {
  const out = decide('1.0.0', { version: '1.0.1' })
  assert.deepEqual(out, {
    state: 'available',
    version: '1.0.0',
    latest: '1.0.1',
    url: DOWNLOAD_PAGE,
  })
})

test('same version means current, and so does an OLDER feed', () => {
  assert.deepEqual(decide('1.0.0', { version: '1.0.0' }), { state: 'current', version: '1.0.0' })
  // A feed that has gone backwards must never offer a downgrade.
  assert.deepEqual(decide('1.1.0', { version: '1.0.0' }), { state: 'current', version: '1.1.0' })
})

test('an unreadable feed says so instead of guessing either way', () => {
  const out = decide('1.0.0', undefined)
  assert.equal(out.state, 'unknown')
  assert.equal(out.version, '1.0.0')
  assert.match(out.reason, /feed/i)
})

test('a build with no readable version is unknown, not out of date', () => {
  const out = decide('dev', { version: '1.0.1' })
  assert.equal(out.state, 'unknown')
  assert.match(out.reason, /version/i)
})

// --------------------------------------------------------------------- feeds

test('both constants are https and neither is the private GitHub API', () => {
  // The GitHub releases API 404s anonymously because the repo is private;
  // pointing the feed there would ship a check that can only ever fail, or a
  // token handed to everyone who downloads the app.
  for (const u of [UPDATE_FEED, DOWNLOAD_PAGE]) {
    assert.equal(new URL(u).protocol, 'https:')
    assert.ok(!u.includes('api.github.com'), `${u} is the auth-walled feed`)
  }
})
