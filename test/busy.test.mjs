/**
 * THE COUNTER BEHIND THE TOP-EDGE GLOW.
 *
 * Small, and worth testing anyway, because every way it can be wrong is a way
 * the indicator gets stuck: an indicator that never turns off is worse than
 * none at all, and one that turns off early while a second read is still
 * running is the same lie in the other direction.
 *
 * The component around it is not tested here — `node --test` cannot import a
 * `.tsx` — which is exactly why the arithmetic lives in a `.ts` of its own.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const busy = await import('../src/renderer/busy.ts')

test('idle until something starts', () => {
  busy.reset()
  assert.equal(busy.isBusy(), false)
})

test('two overlapping reads keep it busy until the second finishes', () => {
  busy.reset()
  const first = busy.begin()
  const second = busy.begin()
  first()
  assert.equal(busy.isBusy(), true, 'the second read is still running')
  second()
  assert.equal(busy.isBusy(), false)
})

test('ending twice does not take the count below what is running', () => {
  busy.reset()
  const end = busy.begin()
  const other = busy.begin()
  end()
  end()
  assert.equal(busy.isBusy(), true, 'a double end() dropped a read that had not finished')
  other()
  assert.equal(busy.isBusy(), false)
})

test('a listener is told the current state the moment it subscribes', () => {
  busy.reset()
  const end = busy.begin()
  const seen = []
  busy.subscribe((b) => seen.push(b))
  assert.deepEqual(seen, [true], 'a component mounting mid-read must not paint idle')
  end()
  assert.deepEqual(seen, [true, false])
})

test('unsubscribing stops the calls', () => {
  busy.reset()
  const seen = []
  const off = busy.subscribe((b) => seen.push(b))
  off()
  busy.begin()()
  assert.deepEqual(seen, [false], 'only the subscribe-time call')
})

test('track falls on rejection too, or one failed read jams the glow on', async () => {
  busy.reset()
  await assert.rejects(busy.track(Promise.reject(new Error('read failed'))))
  assert.equal(busy.isBusy(), false)
})

test('track passes the value through untouched', async () => {
  busy.reset()
  assert.equal(await busy.track(Promise.resolve(42)), 42)
  assert.equal(busy.isBusy(), false)
})
