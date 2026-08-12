/**
 * SECTION 3 review suite — agent corner (consent surface) + network trust.
 *
 * These tests drive the REAL modules. `./fixtures/ts-hooks.mjs` rewrites the
 * project's `./foo.js` specifiers to `foo.ts` and swaps the `electron`
 * dependency for a stub, so `src/main/corner.ts` and `src/main/network.ts` are
 * imported as-is and their own `register()` is called with a recording handle.
 * Nothing here re-implements or copies a module under test.
 *
 * Two kinds of test:
 *   1. Behaviour — the real handlers, the real promise plumbing, a real trust
 *      store on disk in a scratch userData dir, and (on Windows) the real
 *      subprocess detection.
 *   2. Source invariants — properties that must hold by construction and that
 *      no unit test can observe: no timeout that auto-resolves a consent, no
 *      interpolation into a child-process argument, the OS profile never
 *      feeding `trusted`, no `javascript:`-capable href on agent-authored
 *      content, no colour-only warning.
 *
 * Note on the network tests: they run against whatever network this machine is
 * actually on. Every assertion is therefore written so that it holds both when
 * detection succeeds and when it fails — because "detection failed" must mean
 * "untrusted", and that is the property under test. The one test that needs
 * detection to work (the positive control, which proves the negative tests are
 * not vacuous) skips itself when no fingerprint is obtainable.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8')

/**
 * Source with comments removed, for invariants about what the CODE does.
 * A source-level test greps raw text and cannot tell an implementation from a
 * comment describing one — and both of these files carry long comments that
 * name the very patterns being forbidden ("never `exec*` with a built string",
 * "no code path that resolves true"). Grepping the raw text would fail on
 * correct code, which is the worst failure mode a guard test has.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const CORNER_SRC = read('src/main/corner.ts')
const NETWORK_SRC = read('src/main/network.ts')
const AGENT_CORNER_SRC = read('src/renderer/panes/corner/AgentCorner.tsx')
const ARTIFACT_SRC = read('src/renderer/panes/corner/ArtifactItem.tsx')
const CONSENT_SRC = read('src/renderer/panes/corner/ConsentItem.tsx')
const BASE_CSS = read('src/renderer/base.css')

const CORNER_CODE = stripComments(CORNER_SRC)
const NETWORK_CODE = stripComments(NETWORK_SRC)
const AGENT_CORNER_CODE = stripComments(AGENT_CORNER_SRC)
const ARTIFACT_CODE = stripComments(ARTIFACT_SRC)
const CONSENT_CODE = stripComments(CONSENT_SRC)

// ------------------------------------------------------------- real modules

const PREV_USER_DATA = process.env.TEST_USER_DATA
const USER_DATA = mkdtempSync(join(tmpdir(), 'corner-s3-review-'))
process.env.TEST_USER_DATA = USER_DATA

// network.ts computes its trust-store path at module scope from
// app.getPath('userData'), so the env has to be set before the import.
const corner = await import('../src/main/corner.ts')
const network = await import('../src/main/network.ts')

// Leave the environment as it was found; later suites import other modules.
if (PREV_USER_DATA === undefined) delete process.env.TEST_USER_DATA
else process.env.TEST_USER_DATA = PREV_USER_DATA

const TRUST_STORE = join(USER_DATA, 'network-trust.json')

/** channel -> handler, captured from each module's own register(). */
const H = new Map()
corner.register((channel, fn) => H.set(channel, fn))
network.register((channel, fn) => H.set(channel, fn))

const CH = {
  cornerItems: 'corner:items',
  cornerDecide: 'corner:decide',
  cornerDismiss: 'corner:dismiss',
  networkTrust: 'network:trust',
  networkTrustCurrent: 'network:trust-current',
}

const items = () => H.get(CH.cornerItems)()
const decide = (d) => H.get(CH.cornerDecide)(d)
const dismiss = (id) => H.get(CH.cornerDismiss)(id)

const PENDING = Symbol('pending')

/** Resolve to PENDING if `p` has not settled within `ms`. */
function settledWithin(p, ms) {
  let timer
  const sentinel = new Promise((r) => {
    timer = setTimeout(() => r(PENDING), ms)
  })
  return Promise.race([p, sentinel]).finally(() => clearTimeout(timer))
}

/** Raise a consent and return { promise, id }. */
function raise(overrides = {}) {
  const before = new Set(items().map((i) => i.id))
  const promise = corner.requestConsent({
    title: 'Allow Write',
    detail: 'The agent wants to write Home.md to the phone over HomeNet.',
    severity: 'info',
    ...overrides,
  })
  const fresh = items().find((i) => !before.has(i.id))
  assert.ok(fresh, 'requestConsent did not put the consent in items()')
  return { promise, id: fresh.id, item: fresh }
}

// ------------------------------------------------------------------- wiring

test('register() wires every corner and network channel the contract declares', () => {
  for (const channel of Object.values(CH)) {
    assert.equal(typeof H.get(channel), 'function', `missing handler for ${channel}`)
  }
})

// ------------------------------------------------- consent: the happy paths

test('a consent is visible to the renderer the moment it is raised', () => {
  const { promise, item } = raise()
  assert.equal(item.kind, 'consent')
  assert.equal(typeof item.id, 'string')
  assert.ok(item.id.length >= 32, 'id should be a UUID, not a short random token')
  assert.equal(typeof item.at, 'number')
  assert.equal(item.title, 'Allow Write')

  dismiss(item.id)
  return promise
})

test('allow=true is the only thing that resolves a consent true', async () => {
  const { promise, id } = raise()
  decide({ id, allow: true })
  assert.equal(await settledWithin(promise, 500), true)
})

test('a decided consent leaves items() so it cannot be answered twice', async () => {
  const { promise, id } = raise()
  decide({ id, allow: true })
  await promise
  assert.equal(
    items().some((i) => i.id === id),
    false,
    'decided consent is still in items()',
  )
})

test('allow=false resolves false', async () => {
  const { promise, id } = raise()
  decide({ id, allow: false })
  assert.equal(await settledWithin(promise, 500), false)
})

// ------------------------------------------------- consent: the bypass hunt

test('truthy non-boolean allow values are denials, not permission', async () => {
  // An IPC payload is renderer-supplied. `if (decision.allow)` would treat
  // every one of these as consent.
  for (const allow of ['true', 1, 'yes', {}, [], 'allow', -1]) {
    const { promise, id } = raise()
    decide({ id, allow })
    assert.equal(
      await settledWithin(promise, 300),
      false,
      `allow=${JSON.stringify(allow)} must be a denial`,
    )
  }
})

test('an unanswered consent never resolves itself — there is no timeout', async () => {
  const { promise, id } = raise()
  const outcome = await settledWithin(promise, 600)
  assert.equal(
    outcome,
    PENDING,
    'the consent resolved without a human answer — a timeout path exists',
  )
  dismiss(id)
  assert.equal(await settledWithin(promise, 300), false)
})

test('dismiss denies, and does not hang the caller', async () => {
  const { promise, id } = raise()
  dismiss(id)
  const outcome = await settledWithin(promise, 500)
  assert.notEqual(outcome, PENDING, 'dismiss left the caller blocked forever')
  assert.equal(outcome, false, 'dismiss must mean deny')
})

test('a dismissed consent cannot be allowed after the fact', async () => {
  const { promise, id } = raise()
  dismiss(id)
  assert.equal(await promise, false)

  // The dismissed id must be gone from `pending`. If it lingered, this late
  // message would resolve it TRUE — an allow with no prompt on screen.
  assert.doesNotThrow(() => decide({ id, allow: true }))
  assert.equal(await promise, false, 'a late allow changed a dismissed decision')
  assert.equal(items().some((i) => i.id === id), false)
})

test('deciding one consent does not resolve another', async () => {
  const a = raise({ title: 'Allow A' })
  const b = raise({ title: 'Allow B' })
  assert.notEqual(a.id, b.id, 'two consents share an id — one answer decides both')

  decide({ id: a.id, allow: true })
  assert.equal(await settledWithin(a.promise, 500), true)
  assert.equal(
    await settledWithin(b.promise, 300),
    PENDING,
    'answering A also answered B',
  )

  decide({ id: b.id, allow: false })
  assert.equal(await settledWithin(b.promise, 500), false)
})

test('ids are unique across many consents', async () => {
  const raised = Array.from({ length: 200 }, () => raise())
  const ids = new Set(raised.map((r) => r.id))
  assert.equal(ids.size, raised.length, 'id collision — one answer would decide two calls')
  for (const r of raised) dismiss(r.id)
  await Promise.all(raised.map((r) => r.promise))
})

test('malformed decisions and unknown ids are ignored, not thrown or trusted', async () => {
  const { promise, id } = raise()

  for (const junk of [null, undefined, {}, { id: 123, allow: true }, { allow: true }, 'nope', 0]) {
    assert.doesNotThrow(() => decide(junk), `decide(${JSON.stringify(junk)}) threw`)
  }
  assert.doesNotThrow(() => decide({ id: 'no-such-id', allow: true }))
  assert.doesNotThrow(() => dismiss('no-such-id'))

  assert.equal(
    await settledWithin(promise, 300),
    PENDING,
    'junk traffic resolved a real consent',
  )
  dismiss(id)
  await promise
})

// ------------------------------------------------------------- artifacts

test('dismissing an artifact does not touch the file it points at', () => {
  const file = join(USER_DATA, 'artifact-under-test.md')
  writeFileSync(file, '# Real content on disk\n', 'utf8')

  corner.push({
    kind: 'artifact',
    id: 'artifact-under-test',
    title: 'Skill created',
    file,
    body: '# Real content on disk',
    keyPoints: ['one', 'two'],
    at: Date.now(),
  })
  assert.ok(items().some((i) => i.id === 'artifact-under-test'))

  dismiss('artifact-under-test')

  assert.equal(
    items().some((i) => i.id === 'artifact-under-test'),
    false,
    'dismiss did not remove the view',
  )
  assert.ok(existsSync(file), 'dismissing an artifact deleted the file on disk')
  assert.equal(readFileSync(file, 'utf8'), '# Real content on disk\n')
})

test('push() does not duplicate an item already tracked', () => {
  const item = {
    kind: 'notice',
    id: 'notice-dup',
    title: 'n',
    detail: 'd',
    at: Date.now(),
  }
  corner.push(item)
  corner.push(item)
  assert.equal(items().filter((i) => i.id === 'notice-dup').length, 1)
  dismiss('notice-dup')
})

// ------------------------------------------- corner: invariants in the source

test('corner.ts has no timer anywhere near the consent path', () => {
  assert.doesNotMatch(
    CORNER_CODE,
    /setTimeout|setInterval|setImmediate/,
    'a timer in the single consent surface is a consent that answers itself',
  )
})

test('corner.ts never hands `true` to a resolver except from a decision', () => {
  assert.doesNotMatch(CORNER_CODE, /resolver\(\s*true\s*\)/)
  assert.doesNotMatch(CORNER_CODE, /resolve\(\s*true\s*\)/)
  assert.doesNotMatch(CORNER_CODE, /catch\s*\(\s*\)\s*=>\s*true/)
  assert.doesNotMatch(CORNER_CODE, /\.catch\([^)]*=>\s*true\)/)
  // The one place a resolver may see true.
  assert.match(CORNER_CODE, /resolver\(\s*decision\.allow\s*===\s*true\s*\)/)
})

test('corner.ts ids come from crypto, never Math.random', () => {
  assert.match(CORNER_CODE, /randomUUID\(\)/)
  assert.doesNotMatch(CORNER_CODE, /Math\.random/)
})

test('corner.ts broadcasts to every window, not only the focused one', () => {
  // getFocusedWindow() is null whenever the app is in the background, which is
  // the normal state while an agent works — the prompt lands nowhere and the
  // tool call blocks with nothing on screen.
  assert.match(CORNER_CODE, /getAllWindows\(\)/)
  assert.doesNotMatch(CORNER_CODE, /getFocusedWindow/)
})

// ---------------------------------------------------- network: fail closed

const detected = await network.getCurrentNetwork()

test('detectNetwork returns the contract shape', () => {
  assert.ok(detected && typeof detected === 'object')
  assert.ok(detected.ssid === null || typeof detected.ssid === 'string')
  assert.ok(detected.fingerprint === null || typeof detected.fingerprint === 'string')
  assert.equal(typeof detected.trusted, 'boolean')
  assert.ok(['public', 'private', 'domain', 'unknown'].includes(detected.osProfile))
})

test('an empty trust store means untrusted, whatever the network and the OS say', () => {
  assert.equal(
    detected.trusted,
    false,
    `nothing has been trusted in this scratch profile, yet trusted=true (osProfile=${detected.osProfile})`,
  )
})

test('a fingerprint always carries its kind prefix', () => {
  if (detected.fingerprint === null) return
  assert.match(
    detected.fingerprint,
    /^(mac|ssid):/,
    'an unprefixed fingerprint shares one namespace between MAC and SSID',
  )
})

/** Replace the trust store and re-detect. */
async function withStore(trustedNetworks) {
  writeFileSync(TRUST_STORE, JSON.stringify({ trustedNetworks }), 'utf8')
  return network.getCurrentNetwork()
}

test('a corrupt trust store fails closed rather than throwing', async () => {
  writeFileSync(TRUST_STORE, '{ not json at all', 'utf8')
  const result = await network.getCurrentNetwork()
  assert.equal(result.trusted, false)
})

test('a trust store of the wrong shape fails closed', async () => {
  for (const junk of ['null', '[]', '"a string"', '{"trustedNetworks":"nope"}', '{}']) {
    writeFileSync(TRUST_STORE, junk, 'utf8')
    const result = await network.getCurrentNetwork()
    assert.equal(result.trusted, false, `store ${junk} produced trust`)
  }
})

test('a missing trust store fails closed', async () => {
  rmSync(TRUST_STORE, { force: true })
  const result = await network.getCurrentNetwork()
  assert.equal(result.trusted, false)
})

test('POSITIVE CONTROL: an exactly matching entry does grant trust', async (t) => {
  if (detected.fingerprint === null) {
    t.skip('no fingerprint obtainable here; the negative tests below cannot be checked for vacuity')
    return
  }
  const kind = detected.fingerprint.startsWith('mac:') ? 'mac' : 'ssid'
  const result = await withStore([
    { kind, fingerprint: detected.fingerprint, ssid: detected.ssid },
  ])
  if (result.fingerprint !== detected.fingerprint) {
    t.skip('network changed mid-suite')
    return
  }
  assert.equal(
    result.trusted,
    true,
    'a matching store entry did not grant trust — every negative test above is vacuous',
  )
})

test('an SSID entry can never satisfy a MAC fingerprint (the evil-twin hole)', async (t) => {
  if (detected.fingerprint === null) {
    t.skip('no fingerprint obtainable here')
    return
  }
  const kind = detected.fingerprint.startsWith('mac:') ? 'mac' : 'ssid'
  const other = kind === 'mac' ? 'ssid' : 'mac'
  const bare = detected.fingerprint.slice(detected.fingerprint.indexOf(':') + 1)

  const result = await withStore([
    // Same raw value, opposite kind. A cafe AP whose SSID is spelled like the
    // home gateway's MAC must not inherit that trust, and vice versa.
    { kind: other, fingerprint: `${other}:${bare}`, ssid: null },
    // Legacy unprefixed entry carrying the raw value.
    { kind, fingerprint: bare, ssid: null },
    // Prefix that disagrees with its own declared kind.
    { kind: other, fingerprint: detected.fingerprint, ssid: null },
  ])
  if (result.fingerprint !== detected.fingerprint) {
    t.skip('network changed mid-suite')
    return
  }
  assert.equal(
    result.trusted,
    false,
    'a cross-kind or unprefixed store entry granted trust',
  )
})

test('junk rows in the trust store are dropped, not partially honoured', async (t) => {
  if (detected.fingerprint === null) {
    t.skip('no fingerprint obtainable here')
    return
  }
  const result = await withStore([
    null,
    'a string',
    42,
    { kind: 'wifi', fingerprint: detected.fingerprint },
    { kind: 'mac' },
    { fingerprint: detected.fingerprint },
    { kind: 'mac', fingerprint: '' },
  ])
  if (result.fingerprint !== detected.fingerprint) {
    t.skip('network changed mid-suite')
    return
  }
  assert.equal(result.trusted, false)
})

test('trust round trip persists, and untrust removes it', async (t) => {
  rmSync(TRUST_STORE, { force: true })

  const trusted = await network.trustCurrentNetwork(true)
  if (trusted.fingerprint === null) {
    assert.equal(trusted.trusted, false, 'trusted an unfingerprintable network')
    assert.equal(existsSync(TRUST_STORE), false, 'wrote a store entry with no fingerprint')
    t.skip('no fingerprint obtainable here; round trip cannot be exercised')
    return
  }

  assert.equal(trusted.trusted, true)
  const onDisk = JSON.parse(readFileSync(TRUST_STORE, 'utf8'))
  assert.equal(onDisk.trustedNetworks.length, 1)
  const entry = onDisk.trustedNetworks[0]
  assert.match(entry.fingerprint, /^(mac|ssid):/)
  assert.equal(entry.fingerprint, `${entry.kind}:${entry.fingerprint.slice(entry.kind.length + 1)}`)
  assert.ok(entry.fingerprint.startsWith(`${entry.kind}:`))

  assert.equal(existsSync(`${TRUST_STORE}.tmp`) && readFileSync(TRUST_STORE, 'utf8') === '', false)

  const untrusted = await network.trustCurrentNetwork(false)
  assert.equal(untrusted.trusted, false)
  const after = JSON.parse(readFileSync(TRUST_STORE, 'utf8'))
  assert.equal(after.trustedNetworks.length, 0)

  const reread = await network.getCurrentNetwork()
  assert.equal(reread.trusted, false)
})

// --------------------------------------------- network: invariants in source

test('network.ts never shells out through a shell, and never builds a command string', () => {
  assert.doesNotMatch(NETWORK_CODE, /\bexecSync\b/)
  assert.doesNotMatch(NETWORK_CODE, /\bspawnSync\b/)
  assert.doesNotMatch(NETWORK_CODE, /\bexecFileSync\b/)
  // `exec(` / `exec` imported on its own runs through cmd.exe.
  assert.doesNotMatch(NETWORK_CODE, /[^A-Za-z]exec\s*\(/)
  assert.doesNotMatch(NETWORK_CODE, /shell\s*:\s*true/)

  const importLine = NETWORK_CODE.match(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/)
  assert.ok(importLine, 'expected a named import from node:child_process')
  const named = importLine[1].split(',').map((s) => s.trim()).filter(Boolean)
  assert.deepEqual(named, ['execFile'], `child_process imports beyond execFile: ${named}`)
})

test('nothing is interpolated into a child-process invocation', () => {
  // SSIDs are attacker-chosen strings pulled out of the air. They must reach a
  // subprocess only as a discrete argv element, never as part of a built
  // string — and no argument list may contain a template placeholder at all.
  for (const call of NETWORK_CODE.matchAll(/\brun\(([\s\S]*?)\n\s*\)/g)) {
    assert.doesNotMatch(call[1], /\$\{/, `interpolation inside run(): ${call[1]}`)
    assert.doesNotMatch(call[1], /`/, `template literal inside run(): ${call[1]}`)
  }
  for (const call of NETWORK_CODE.matchAll(/\brun\('[^']*',\s*\[[^\]]*\]\)/g)) {
    assert.doesNotMatch(call[0], /\$\{|`/, `interpolation inside run(): ${call[0]}`)
  }
  assert.ok(
    NETWORK_CODE.includes("run('arp', ['-a', gatewayIp])"),
    'the arp lookup should pass the gateway as its own argv element',
  )
  // And the value that does get passed is validated as a literal dotted quad.
  assert.match(NETWORK_CODE, /isIpv4\(/)
})

test('network detection does not block the main thread', () => {
  // A synchronous probe here freezes every window in the app: register()
  // exposes this on an IPC channel, so the renderer could hang the UI for the
  // full subprocess timeout just by asking. (The small synchronous fs calls on
  // the trust store are a different animal: a few KB of local JSON, not a
  // subprocess spawn behind a 5s timeout.)
  assert.doesNotMatch(NETWORK_CODE, /\b(execFileSync|execSync|spawnSync|fork)\s*\(/)
  assert.match(NETWORK_CODE, /promisify\(execFile\)/)
  assert.match(NETWORK_CODE, /async function run\(/)
  assert.match(NETWORK_CODE, /await execFileAsync\(/)
  assert.match(NETWORK_CODE, /timeout:\s*\d+/, 'subprocesses must have a timeout')
})

test('the OS public/private flag never feeds `trusted`', () => {
  for (const line of NETWORK_CODE.split('\n')) {
    if (/\btrusted\s*[:=]/.test(line) && /osProfile/.test(line)) {
      assert.fail(`osProfile appears in a trusted assignment: ${line.trim()}`)
    }
  }
  // trusted comes from the store and nowhere else.
  assert.match(NETWORK_CODE, /const trusted = fingerprint \? isFingerprinted\(fingerprint\) : false/)
})

test('the trust store is written atomically', () => {
  // writeFileSync truncates first, so a crash mid-write leaves a store that
  // parses as nothing. That direction fails closed, but it silently forgets
  // every trusted network.
  assert.match(NETWORK_CODE, /renameSync\(/)
  assert.doesNotMatch(
    NETWORK_CODE,
    /writeFileSync\(\s*trustStorePath/,
    'a direct write to the live store path is not atomic',
  )
})

test('the trust store is parsed as untrusted input', () => {
  // A cast is not validation. Every field is checked before it can grant trust.
  assert.doesNotMatch(NETWORK_CODE, /JSON\.parse\([^)]*\)\s*as\s+TrustStore/)
  assert.match(NETWORK_CODE, /const parsed: unknown = JSON\.parse/)
  assert.match(NETWORK_CODE, /catch\s*\{[\s\S]*?trustedNetworks:\s*\[\]/)
})

// ------------------------------------------------------ renderer invariants

const RENDERER = {
  'AgentCorner.tsx': AGENT_CORNER_CODE,
  'ArtifactItem.tsx': ARTIFACT_CODE,
  'ConsentItem.tsx': CONSENT_CODE,
}

test('the corner renderer never injects raw HTML', () => {
  // Artifact bodies and consent details are agent-generated.
  for (const [name, code] of Object.entries(RENDERER)) {
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/, `${name} injects raw HTML`)
    assert.doesNotMatch(code, /innerHTML/, `${name} injects raw HTML`)
  }
})

test('the corner renderer has no node or network access of its own', () => {
  for (const [name, code] of Object.entries(RENDERER)) {
    assert.doesNotMatch(code, /\brequire\s*\(/, `${name} uses require`)
    assert.doesNotMatch(code, /\bfetch\s*\(/, `${name} talks to the network directly`)
    assert.doesNotMatch(code, /from\s*'node:/, `${name} imports node builtins`)
    assert.doesNotMatch(code, /XMLHttpRequest|WebSocket/, `${name} opens its own transport`)
  }
})

test('no agent-supplied value ever reaches an href or src', () => {
  // will-navigate / will-frame-navigate in src/main/index.ts do NOT fire for a
  // `javascript:` URL — Chromium runs it as script in the current document. An
  // href built from an artifact field is therefore script execution in a page
  // that holds the whole window.api bridge, including corner.decide.
  for (const [name, code] of Object.entries(RENDERER)) {
    assert.doesNotMatch(code, /\bhref=\{/, `${name} builds an href from a value`)
    assert.doesNotMatch(code, /\bsrc=\{/, `${name} builds a src from a value`)
    assert.doesNotMatch(code, /window\.open|location\s*\.\s*(href|assign|replace)/, `${name} navigates`)
  }
  // The artifact path is still shown, just as text.
  assert.match(ARTIFACT_CODE, /\{item\.file\}/)
})

test('the artifact renders in full: body and key points, not a toast', () => {
  assert.match(ARTIFACT_CODE, /\{item\.body\}/)
  assert.match(ARTIFACT_CODE, /item\.keyPoints/)
})

test('a consent states what, to which device, over which network', () => {
  assert.match(CONSENT_CODE, /\{item\.title\}/)
  assert.match(CONSENT_CODE, /\{item\.detail\}/)
  assert.match(CONSENT_CODE, /item\.network/)
  assert.match(CONSENT_CODE, /network\.ssid/)
  assert.match(CONSENT_CODE, /network\.fingerprint/)
  assert.match(CONSENT_CODE, /network\.trusted/)
  // Both actions exist, so it is never an implicit yes.
  assert.match(CONSENT_CODE, /onAllow/)
  assert.match(CONSENT_CODE, /onDeny/)
})

test('the OS profile is labelled advisory where it is shown', () => {
  assert.match(CONSENT_SRC, /advisory/i)
})

test('the network warnings are structure and text, never colour', () => {
  // Our own determination gets a warning block, not just an inline label.
  assert.match(CONSENT_CODE, /!item\.network\.trusted/)
  assert.match(CONSENT_SRC, /not one you have trusted/i)
  assert.match(CONSENT_SRC, /public/i)

  // No inline colour anywhere in the corner renderer.
  for (const [name, code] of Object.entries(RENDERER)) {
    assert.doesNotMatch(code, /style=\{\{[^}]*color/i, `${name} sets colour inline`)
    assert.doesNotMatch(code, /#[0-9a-f]{3,8}\b/i, `${name} hard-codes a colour`)
  }

  // And no stylesheet rule makes the warning classes colour-only.
  for (const selector of [
    'network-warning',
    'consent-warn',
    'consent-info',
    'trust-untrusted',
    'trust-trusted',
  ]) {
    const block = BASE_CSS.match(new RegExp(`\\.${selector}\\b[^{]*\\{([^}]*)\\}`))
    if (!block) continue
    assert.doesNotMatch(
      block[1],
      /(^|[^-])color\s*:|background/i,
      `.${selector} is signalled with colour; the palette has no semantic warning colour`,
    )
  }
})

test('the corner subscribes once and unsubscribes on unmount', () => {
  // Without the teardown, remounting the pane stacks handlers and one consent
  // renders N times.
  assert.match(AGENT_CORNER_CODE, /unsubscribePush\(\)/)
  assert.match(AGENT_CORNER_CODE, /unsubscribeResolved\(\)/)
  assert.match(AGENT_CORNER_CODE, /\}, \[\]\)/, 'the subscription effect must have an empty dep array')
})

test('the corner never decides on the human behalf', () => {
  // decide() may only be called from the allow/deny handlers.
  const decideCalls = [...AGENT_CORNER_CODE.matchAll(/corner\.decide\(/g)]
  assert.equal(decideCalls.length, 1, 'more than one path calls corner.decide')
  assert.doesNotMatch(AGENT_CORNER_CODE, /setTimeout|setInterval/)
  assert.doesNotMatch(AGENT_CORNER_CODE, /allow:\s*true/, 'a hard-coded allow in the renderer')
})

test('what is on screen is derived from items, not a second copy of the truth', () => {
  // The queue used to be its own useState plus a useRef, updated by calling
  // setDisplayQueue from inside the setItems updater. React updaters must be
  // pure — StrictMode invokes them twice — and three copies of one fact on the
  // consent surface can disagree about which prompt the human is answering.
  const states = [...AGENT_CORNER_CODE.matchAll(/useState[<(]/g)]
  assert.equal(states.length, 1, 'more than one piece of state in the corner')
  assert.doesNotMatch(AGENT_CORNER_CODE, /setDisplayQueue/)
  assert.doesNotMatch(AGENT_CORNER_CODE, /useRef/)
  assert.match(AGENT_CORNER_CODE, /const displayQueue = nextToShow\(items\)/)
})
