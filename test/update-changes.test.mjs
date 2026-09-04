/**
 * The refs the compare endpoint is allowed to be handed.
 *
 * `changes()` is the one place in the app where a value from the renderer is
 * interpolated into a URL. `compareUrl` does no escaping — it is a template —
 * so the guard is `isVersion`, the same gate the feed's own tag goes through,
 * and these are the strings that must never reach a request.
 *
 * Every case here returns before any network call, which is what makes them
 * runnable offline: a rejected ref never gets as far as `fetchJson`.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { changes } = await import('../src/main/update.ts')

const refused = [
  ['path traversal', '../../../user/repo/contents/.env'],
  ['a traversal hidden after a valid version', '1.0.0/../../..'],
  ['an absolute url', 'https://example.com/evil'],
  ['a protocol-relative url', '//example.com'],
  ['a query string', '1.0.0?per_page=100'],
  ['a fragment', '1.0.0#frag'],
  ['a branch name', 'main'],
  ['a raw sha', 'de80b34c1c10519767c2328714837d3596aef81f1'],
  ['a space', '1.0.0 1.0.1'],
  ['an empty string', ''],
  ['a newline', '1.0.0\nHost: evil'],
]

for (const [what, ref] of refused) {
  test(`${what} is refused as a base`, async () => {
    assert.equal(await changes(ref, '1.0.1'), null)
  })
  test(`${what} is refused as a head`, async () => {
    assert.equal(await changes('1.0.0', ref), null)
  })
}
