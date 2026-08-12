/**
 * SECTION 4 REVIEW — process boundary and app-wide security posture.
 *
 * These drive the REAL modules: src/main/vault.ts, src/main/ipc.ts and
 * src/main/index.ts are imported directly. `./fixtures/ts-hooks.mjs` rewrites
 * the NodeNext `./foo.js` specifiers to `./foo.ts` and redirects `electron` to
 * the stub, so the bodies executed here are the files that ship. Nothing below
 * tests a copy.
 *
 * The mock vault server is `./helpers.mjs` — the same one section4 uses, with
 * its opt-in knobs. In particular `pythonGuard` replicates server.py's ACTUAL
 * /save lost-update guard rather than the stricter default, because the gap
 * between those two IS the bug this suite exists to pin down.
 */
import './fixtures/ts-hooks.mjs'

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// claude.ts / network.ts persist under app.getPath('userData'); keep that in a
// scratch directory rather than the real one.
process.env.TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'aw-s4-'))

import * as vault from '../src/main/vault.ts'

// ---------------------------------------------------------------------------
// A. THE LOST-UPDATE GUARD  (the live data-loss bug, and its fix)
//
// server.py:703-708
//     if p.exists() and data.get("mtime") is not None:
//         cur = p.stat().st_mtime_ns
//         if int(data["mtime"]) != cur:  -> 409 {"error": ..., "mtime": cur}
//
// The guard runs only when the request carries a NON-NULL mtime, so its default
// is fail-open: send nothing and the check is skipped and the note is
// overwritten whole-file. Three renderer-supplied values reach that state,
// because JSON.stringify erases them before they ever leave this process:
//
//   value      | on the wire         | server sees | outcome
//   -----------|---------------------|-------------|-------------------------
//   0          | "mtime":0           | 0           | guard RUNS -> 409 forever
//   undefined  | key dropped         | None        | guard SKIPPED -> CLOBBER
//   NaN        | "mtime":null        | None        | guard SKIPPED -> CLOBBER
//   null       | "mtime":null        | None        | guard SKIPPED -> CLOBBER
//   valid ns   | "mtime":1755...     | int         | guard RUNS -> correct
//
// The `mtime: number` annotations on ipc.ts:53 and vault.save() are erased at
// runtime and stopped none of this. requireMtime() in vault.ts is the fix; the
// three None-producing inputs must now be refused BEFORE any request is sent.
// ---------------------------------------------------------------------------

test('lost-update guard: mtime is validated before anything is written', async (t) => {
  const saveBodies = []
  const mock = await startPythonish({ 'Home.md': { text: 'disk', mtime: 5_000 } }, {
    saveBodies,
  })
  vault._setBaseForTest(mock.url)

  const reset = () => {
    mock.state.notes['Home.md'] = { text: 'disk', mtime: 5_000 }
    saveBodies.length = 0
  }

  // The three that made the server skip its guard. Each must be refused here,
  // and must not reach the server at all.
  for (const [label, value] of [
    ['undefined (argument omitted over IPC)', undefined],
    ['null', null],
    ['NaN', Number('not a number')],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '5000'],
    ['an object', {}],
  ]) {
    await t.test(`refuses ${label} without writing`, async () => {
      reset()
      await assert.rejects(
        () => vault.save('Home.md', 'would have clobbered', value),
        (e) => e.message === 'vault: mtime must be a finite number',
      )
      assert.equal(saveBodies.length, 0, 'no request should have been sent')
      assert.equal(
        mock.state.notes['Home.md'].text,
        'disk',
        'the note must be untouched',
      )
    })
  }

  await t.test('an omitted argument is refused, not silently defaulted', async () => {
    reset()
    // Exactly what `window.api.vault.save(p, t)` produces once the erased
    // TypeScript signature is out of the picture.
    await assert.rejects(
      () => vault.save('Home.md', 'two args only'),
      (e) => e.message === 'vault: mtime must be a finite number',
    )
    assert.equal(saveBodies.length, 0)
    assert.equal(mock.state.notes['Home.md'].text, 'disk')
  })

  await t.test('0 is allowed through, and the server guard rejects it (409)', async () => {
    reset()
    await assert.rejects(
      () => vault.save('Home.md', 'from a stale buffer', 0),
      (e) => e instanceof vault.SaveConflict && e.currentMtime === 5_000,
    )
    const sent = JSON.parse(saveBodies.at(-1))
    assert.ok('mtime' in sent, 'the key must survive JSON.stringify')
    assert.equal(sent.mtime, 0)
    assert.equal(mock.state.notes['Home.md'].text, 'disk', 'noisy, never lossy')
  })

  await t.test('a valid mtime still saves, and the guard ran', async () => {
    reset()
    const r = await vault.save('Home.md', 'legitimate edit', 5_000)
    const sent = JSON.parse(saveBodies.at(-1))
    assert.equal(sent.mtime, 5_000)
    assert.equal(mock.state.notes['Home.md'].text, 'legitimate edit')
    assert.ok(r.mtime > 0)
    assert.equal(r.path, 'Home.md')
    assert.equal(r.title, 'Home')
  })

  await t.test('a stale-but-valid mtime is a SaveConflict carrying the disk value', async () => {
    reset()
    await assert.rejects(
      () => vault.save('Home.md', 'stale', 4_999),
      (e) => e instanceof vault.SaveConflict && e.currentMtime === 5_000,
    )
    assert.equal(mock.state.notes['Home.md'].text, 'disk')
  })

  await mock.close()
})

test('list() rows carry mtime 0 and are not a version', async () => {
  const mock = await startPythonish({ 'Home.md': { text: 'disk', mtime: 5_000 } })
  vault._setBaseForTest(mock.url)

  // GET /notes carries no mtime (server.py:392-399 builds the row without one)
  // and vault.ts defaults it to 0. LATENT, not live: no current caller routes a
  // list row into save(). If one ever does, it 409s forever rather than losing
  // data — which is why 0 is left permitted by requireMtime().
  const [row] = await vault.list()
  assert.equal(row.mtime, 0)
  await assert.rejects(
    () => vault.save(row.path, 'text', row.mtime),
    (e) => e instanceof vault.SaveConflict,
  )
  assert.equal(mock.state.notes['Home.md'].text, 'disk')

  await mock.close()
})

test('the IPC handler does not launder an invalid mtime on its way through', async () => {
  // ipc.ts:53 annotates `m: number` and that annotation is erased. The guard
  // has to hold when the value arrives through the real registered handler,
  // not just when vault.save is called directly.
  const { registeredHandlers } = await import('./fixtures/electron-stub.mjs')
  const { CH } = await import('../src/shared/ipc.ts')
  const { registerIpc } = await import('../src/main/ipc.ts')

  const saveBodies = []
  const mock = await startPythonish({ 'Home.md': { text: 'disk', mtime: 5_000 } }, {
    saveBodies,
  })
  vault._setBaseForTest(mock.url)
  registerIpc()

  const call = registeredHandlers.get(CH.vaultSave)
  const topFrame = { senderFrame: { parent: null } }

  for (const args of [
    ['Home.md', 'clobber'], // mtime argument simply absent
    ['Home.md', 'clobber', null],
    ['Home.md', 'clobber', Number('x')],
    ['Home.md', 'clobber', '5000'],
  ]) {
    await assert.rejects(
      () => call(topFrame, ...args),
      (e) => e.message === 'vault: mtime must be a finite number',
      `handler accepted ${JSON.stringify(args[2] ?? null)}`,
    )
  }
  assert.equal(saveBodies.length, 0)
  assert.equal(mock.state.notes['Home.md'].text, 'disk')

  await mock.close()
})

// ---------------------------------------------------------------------------
// B. 409 WITHOUT AN MTIME
//
// server.py:715-716 turns a FileExistsError into a 409 whose body carries only
// `error`. vault.ts:85 requires `typeof o.mtime === 'number'` before building a
// SaveConflict, so that one must surface as an ordinary Error — a SaveConflict
// with an undefined mtime would drive the renderer's conflict dialog into
// re-saving against garbage.
// ---------------------------------------------------------------------------

test('a 409 with no mtime is a plain Error, never a SaveConflict', async (t) => {
  const mock = await startPythonish({ 'Home.md': { text: 'disk', mtime: 5_000 } })
  vault._setBaseForTest(mock.url)

  await t.test('mtime absent', async () => {
    mock.state.respond = ({ method }) =>
      method === 'POST' ? { status: 409, body: { error: 'note already exists' } } : null
    await assert.rejects(
      () => vault.save('Home.md', 'x', 5_000),
      (e) =>
        e instanceof Error &&
        !(e instanceof vault.SaveConflict) &&
        e.message === 'note already exists',
    )
  })

  await t.test('mtime present but not a number', async () => {
    mock.state.respond = ({ method }) =>
      method === 'POST'
        ? { status: 409, body: { error: 'weird', mtime: '5000' } }
        : null
    await assert.rejects(
      () => vault.save('Home.md', 'x', 5_000),
      (e) => e instanceof Error && !(e instanceof vault.SaveConflict),
    )
  })

  mock.state.respond = null
  await mock.close()
})

// ---------------------------------------------------------------------------
// C. PATH HANDLING
//
// Our layer deliberately does NOT sanitise paths; server.py's safe() is the
// only guard. These pin that down: the exact bytes the caller supplied must
// arrive at the server unchanged and undecoded twice, because safe() is what
// has to see them.
// ---------------------------------------------------------------------------

test('paths reach the server verbatim; safe() is the only guard', async (t) => {
  const seen = []
  const mock = await startPythonish(
    {
      'Home.md': { text: 'ok', mtime: 1 },
      // Keyed by the literal traversal string. If it is readable, our layer
      // forwarded the escape untouched — which is correct, and exactly why
      // server.py's safe() must never be removed.
      '../../escaped.md': { text: 'outside', mtime: 2 },
      '..%2f..%2fencoded.md': { text: 'literal percent', mtime: 3 },
    },
    {
      respond: ({ method, url, path }) => {
        if (method === 'GET' && path.startsWith('/note') && path !== '/notes') {
          seen.push(url.searchParams.get('path'))
        }
        return null
      },
    },
  )
  vault._setBaseForTest(mock.url)

  await t.test('relative traversal is forwarded unmodified', async () => {
    const n = await vault.read('../../escaped.md')
    assert.equal(n.text, 'outside')
    assert.equal(seen.at(-1), '../../escaped.md')
  })

  await t.test('percent-encoded traversal is NOT double-decoded', async () => {
    const n = await vault.read('..%2f..%2fencoded.md')
    assert.equal(n.text, 'literal percent')
    // encodeURIComponent escaped the '%' to '%25', so the server's single
    // unquote yields the literal string back — not '../../encoded.md'.
    assert.equal(seen.at(-1), '..%2f..%2fencoded.md')
    assert.notEqual(seen.at(-1), '../../encoded.md')
  })

  await t.test('a query-injection attempt stays inside the path parameter', async () => {
    await assert.rejects(() => vault.read('Home.md&path=Other.md'))
    assert.equal(seen.at(-1), 'Home.md&path=Other.md')
  })

  await t.test('an absolute Windows path is forwarded for safe() to reject', async () => {
    await assert.rejects(() => vault.read('C:/Windows/win.ini'))
    assert.equal(seen.at(-1), 'C:/Windows/win.ini')
  })

  await t.test('requirePath refuses empty and non-string before any request', async () => {
    const before = seen.length
    for (const bad of ['', null, undefined, 42, {}, []]) {
      await assert.rejects(
        () => vault.read(bad),
        (e) => e.message === 'vault: path must be a non-empty string',
      )
      await assert.rejects(
        () => vault.save(bad, 'text', 1),
        (e) => e.message === 'vault: path must be a non-empty string',
      )
    }
    assert.equal(seen.length, before, 'nothing should have reached the server')
  })

  await mock.close()
})

// ---------------------------------------------------------------------------
// D. ERROR LEAKAGE ACROSS THE BOUNDARY
// ---------------------------------------------------------------------------

test('scrub() keeps absolute paths out of renderer-visible errors', async (t) => {
  const mock = await startPythonish({})
  vault._setBaseForTest(mock.url)

  await t.test('Windows drive path is removed', async () => {
    mock.state.respond = () => ({
      status: 400,
      body: {
        error:
          "[Errno 2] No such file or directory: 'C:\\\\Users\\\\Nathan\\\\Desktop\\\\Universal Vault\\\\Home.md'",
      },
    })
    await assert.rejects(
      () => vault.read('Home.md'),
      (e) => {
        assert.ok(!/Nathan/.test(e.message), `username leaked: ${e.message}`)
        assert.match(e.message, /<path>/)
        assert.match(e.message, /No such file or directory/)
        return true
      },
    )
  })

  await t.test('UNC path is removed', async () => {
    mock.state.respond = () => ({
      status: 400,
      body: { error: 'cannot open \\\\NAS\\vault\\Home.md' },
    })
    await assert.rejects(
      () => vault.read('Home.md'),
      (e) => !/NAS/.test(e.message) && /<path>/.test(e.message),
    )
  })

  await t.test('a status-only failure still produces a usable message', async () => {
    mock.state.respond = () => ({ status: 500, body: {} })
    await assert.rejects(
      () => vault.read('Home.md'),
      (e) => e.message === '500 /note?path=Home.md',
    )
  })

  mock.state.respond = null
  await mock.close()
})

// ---------------------------------------------------------------------------
// E. HOSTILE CONTENT
//
// Note titles and paths are attacker-influenced in the threat model this app
// assumes (anything an agent writes into the vault). Nothing here may pollute
// a prototype or crash the tree/graph builders.
// ---------------------------------------------------------------------------

test('hostile titles and paths do not break or pollute anything', async () => {
  const mock = await startPythonish({
    'Home.md': { text: 'plain', mtime: 1 },
    '__proto__.md': { text: '[[Home]]', mtime: 2 },
    '__proto__/constructor/prototype.md': { text: '[[__proto__]]', mtime: 3 },
    'Regex (.*)+$ [meta].md': { text: '[[Home]]', mtime: 4 },
    '<script>alert(1)</script>.md': { text: '[[Home]]', mtime: 5 },
    'Unicode \u202Egnp.md': { text: '[[Home]]', mtime: 6 },
  })
  vault._setBaseForTest(mock.url)

  const notes = await vault.list()
  assert.equal(notes.length, 6)

  // tree() reads real dirents now, so it is exercised against a scratch dir.
  // The names here are the ones that are BOTH adversarial and legal on Windows
  // — `<script>`, `*`, `?` and friends cannot exist as filenames at all, so the
  // OS already forecloses them; prototype-pollution keys do not.
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const scratch = await mkdtemp(join(tmpdir(), 'vault-hostile-'))
  // NB: `Regex (.*)+$ [meta].md` was tried here and is impossible — `*` is not
  // a legal Windows filename character, so the OS refuses it before any of our
  // code runs. That is the boundary this test is documenting.
  const hostile = [
    '__proto__.md',
    '__proto__/constructor/prototype.md',
    'constructor.md',
    'Regex (dot-star)+$ [meta].md',
  ]
  for (const rel of hostile) {
    await mkdir(join(scratch, rel, '..'), { recursive: true })
    await writeFile(join(scratch, rel), '# x\n', 'utf-8')
  }
  vault._setVaultDirForTest(scratch)

  const root = await vault.tree()
  const paths = []
  ;(function walk(n) {
    if (n.kind === 'note') paths.push(n.path)
    n.children?.forEach(walk)
  })(root)
  assert.equal(paths.length, hostile.length, 'every note survives tree()')
  assert.ok(paths.includes('__proto__/constructor/prototype.md'))
  // The tree is built from plain objects; a `__proto__` path segment must not
  // have reached Object.prototype on the way through.
  assert.equal({}.polluted, undefined, 'Object.prototype polluted by tree()')

  const g = await vault.graph()
  assert.equal(g.nodes.length, 6)
  // '[[__proto__]]' must resolve through the title Map, not Object.prototype.
  assert.ok(
    g.links.some(
      (l) => l.from === '__proto__/constructor/prototype.md' && l.to === '__proto__.md',
    ),
  )

  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.kind, undefined)
  assert.equal(Object.prototype.children, undefined)
  assert.equal(Array.prototype.name, undefined)

  await mock.close()
})

// ---------------------------------------------------------------------------
// F. LARGE RESPONSES
// ---------------------------------------------------------------------------

test('a multi-megabyte note round-trips intact', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024)
  const mock = await startPythonish({ 'Big.md': { text: big, mtime: 1 } })
  vault._setBaseForTest(mock.url)

  const n = await vault.read('Big.md')
  assert.equal(n.text.length, big.length)
  assert.equal(n.text, big)

  await mock.close()
})

// ---------------------------------------------------------------------------
// G. UNREADABLE AND ABSENT RESPONSES
// ---------------------------------------------------------------------------

test('a 2xx body that will not parse throws instead of becoming {}', async () => {
  const mock = await startPythonish({ 'Home.md': { text: 'ok', mtime: 1 } })
  vault._setBaseForTest(mock.url)

  mock.state.respond = () => ({ status: 200, body: '<html>not json</html>' })
  await assert.rejects(
    () => vault.read('Home.md'),
    (e) => /unreadable response/.test(e.message),
  )

  mock.state.respond = null
  await mock.close()
})

test('a server that accepts the connection and never answers times out', async () => {
  // vault.ts uses AbortSignal.timeout(15_000); this test therefore takes ~15s.
  // It is the only way to prove the timeout exists rather than assuming it.
  const mock = await startPythonish({}, { respond: () => 'hang' })
  vault._setBaseForTest(mock.url)

  const started = Date.now()
  await assert.rejects(
    () => vault.list(),
    (e) => e instanceof vault.VaultUnavailable,
  )
  const took = Date.now() - started
  assert.ok(took >= 14_000, `should have waited for the timeout, waited ${took}ms`)
  assert.ok(took < 30_000, `timeout should have fired by now, waited ${took}ms`)

  mock.state.respond = null
  await mock.close()
})

// ---------------------------------------------------------------------------
// H. graph() CONCURRENCY POOL
// ---------------------------------------------------------------------------

test('graph() reads every note exactly once, bounded to 8 in flight', async () => {
  const notes = { 'Home.md': { text: 'hub', mtime: 1 } }
  for (let i = 0; i < 24; i++) {
    notes[`N${i}.md`] = { text: '[[Home]] and [[Home]] again', mtime: i + 2 }
  }
  const reads = []
  const mock = await startPythonish(notes, { inflight: 0, noteDelayMs: 5, reads })
  vault._setBaseForTest(mock.url)

  const g = await vault.graph()

  assert.equal(g.nodes.length, 25)
  assert.ok(mock.state.peak <= 8, `peak in-flight was ${mock.state.peak}, expected <= 8`)
  assert.ok(mock.state.peak > 1, `pool never overlapped (peak ${mock.state.peak})`)

  // Exactly-once is now measured at the WIRE, not inferred from how many edges
  // came back. It used to be inferred: two [[Home]] links per note produced two
  // identical edges, and a note read twice produced four, so the edge count was
  // the signal. graph() dedups edges by resolved target — one note linking one
  // target is one relationship however many times it says so — which silently
  // destroyed that signal. Counting the GET /note requests tests the property
  // the name claims and cannot be fooled by a change to edge semantics.
  assert.equal(reads.length, 25, `expected 25 note reads, got ${reads.length}`)
  assert.equal(new Set(reads).size, 25, 'a note was read more than once')

  // Two [[Home]] mentions per note collapse to one edge each.
  assert.equal(g.links.length, 24)
  const sources = new Set(g.links.map((l) => l.from))
  assert.equal(sources.size, 24, 'every linking note contributed')

  await mock.close()
})

test('graph() emits one edge per relationship, not per mention', async () => {
  const mock = await startPythonish({
    'Home.md': { text: 'hub', mtime: 1 },
    // Same target named three different ways, plus a plain repeat. All four are
    // ONE relationship. Before the dedup a note repeating a link 20 000 times
    // produced 20 000 edges, and GraphView sizes nodes by endpoint count.
    'A.md': { text: '[[Home]] [[Home]] [[home]] [[Home.md]]', mtime: 2 },
  })
  vault._setBaseForTest(mock.url)

  const g = await vault.graph()
  assert.deepEqual(g.links, [{ from: 'A.md', to: 'Home.md' }])

  await mock.close()
})

test('graph() ignores an unterminated [[', async () => {
  const mock = await startPythonish({
    'Home.md': { text: 'hub', mtime: 1 },
    // A note documenting the syntax. The old link regex had no closing `]]`, so
    // this drew an edge the editor's Links list never showed.
    'Doc.md': { text: 'write a link as [[Home and close it with brackets', mtime: 2 },
  })
  vault._setBaseForTest(mock.url)

  const g = await vault.graph()
  assert.deepEqual(g.links, [])

  await mock.close()
})

test('graph() memo is shared by concurrent callers and dropped by save()', async () => {
  const reads = []
  const mock = await startPythonish(
    { 'Home.md': { text: '[[Home]]', mtime: 1 }, 'A.md': { text: '[[Home]]', mtime: 2 } },
    { reads },
  )
  vault._setBaseForTest(mock.url)

  // Overlapping callers (the graph tab and a backlinks lookup) share one scan.
  await Promise.all([vault.graph(), vault.graph(), vault.backlinks('Home.md')])
  assert.equal(reads.length, 2, `overlapping calls rescanned: ${reads.length} reads`)

  // A later call inside the TTL is served from the memo.
  await vault.graph()
  assert.equal(reads.length, 2, 'a cached call went back to the server')

  // Our own write invalidates it immediately — no waiting out the TTL.
  await vault.save('A.md', '[[Home]] changed', mock.state.notes['A.md'].mtime)
  await vault.graph()
  assert.equal(reads.length, 4, 'save() did not invalidate the graph memo')

  await mock.close()
})

test('graph() on an empty vault resolves rather than deadlocking', async () => {
  const mock = await startPythonish({})
  vault._setBaseForTest(mock.url)
  // Math.min(LIMIT, 0) spawns zero workers; Promise.all([]) must still settle.
  const g = await vault.graph()
  assert.deepEqual(g, { nodes: [], links: [] })
  await mock.close()
})

test('graph() survives notes that fail to read', async () => {
  const mock = await startPythonish({
    'Home.md': { text: 'hub', mtime: 1 },
    'A.md': { text: '[[Home]]', mtime: 2 },
    'B.md': { text: '[[Home]]', mtime: 3 },
  })
  vault._setBaseForTest(mock.url)
  mock.state.respond = ({ method, url, path }) =>
    method === 'GET' && path.startsWith('/note') && url.searchParams.get('path') === 'A.md'
      ? { status: 500, body: { error: 'boom' } }
      : null

  const g = await vault.graph()
  assert.equal(g.nodes.length, 3)
  assert.ok(g.links.some((l) => l.from === 'B.md'))
  assert.ok(!g.links.some((l) => l.from === 'A.md'))

  mock.state.respond = null
  await mock.close()
})

// ---------------------------------------------------------------------------
// I. THE IPC BOUNDARY ITSELF
//
// Invokes the REAL wrapper src/main/ipc.ts installed, through the recording
// stub, with synthetic IpcMainInvokeEvents shaped like Electron 33's:
//   senderFrame: WebFrameMain | null   (electron.d.ts:8300)
//   parent:      WebFrameMain | null   (electron.d.ts:17274, null on the top frame)
// ---------------------------------------------------------------------------

test('ipc handlers refuse anything that is not the top frame', async (t) => {
  const { registeredHandlers } = await import('./fixtures/electron-stub.mjs')
  const { CH } = await import('../src/shared/ipc.ts')
  const { registerIpc } = await import('../src/main/ipc.ts')

  const mock = await startPythonish({ 'Home.md': { text: 'ok', mtime: 1 } })
  vault._setBaseForTest(mock.url)

  registerIpc()
  const call = registeredHandlers.get(CH.vaultList)
  assert.equal(typeof call, 'function', 'vault:list handler must be registered')

  await t.test('the legitimate top frame is allowed through', async () => {
    const rows = await call({ senderFrame: { parent: null } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].path, 'Home.md')
  })

  await t.test('a nested frame is refused', async () => {
    await assert.rejects(
      () => call({ senderFrame: { parent: { parent: null } } }),
      (e) => e.message === 'ipc: refused call from a subframe',
    )
  })

  await t.test('a null senderFrame fails CLOSED', async () => {
    // The regression this guards: `e.senderFrame?.parent != null` evaluated to
    // `undefined != null` === false here, i.e. "top frame, allow".
    await assert.rejects(
      () => call({ senderFrame: null }),
      (e) => e.message === 'ipc: refused call from a subframe',
    )
    await assert.rejects(
      () => call({}),
      (e) => e.message === 'ipc: refused call from a subframe',
    )
  })

  await t.test('a frame destroyed mid-check is refused, not crashed on', async () => {
    const e = {
      get senderFrame() {
        throw new Error('Object has been destroyed')
      },
    }
    await assert.rejects(
      () => call(e),
      (err) => err.message === 'ipc: refused call from a subframe',
    )
    const throwingParent = {
      senderFrame: {
        get parent() {
          throw new Error('Object has been destroyed')
        },
      },
    }
    await assert.rejects(
      () => call(throwingParent),
      (err) => err.message === 'ipc: refused call from a subframe',
    )
  })

  await t.test('every vault channel is wrapped, not just the first', async () => {
    for (const ch of [
      CH.vaultTree,
      CH.vaultList,
      CH.vaultRead,
      CH.vaultSave,
      CH.vaultGraph,
      CH.vaultBacklinks,
    ]) {
      const fn = registeredHandlers.get(ch)
      assert.equal(typeof fn, 'function', `${ch} not registered`)
      await assert.rejects(
        () => fn({ senderFrame: { parent: {} } }, 'Home.md', 'text', 1),
        (e) => e.message === 'ipc: refused call from a subframe',
        `${ch} let a subframe through`,
      )
    }
  })

  await mock.close()
})

// ---------------------------------------------------------------------------
// J. shell.openExternal GATE
// ---------------------------------------------------------------------------

test('isExternallyOpenable admits http(s) and nothing else', async () => {
  const { isExternallyOpenable } = await import('../src/main/index.ts')

  for (const ok of [
    'http://example.com',
    'https://example.com/a?b=c#d',
    'HTTPS://EXAMPLE.COM',
    'https://127.0.0.1:8765/notes',
  ]) {
    assert.equal(isExternallyOpenable(ok), true, ok)
  }

  for (const bad of [
    'javascript:alert(1)',
    // The case a regex loses: it contains the literal text "http://".
    'javascript:/*http://x*/alert(1)',
    'file:///C:/Windows/System32/calc.exe',
    'smb://attacker/share/payload.exe',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ms-msdt:/id',
    'about:blank',
    'ftp://example.com/x',
    'not a url at all',
    '',
    '//example.com',
    null,
    undefined,
    42,
    {},
    ['https://example.com'],
  ]) {
    assert.equal(isExternallyOpenable(bad), false, String(bad))
  }
})

// ---------------------------------------------------------------------------
// helper: the shared mock, wired to server.py's real /save semantics
// ---------------------------------------------------------------------------

async function startPythonish(notes, extra = {}) {
  const { startMockVault } = await import('./helpers.mjs')
  const state = { notes, pythonGuard: true, ...extra }
  const mock = await startMockVault(state)
  return { ...mock, state }
}
