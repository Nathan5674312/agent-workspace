/**
 * SECTION 4 REVIEW — process boundary and app-wide security posture.
 *
 * These drive the REAL modules: src/main/vault.ts, src/main/ipc.ts and
 * src/main/index.ts are imported directly. `./fixtures/ts-hooks.mjs` rewrites
 * the NodeNext `./foo.js` specifiers to `./foo.ts` and redirects `electron` to
 * the stub, so the bodies executed here are the files that ship. Nothing below
 * tests a copy.
 *
 * There is no mock vault server any more. `read()` and `save()` were the last
 * two calls behind note-system's HTTP API and they read and write the vault
 * directory directly now, so every fixture here is a real scratch vault and
 * every assertion about what was or was not written is made against the file.
 * The guards that used to live on the far side of the wire — server.py's
 * lost-update check and its `safe()` path containment — are asserted here
 * because this process is the only place left that can hold them.
 */
import './fixtures/ts-hooks.mjs'

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// claude.ts / network.ts persist under app.getPath('userData'); keep that in a
// scratch directory rather than the real one.
process.env.TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'aw-s4-'))

import * as vault from '../src/main/vault.ts'

/**
 * A vault on disk. EVERY test in this file needs one now — read() and save()
 * included, which used to be answered by a mock HTTP server.
 *
 * Call it before anything that touches the vault. A test that skips it leaves
 * VAULT_DIR pointing at whatever scratch directory ran last, or — on the first
 * such test — at the REAL Universal Vault. That is how these once went from
 * milliseconds to hundreds of milliseconds each and asserted against the user's
 * actual notes, and it is a good deal worse now that save() writes.
 */
async function scratchVault(notes) {
  const dir = await mkdtemp(join(tmpdir(), 'aw-s4-vault-'))
  for (const [rel, text] of Object.entries(notes)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, text, 'utf-8')
  }
  vault._setVaultDirForTest(dir)
  return dir
}

// ---------------------------------------------------------------------------
// A. THE LOST-UPDATE GUARD  (the live data-loss bug, and its fix)
//
// The guard used to live in server.py:703-708:
//
//     if p.exists() and data.get("mtime") is not None:
//         cur = p.stat().st_mtime_ns
//         if int(data["mtime"]) != cur:  -> 409 {"error": ..., "mtime": cur}
//
// It ran ONLY when the request carried a non-null mtime, so its default was
// fail-open: send nothing and the check was skipped and the note was
// overwritten whole-file. Three renderer-supplied values reached that state,
// because JSON.stringify erased them before they left this process:
//
//   value      | on the wire         | server saw  | outcome
//   -----------|---------------------|-------------|-------------------------
//   0          | "mtime":0           | 0           | guard RUNS -> 409 forever
//   undefined  | key dropped         | None        | guard SKIPPED -> CLOBBER
//   NaN        | "mtime":null        | None        | guard SKIPPED -> CLOBBER
//   null       | "mtime":null        | None        | guard SKIPPED -> CLOBBER
//
// The guard is vault.save()'s own now, comparing the caller's stamp against a
// fresh `statSync().mtimeMs`, and it cannot fail that way: a non-number is
// unequal to every mtime on disk, so the default outcome is a refusal. The
// `mtime: number` annotations on ipc.ts:53 and vault.save() are still erased at
// runtime and still stop nothing, so requireMtime() still rejects junk at the
// boundary — with the message the user can act on, and before the file is
// touched. Both halves are asserted below, against the file itself.
// ---------------------------------------------------------------------------

test('lost-update guard: mtime is validated before anything is written', async (t) => {
  const dir = await scratchVault({ 'Home.md': 'disk' })
  const home = join(dir, 'Home.md')
  const reset = () => writeFile(home, 'disk', 'utf-8')
  const untouched = async (before) => {
    assert.equal(await readFile(home, 'utf-8'), 'disk', 'the note must be untouched')
    assert.equal(
      (await stat(home)).mtimeMs,
      before,
      'the file was rewritten with identical bytes — still a write',
    )
  }

  // The three that made the server skip its guard, plus the shapes a renderer
  // can send once the erased type annotation is out of the picture.
  for (const [label, value] of [
    ['undefined (argument omitted over IPC)', undefined],
    ['null', null],
    ['NaN', Number('not a number')],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '5000'],
    ['an object', {}],
  ]) {
    await t.test(`refuses ${label} without writing`, async () => {
      await reset()
      const before = (await stat(home)).mtimeMs
      await assert.rejects(
        () => vault.save('Home.md', 'would have clobbered', value),
        (e) => e.message === 'vault: mtime must be a finite number',
      )
      await untouched(before)
    })
  }

  await t.test('an omitted argument is refused, not silently defaulted', async () => {
    await reset()
    const before = (await stat(home)).mtimeMs
    // Exactly what `window.api.vault.save(p, t)` produces.
    await assert.rejects(
      () => vault.save('Home.md', 'two args only'),
      (e) => e.message === 'vault: mtime must be a finite number',
    )
    await untouched(before)
  })

  await t.test('0 is allowed through, and the guard rejects it on a file that exists', async () => {
    await reset()
    const before = (await stat(home)).mtimeMs
    await assert.rejects(
      () => vault.save('Home.md', 'from a stale buffer', 0),
      (e) => e instanceof vault.SaveConflict && e.currentMtime === before,
    )
    await untouched(before)
  })

  await t.test('a valid mtime saves, and its stamp is the file it just wrote', async () => {
    await reset()
    const before = (await stat(home)).mtimeMs
    const r = await vault.save('Home.md', 'legitimate edit', before)
    assert.equal(await readFile(home, 'utf-8'), 'legitimate edit')
    assert.equal(r.path, 'Home.md')
    assert.equal(r.title, 'Home')
    assert.equal(r.mtime, (await stat(home)).mtimeMs)
  })

  await t.test('a stale-but-valid mtime is a SaveConflict carrying the disk value', async () => {
    await reset()
    const before = (await stat(home)).mtimeMs
    await assert.rejects(
      () => vault.save('Home.md', 'stale', before - 1),
      (e) =>
        e instanceof vault.SaveConflict &&
        e.currentMtime === before &&
        // The dialog re-saves against this number. A SaveConflict that carried
        // undefined would drive it into writing against garbage.
        Number.isFinite(e.currentMtime),
    )
    await untouched(before)
  })

  await t.test('the conflict is resolvable: the disk stamp lets the save through', async () => {
    // The full ConflictDialog round trip. If this breaks, a conflict becomes a
    // note the user can never save again.
    await reset()
    await assert.rejects(
      () => vault.save('Home.md', 'mine', 0),
      (e) => e instanceof vault.SaveConflict,
    )
    const fresh = await vault.read('Home.md')
    await vault.save('Home.md', 'mine', fresh.mtime)
    assert.equal(await readFile(home, 'utf-8'), 'mine')
  })
})

test('list() rows carry mtime 0 and are not a version', async () => {
  const dir = await scratchVault({ 'Home.md': 'disk' })

  // The index carries no mtime and never did. It is a deliberate hole: the scan
  // does not stat 800 files to hand out version stamps nobody asked for.
  // LATENT, not live — no current caller routes a list row into save(). If one
  // ever does it conflicts forever rather than losing data, which is why 0 is
  // left permitted by requireMtime().
  const [row] = await vault.list()
  assert.equal(row.mtime, 0)
  await assert.rejects(
    () => vault.save(row.path, 'text', row.mtime),
    (e) => e instanceof vault.SaveConflict,
  )
  assert.equal(await readFile(join(dir, 'Home.md'), 'utf-8'), 'disk')
})

test('the IPC handler does not launder an invalid mtime on its way through', async () => {
  // ipc.ts:53 annotates `m: number` and that annotation is erased. The guard
  // has to hold when the value arrives through the real registered handler,
  // not just when vault.save is called directly.
  const { registeredHandlers } = await import('./fixtures/electron-stub.mjs')
  const { CH } = await import('../src/shared/ipc.ts')
  const { registerIpc } = await import('../src/main/ipc.ts')

  const dir = await scratchVault({ 'Home.md': 'disk' })
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
  assert.equal(await readFile(join(dir, 'Home.md'), 'utf-8'), 'disk')
})

// ---------------------------------------------------------------------------
// C. PATH HANDLING — INVERTED BY THE MIGRATION
//
// This suite used to assert the OPPOSITE: that `../../escaped.md` and
// `C:/Windows/win.ini` were forwarded to the server byte for byte, because
// server.py's safe() was the only guard and had to see the exact bytes.
//
// There is no server. Had read() and save() moved into this process without
// bringing that guard with them, the renderer would have gained a read/write
// primitive over the whole disk — the CSP stops the UI making a network
// request, and this is the other door. resolveInVault() is that guard now, and
// these are the cases it has to hold.
// ---------------------------------------------------------------------------

test('paths cannot escape the vault, in either direction', async (t) => {
  const dir = await scratchVault({ 'Home.md': 'ok', 'Projects/AI.md': 'nested' })
  // A file OUTSIDE the vault, in the vault's parent. Every escape below aims at
  // something like this; none of them may read it and none may overwrite it.
  const outside = join(dir, '..', `outside-${Date.now()}.md`)
  await writeFile(outside, 'SECRET', 'utf-8')

  const escapes = [
    '../' + outside.split(/[\\/]/).pop(),
    '../../Windows/win.ini',
    '..',
    '../',
    'Projects/../../escaped.md',
    'C:/Windows/win.ini',
    'C:\\Windows\\win.ini',
    '\\\\NAS\\share\\x.md',
    '/etc/passwd',
    '..\\..\\escaped.md',
  ]

  await t.test('read() refuses every traversal', async () => {
    for (const bad of escapes) {
      await assert.rejects(
        () => vault.read(bad),
        (e) => {
          assert.equal(e.message, 'vault: path escapes the vault', bad)
          return true
        },
        `read() accepted ${bad}`,
      )
    }
  })

  await t.test('save() refuses every traversal, and writes nothing', async () => {
    for (const bad of escapes) {
      await assert.rejects(
        () => vault.save(bad, 'CLOBBERED', 0),
        (e) => e.message === 'vault: path escapes the vault',
        `save() accepted ${bad}`,
      )
    }
    assert.equal(await readFile(outside, 'utf-8'), 'SECRET', 'a file outside the vault was written')
  })

  await t.test('the refusal names no path', async () => {
    // It crosses IPC to the renderer, so it may not carry the vault location
    // any more than an fs error may.
    await assert.rejects(
      () => vault.read('../../x.md'),
      (e) => !e.message.includes(dir) && !/Nathan/i.test(e.message),
    )
  })

  await t.test('the vault root itself is not a note', async () => {
    for (const p of ['.', './', 'Projects/..']) {
      await assert.rejects(
        () => vault.read(p),
        (e) => e.message === 'vault: path escapes the vault',
        `read() accepted the root as ${p}`,
      )
    }
  })

  await t.test('percent-encoding is not a bypass', async () => {
    // The old layer ran encodeURIComponent because the path went into a query
    // string. Nothing decodes now, so `..%2f..%2f` is a literal filename, not a
    // traversal — it simply does not exist.
    await assert.rejects(
      () => vault.read('..%2f..%2fencoded.md'),
      (e) => e.message !== 'vault: path escapes the vault' && /no such file|ENOENT/i.test(e.message),
    )
  })

  await t.test('ordinary paths, including odd ones, still work', async () => {
    // The guard must not cost the vault its real filenames. A containment check
    // that also refuses `Projects/AI.md` or a name with a `#` in it would be
    // discovered as "the app cannot open half my notes".
    assert.equal((await vault.read('Projects/AI.md')).text, 'nested')
    assert.equal((await vault.read('./Home.md')).text, 'ok')
    await vault.save('Odd #name & (chars).md', 'fine', 0)
    assert.equal(await readFile(join(dir, 'Odd #name & (chars).md'), 'utf-8'), 'fine')
  })

  await t.test('requirePath refuses empty and non-string before anything is touched', async () => {
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
  })
})

// ---------------------------------------------------------------------------
// D. ERROR LEAKAGE ACROSS THE BOUNDARY
// ---------------------------------------------------------------------------

/**
 * The leak is the same one as before with a new source: it was Python's
 * `[Errno 2] No such file or directory: 'C:\…\Universal Vault\Home.md'`, it is
 * now Node's `ENOENT: no such file or directory, open 'C:\…'`. Both name the
 * absolute path, both are thrown to the renderer.
 *
 * Asserted through the REGISTERED IPC HANDLER rather than through vault.read()
 * directly, because that is the boundary the rule is about: a scrub that
 * happens inside vault.ts but is lost or re-wrapped on the way through ipc.ts
 * would pass a direct test and still leak.
 */
test('fs errors reach the renderer with the path removed', async (t) => {
  const { registeredHandlers } = await import('./fixtures/electron-stub.mjs')
  const { CH } = await import('../src/shared/ipc.ts')
  const { registerIpc } = await import('../src/main/ipc.ts')

  const dir = await scratchVault({ 'Home.md': 'ok' })
  registerIpc()
  const topFrame = { senderFrame: { parent: null } }
  const read = registeredHandlers.get(CH.vaultRead)
  const save = registeredHandlers.get(CH.vaultSave)

  // The scratch vault is under the user's Temp directory, so the absolute path
  // in these errors really does contain the OS username.
  assert.match(dir, /Nathan/i, 'fixture cannot demonstrate the leak')

  await t.test('a missing note names no path', async () => {
    await assert.rejects(
      () => read(topFrame, 'Missing.md'),
      (e) => {
        assert.ok(!e.message.includes(dir), `vault path leaked: ${e.message}`)
        assert.ok(!/Nathan/i.test(e.message), `username leaked: ${e.message}`)
        assert.match(e.message, /<path>/)
        assert.match(e.message, /no such file or directory/i)
        return true
      },
    )
  })

  await t.test('a failed write names no path', async () => {
    await assert.rejects(
      () => save(topFrame, 'Missing/Deep.md', 'text', 0),
      (e) => {
        assert.ok(!e.message.includes(dir), `vault path leaked: ${e.message}`)
        assert.ok(!/Nathan/i.test(e.message), `username leaked: ${e.message}`)
        return true
      },
    )
  })

  await t.test('a conflict still arrives as a SaveConflict, not a scrubbed Error', async () => {
    // scrub() must not launder this one into an ordinary Error: the renderer
    // matches on the message to open its ConflictDialog, and that dialog is the
    // only thing protecting the unsaved buffer.
    await assert.rejects(
      () => save(topFrame, 'Home.md', 'stale', 1),
      (e) => e.message === 'Note changed on disk since you opened it.',
    )
  })
})

// ---------------------------------------------------------------------------
// E. HOSTILE CONTENT
//
// Note titles and paths are attacker-influenced in the threat model this app
// assumes (anything an agent writes into the vault). Nothing here may pollute
// a prototype or crash the tree/graph builders.
// ---------------------------------------------------------------------------

test('hostile titles and paths do not break or pollute anything', async () => {
  // ONE fixture, on disk. This used to run list() and graph() against a mock
  // note set of six while tree() walked a scratch directory of four: two
  // different vaults inside a single test, survivable only while those
  // functions read different sources. They read the same source now.
  const hostile = {
    'Home.md': 'plain',
    '__proto__.md': '[[Home]]',
    '__proto__/constructor/prototype.md': '[[__proto__]]',
    'constructor.md': '[[Home]]',
    'Regex (dot-star)+$ [meta].md': '[[Home]]',
  }
  await scratchVault(hostile)
  const count = Object.keys(hostile).length

  const notes = await vault.list()
  assert.equal(notes.length, count)

  const root = await vault.tree()
  const paths = []
  ;(function walk(n) {
    if (n.kind === 'note') paths.push(n.path)
    n.children?.forEach(walk)
  })(root)
  assert.equal(paths.length, count, 'every note survives tree()')
  assert.ok(paths.includes('__proto__/constructor/prototype.md'))
  // The tree is built from plain objects; a `__proto__` path segment must not
  // have reached Object.prototype on the way through.
  assert.equal({}.polluted, undefined, 'Object.prototype polluted by tree()')

  const g = await vault.graph()
  assert.equal(g.nodes.length, count)
  // '[[__proto__]]' must resolve through the title Map, not Object.prototype.
  // The Map is what makes that safe; a plain object keyed the same way returns
  // Object.prototype for this lookup instead of a miss.
  assert.ok(
    g.links.some(
      (l) => l.from === '__proto__/constructor/prototype.md' && l.to === '__proto__.md',
    ),
  )

  assert.equal({}.polluted, undefined)
  assert.equal(Object.prototype.kind, undefined)
  assert.equal(Object.prototype.children, undefined)
  assert.equal(Array.prototype.name, undefined)
})


// ---------------------------------------------------------------------------
// F. LARGE RESPONSES
// ---------------------------------------------------------------------------

test('a multi-megabyte note round-trips intact', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024)
  const dir = await scratchVault({ 'Big.md': big })

  const n = await vault.read('Big.md')
  assert.equal(n.text.length, big.length)
  assert.equal(n.text, big)

  // And back out again, through the temp file and the rename.
  const bigger = big + 'y'.repeat(1024)
  const saved = await vault.save('Big.md', bigger, n.mtime)
  assert.equal((await readFile(join(dir, 'Big.md'), 'utf-8')).length, bigger.length)
  assert.equal(saved.mtime, (await stat(join(dir, 'Big.md'))).mtimeMs)
})

// ---------------------------------------------------------------------------
// G. WHAT USED TO BE HERE
//
// Two tests lived here: one for a 2xx body that would not parse, and one that
// spent 15 seconds proving `AbortSignal.timeout` fired when a server accepted
// the connection and never answered. Both were properties of the wire. There is
// no wire, no response to be unparseable, and nothing that can hang — so they
// are gone rather than rewritten into something that only looks equivalent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// H. graph() CONCURRENCY POOL
// ---------------------------------------------------------------------------

test('graph() reads every note exactly once', async () => {
  const notes = { 'Home.md': 'hub' }
  for (let i = 0; i < 24; i++) notes[`N${i}.md`] = '[[Home]] and [[Home]] again'
  await scratchVault(notes)

  const g = await vault.graph()

  assert.equal(g.nodes.length, 25)
  assert.equal(new Set(g.nodes).size, 25, 'a note appeared in the graph twice')

  // Exactly-once used to be measured at the WIRE, counting GET /note requests
  // against a bounded pool of 8. There is no wire now — the scan reads each
  // file once and hands the text straight to the resolver — so the property is
  // asserted where it is still observable: no duplicate nodes, and one edge per
  // linking note however many times that note says [[Home]].
  assert.equal(g.links.length, 24)
  const sources = new Set(g.links.map((l) => l.from))
  assert.equal(sources.size, 24, 'every linking note contributed')
})

test('graph() emits one edge per relationship, not per mention', async () => {
  await scratchVault({
    'Home.md': 'hub',
    // Same target named three different ways, plus a plain repeat. All four are
    // ONE relationship. Before the dedup a note repeating a link 20 000 times
    // produced 20 000 edges, and GraphView sizes nodes by endpoint count.
    'A.md': '[[Home]] [[Home]] [[home]] [[Home.md]]',
  })

  const g = await vault.graph()
  assert.deepEqual(g.links, [{ from: 'A.md', to: 'Home.md' }])
})

test('graph() ignores an unterminated [[', async () => {
  await scratchVault({
    'Home.md': 'hub',
    // A note documenting the syntax. The old link regex had no closing `]]`, so
    // this drew an edge the editor's Links list never showed.
    'Doc.md': 'write a link as [[Home and close it with brackets',
  })

  const g = await vault.graph()
  assert.deepEqual(g.links, [])
})

test('graph() memo is shared by concurrent callers and dropped by save()', async () => {
  const dir = await scratchVault({ 'Home.md': '[[Home]]', 'A.md': '[[Home]]' })

  // Overlapping callers (the graph tab and a backlinks lookup) share one scan.
  await Promise.all([vault.graph(), vault.graph(), vault.backlinks('Home.md')])
  assert.deepEqual((await vault.graph()).links, [{ from: 'A.md', to: 'Home.md' }])

  // Staleness is measured against the DISK: change a file behind the memo's
  // back and the memo must not notice, because it is a 30s cache.
  await writeFile(join(dir, 'A.md'), 'no links any more', 'utf-8')
  assert.deepEqual(
    (await vault.graph()).links,
    [{ from: 'A.md', to: 'Home.md' }],
    'a cached call went back to disk inside the TTL',
  )

  // Our own write invalidates it immediately — no waiting out the TTL. Written
  // through save() this time rather than around it, which is the whole point:
  // the writer and the memo are in the same process now.
  const cur = await vault.read('A.md')
  await vault.save('A.md', 'still no links', cur.mtime)
  assert.deepEqual((await vault.graph()).links, [], 'save() did not invalidate the memo')
})

test('graph() on an empty vault resolves rather than deadlocking', async () => {
  await scratchVault({})
  // Math.min(LIMIT, 0) spawns zero workers; Promise.all([]) must still settle.
  const g = await vault.graph()
  assert.deepEqual(g, { nodes: [], links: [] })
})

/**
 * Was 'graph() survives notes that fail to read', which injected a 500 on
 * GET /note?path=A.md. There is no request to fail now, and the disk analogue —
 * a file deleted in the window between the directory walk and the read — is a
 * race with no deterministic trigger from out here. What IS deterministic is
 * the outcome that race produces, and it is the outcome that matters: a note
 * the scan cannot open costs its own edges and nothing else.
 */
test('graph() loses only the unreadable note, not the vault', async () => {
  const { rm } = await import('node:fs/promises')
  const dir = await scratchVault({
    'Home.md': 'hub',
    'A.md': '[[Home]]',
    'B.md': '[[Home]]',
  })

  await rm(join(dir, 'A.md'))
  vault.invalidateGraph()

  const g = await vault.graph()
  assert.equal(g.nodes.length, 2, 'the missing note should not be indexed')
  assert.ok(g.links.some((l) => l.from === 'B.md'), 'a readable note lost its edges')
  assert.ok(!g.links.some((l) => l.from === 'A.md'))
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

  // The fixture has to be on disk. Without this the handler returned whatever
  // scratch vault the previous test left VAULT_DIR pointing at, and the row
  // count below was a coincidence.
  await scratchVault({ 'Home.md': 'ok' })

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

