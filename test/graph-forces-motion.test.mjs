/**
 * THE FORCES DROP, AND THE TWO WAYS IT SILENTLY BREAKS.
 *
 * Forces and the agent activity panel share the top-right corner of the graph,
 * so while agents work the button was behind the cards — hittable, since
 * `.activity` is `pointer-events: none`, but invisible, and a control you
 * cannot see is not a control. `--agents-drop` moves it clear. GSAP plays that
 * move, as Nathan asked on 2026-09-04.
 *
 * BREAK ONE: a CSS `transition` on the same property. GSAP writes `y` every
 * tick; a transition on the element's `top` starts interpolating away from
 * whatever CSS recomputed on the same frame. Two interpolators, one control,
 * both losing — and the symptom is a stutter nobody can attribute, because
 * each half looks right in isolation. This is the single most common way a
 * GSAP integration goes bad, and the stylesheet is where it comes back.
 *
 * BREAK TWO: reduced motion. The check has to happen when the tween fires, not
 * once at setup, because BOTH of its inputs can change while the app is open —
 * the OS setting, and Settings → Appearance → Motion, which writes
 * `data-motion` on <html>. `prefersReducedMotion` consulted only the OS query
 * until now, which made the app's own Motion → Reduced a lie for every
 * hand-run animation: the stylesheet obeyed it and the JavaScript did not.
 * That half is a real unit test below, not a regex.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const { prefersReducedMotion } = await import('../src/renderer/motion.ts')

/** Stand in for the two globals the helper reads, then put them back. */
function withEnvironment({ attr, osPrefers }, run) {
  const hadDoc = 'document' in globalThis
  const hadMM = 'matchMedia' in globalThis
  const oldDoc = globalThis.document
  const oldMM = globalThis.matchMedia
  globalThis.document = { documentElement: { dataset: attr === null ? {} : { motion: attr } } }
  globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') && osPrefers })
  try {
    run()
  } finally {
    if (hadDoc) globalThis.document = oldDoc
    else delete globalThis.document
    if (hadMM) globalThis.matchMedia = oldMM
    else delete globalThis.matchMedia
  }
}

test('the app’s own Motion setting is honoured, not just the OS one', () => {
  // THE BUG. Someone sets Settings -> Appearance -> Motion -> Reduced on a
  // machine whose OS is happy with animation. Every CSS transition stops,
  // because the stylesheet reads the attribute; every JS animation carried on,
  // because this helper did not.
  withEnvironment({ attr: 'reduced', osPrefers: false }, () => {
    assert.equal(prefersReducedMotion(), true, 'data-motion="reduced" was ignored')
  })
})

test('the OS setting still counts when the app defers to it', () => {
  // `system` writes NO attribute at all — that is the point of it — so the
  // media query has to remain the fallback rather than the exception.
  withEnvironment({ attr: null, osPrefers: true }, () => {
    assert.equal(prefersReducedMotion(), true, 'the OS query stopped being consulted')
  })
})

test('neither asking for it means motion runs', () => {
  withEnvironment({ attr: null, osPrefers: false }, () => {
    assert.equal(prefersReducedMotion(), false, 'motion is being suppressed for nobody')
  })
  // An explicit non-reduced choice is not a reduced one.
  withEnvironment({ attr: 'system', osPrefers: false }, () => {
    assert.equal(prefersReducedMotion(), false)
  })
})

test('graph.css declares no transition on the property GSAP animates', () => {
  const css = read('src', 'renderer', 'panes', 'vault', 'graph.css')
  // Declarations only. The rules carry a comment saying why the transition is
  // gone, and a test that cannot tell prose from CSS would fail on the reason
  // for its own existence.
  const declarations = [...css.matchAll(/^\s*transition:\s*([^;]+);/gm)].map((m) => m[1])
  for (const value of declarations) {
    assert.ok(
      !/\btop\b/.test(value),
      `graph.css transitions "${value}" — GSAP writes this element's position, ` +
        `so a transition on it puts two interpolators on one value`,
    )
  }
})

test('the drop is wired through GSAP with the teardown React needs', () => {
  const src = read('src', 'renderer', 'panes', 'vault', 'GraphView.tsx')
  assert.match(src, /from 'gsap'/, 'GraphView no longer imports gsap')
  assert.match(src, /useGSAP\(/, 'the drop is not inside useGSAP, so nothing reverts it')
  assert.match(src, /scope:\s*wrapRef/, 'useGSAP has no scope, so its selectors leak globally')
  assert.match(
    src,
    /contextSafe!?\(/,
    'the observer callback is not contextSafe, so its tweens are never cleaned up',
  )
  assert.match(
    src,
    /prefersReducedMotion\(\)/,
    'the tween fires without asking about reduced motion',
  )
  assert.match(
    src,
    /watch\.disconnect\(\)/,
    'the MutationObserver outlives the component that made it',
  )
})

test('gsap is installed from npm, with no Club-era registry left behind', () => {
  const pkg = JSON.parse(read('package.json'))
  const gsap = pkg.dependencies?.gsap ?? pkg.devDependencies?.gsap
  assert.ok(gsap, 'gsap is not installed')
  /**
   * GSAP has been free since April 2025 — every former Club plugin included —
   * and the old advice to point the scope at `npm.greensock.com` with an auth
   * token is now just a build that fails for anyone who clones this. There is
   * no token to leak because there is no token.
   */
  const lock = read('package-lock.json')
  assert.ok(!lock.includes('npm.greensock.com'), 'the lockfile points at the Club registry')
})
