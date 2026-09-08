/**
 * THE FORCES CONTROLS MOVE. THEY ARE NOT ANIMATED DOING IT.
 *
 * `graph.css` moves the Forces button and its panel clear of the agent
 * activity panel, from `--agents-drop` — that panel's measured bottom edge,
 * published on <html>. That much has always been right and is what these
 * assertions protect.
 *
 * What is gone is the animation that used to play over the top of it. It was a
 * GSAP FLIP, and Nathan reported it twice, in the two ways it fails:
 *
 *   "it does not smoothly move it keeps checking for the agent box and keeps
 *    going up and down"
 *   "it keeps trying to revert back to its original spot then it goes back to
 *    where it should be"
 *
 * The first was a bug in the invert step and was fixed. The second is the
 * technique itself: a FLIP starts by putting the element back where it WAS, so
 * every play moves the control the wrong way first. On a card that changes
 * height every few hundred milliseconds — a step line, a counter — that is not
 * one play, it is a queue of them, and the control spends its life jumping
 * back and catching up.
 *
 * So the drop is CSS and nothing else: one frame, the right direction, no
 * observer, no tween, no reduced-motion branch to get wrong. These tests fail
 * if either half comes back — the JS animation, or a CSS transition on the
 * property that positions it, which would reintroduce the same visible walk
 * and reflow the graph pane on every frame besides.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')

const { prefersReducedMotion, approach, hoverSettled, hoverDelay } = await import(
  '../src/renderer/motion.ts'
)

/** Runs `fn` with `data-motion` and the OS query stubbed, then restores both. */
function withEnvironment({ attr, osPrefers }, fn) {
  const hadDocument = 'document' in globalThis
  const previousMatch = globalThis.matchMedia
  globalThis.matchMedia = (q) => ({ matches: osPrefers && q.includes('reduce') })
  if (!hadDocument) {
    globalThis.document = { documentElement: { dataset: {} } }
  }
  const dataset = globalThis.document.documentElement.dataset
  const had = dataset.motion
  if (attr === undefined) delete dataset.motion
  else dataset.motion = attr
  try {
    fn()
  } finally {
    if (had === undefined) delete dataset.motion
    else dataset.motion = had
    if (!hadDocument) delete globalThis.document
    globalThis.matchMedia = previousMatch
  }
}

test('the drop is CSS: no tween, no observer, no GSAP in the graph', () => {
  const src = read('src', 'renderer', 'panes', 'vault', 'GraphView.tsx')
  assert.ok(!/from 'gsap'/.test(src), 'GraphView imports gsap again')
  assert.ok(!/useGSAP/.test(src), 'the drop is being animated through useGSAP again')
  /**
   * The specific observer, not any observer: GraphView legitimately watches
   * `data-theme` on <html> to repaint the palette. The one that must not come
   * back is the one filtering on `style`, which is where `--agents-drop` is
   * republished — every card update fired it, and every firing replayed the
   * drop.
   */
  assert.ok(
    !/attributeFilter:\s*\['style'\]/.test(src),
    'GraphView watches the root style again, which is how the drop got replayed per card update',
  )
})

test('graph.css still moves both controls clear of the agent panel', () => {
  const css = read('src', 'renderer', 'panes', 'vault', 'graph.css')
  for (const selector of ['.graph-forces-toggle', '.graph-forces']) {
    const i = css.indexOf(`${selector} {`)
    assert.notEqual(i, -1, `no rule for ${selector}`)
    const body = css.slice(i, css.indexOf('\n}', i))
    assert.match(
      body,
      /--agents-drop/,
      `${selector} no longer follows the agent panel, so the cards cover it`,
    )
  }
})

test('the position is not transitioned either, so the move is one frame', () => {
  const css = read('src', 'renderer', 'panes', 'vault', 'graph.css')
  // Declarations only. The rules carry a comment saying why the transition is
  // gone, and a test that cannot tell prose from CSS would fail on the reason
  // for its own existence.
  const declarations = [...css.matchAll(/^\s*transition:\s*([^;]+);/gm)].map((m) => m[1])
  for (const value of declarations) {
    assert.ok(
      !/\btop\b/.test(value),
      `graph.css transitions "${value}" — the drop is meant to be instant, and a ` +
        `transition on \`top\` reflows the graph pane on every frame of it`,
    )
  }
})

/**
 * `prefersReducedMotion` outlives the animation it was written for: it is the
 * only place that reads BOTH answers, and the next thing that animates will
 * need it. The Settings → Appearance → Motion half is the half that was wrong
 * once, so it stays pinned.
 */
test('the app’s own Motion setting is honoured, not just the OS one', () => {
  withEnvironment({ attr: 'reduced', osPrefers: false }, () => {
    assert.equal(prefersReducedMotion(), true)
  })
})

test('the OS setting still counts when the app defers to it', () => {
  withEnvironment({ attr: 'system', osPrefers: true }, () => {
    assert.equal(prefersReducedMotion(), true)
  })
})

test('neither asking for it means motion runs', () => {
  withEnvironment({ attr: 'system', osPrefers: false }, () => {
    assert.equal(prefersReducedMotion(), false)
  })
})

/**
 * ── THE HOVER, WHICH WAS "A LITTLE SEIZURE MATERIAL" ──
 *
 * Nathan, sweeping the pointer across a cluster of nodes. He is describing what
 * the code did: the highlight changed on every node the pointer passed over,
 * and every change re-dimmed the WHOLE canvas — nodes 1 -> 0.09, links
 * 0.4 -> 0.07, instantly. Six nodes crossed in a second is six full-contrast
 * flips of the entire picture.
 *
 * Two things fix it and both are here rather than in the component, because
 * both are arithmetic and the component is a canvas nobody can assert against.
 */
test('a pointer passing through a node never commits to it', () => {
  const dwell = 70
  // Crossing a cluster: a few milliseconds on each node.
  assert.equal(hoverSettled(1000, 1012, dwell), false)
  assert.equal(hoverSettled(1000, 1050, dwell), false)
  // Aiming at one: the pointer stops.
  assert.equal(hoverSettled(1000, 1070, dwell), true)
  assert.equal(hoverSettled(1000, 1300, dwell), true)
})

test('the fade is frame-rate independent, or it is two different apps', () => {
  const tau = 90
  // 100ms of easing, taken in one step and in six, must land in the same place.
  const oneStep = approach(0, 1, 96, tau)
  let sixSteps = 0
  for (let i = 0; i < 6; i++) sixSteps = approach(sixSteps, 1, 16, tau)
  assert.ok(
    Math.abs(oneStep - sixSteps) < 0.001,
    `60Hz and a single long frame disagree: ${oneStep} vs ${sixSteps}`,
  )
})

test('the fade actually converges, rather than crawling forever', () => {
  let v = 0
  for (let i = 0; i < 20; i++) v = approach(v, 1, 16, 90)
  assert.ok(v > 0.95, `after 320ms the highlight is only ${v} of the way in`)
  assert.ok(v < 1, 'an exponential never arrives — the caller snaps the last sliver')
})

test('reduced motion is the end state with no travel', () => {
  assert.equal(approach(0, 1, 16, 0), 1)
  assert.equal(approach(0.4, 0, 16, 0), 0)
})

/**
 * ── AND THEN THE OPPOSITE COMPLAINT ──
 *
 * "I hover above Home then a random skill and the amount of time to change
 * what's highlighted is really bad."
 *
 * One dwell was being charged for two different events. Dimming the whole
 * canvas is worth being deliberate about; changing which node is lit while it
 * is ALREADY dim is not, and it was paying the same 70ms.
 */
test('starting a highlight is deliberate, switching one is not', () => {
  const cold = hoverDelay(false, true)
  const switching = hoverDelay(true, true)
  assert.ok(cold >= 60, `a cold hover commits after ${cold}ms — a sweep would strobe again`)
  assert.ok(switching <= 30, `switching costs ${switching}ms, which is the delay he reported`)
  assert.ok(switching < cold, 'the two cases must not be the same number again')
})

test('a pointer between two nodes has not left, it is in the gap', () => {
  // Longer than the switch, so crossing empty canvas between two nodes does not
  // fade the highlight out and back in — the flicker in different clothes.
  assert.ok(hoverDelay(true, false) > hoverDelay(true, true))
})

test('the switch still outlasts the time a sweep spends on one node', () => {
  // 50 moves across the cluster in 549ms, measured: ~11ms per node.
  assert.ok(hoverDelay(true, true) > 11)
})
