/**
 * The save path — the mtime lost-update guard under concurrency.
 *
 * `vault.save(path, text, expectedMtime)` refuses the write when the file's
 * mtime is not the one the caller expected. That guard exists to catch
 * Obsidian editing the file behind us. It was also firing on the user's OWN
 * second action, because the view read `mtime` from the React render closure
 * and never serialised its writes:
 *
 *   1. state mtime = M0. Release a drag -> save(text1, M0).
 *   2. Before it resolves -- a save does a backup copy, a temp write and an
 *      atomic rename, so tens of milliseconds -- press "+ Card" -> the SAME
 *      render's closure -> save(text2, M0).
 *   3. Save 1 lands, the file is now M1, setMtime(M1) is queued.
 *   4. Save 2 arrives expecting M0, finds M1 -> SaveConflict. The new card
 *      never reaches disk and the user is told the file changed underneath
 *      them, which is true only because of their own previous click.
 *
 * Two halves below. The MECHANISM half is a self-contained simulation against
 * a mock save with the real guard's semantics: it demonstrates the failure and
 * that serialising fixes it, and it would catch a logic error in the chaining.
 * It is a replica of the pattern, not of the view, and it is labelled as such.
 * The WIRING half pins that the view actually uses that pattern.
 *
 * Pure module plus a file read. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const { parseCanvas, serializeCanvas } = await import('../src/shared/canvas.ts')

const VIEW = readSource('CanvasView.tsx')

/** The body of `persist`, so assertions cannot be satisfied from elsewhere. */
const persistBody = () => {
  const start = VIEW.indexOf('const persist =')
  assert.ok(start > 0, 'persist no longer has the shape this test reads')
  return VIEW.slice(start, VIEW.indexOf('// ── interaction'))
}

/** A mock of vault.save with the real lost-update semantics. */
const makeDisk = () => {
  const disk = { mtime: 1000, text: '', writes: 0, conflicts: 0 }
  disk.save = async (text, expected) => {
    await new Promise((r) => setTimeout(r, 5)) // the backup + temp + rename window
    if (expected !== disk.mtime) {
      disk.conflicts++
      throw new Error('Note changed on disk since you opened it')
    }
    disk.text = text
    disk.mtime += 1
    disk.writes++
    return { mtime: disk.mtime }
  }
  return disk
}

// ---------------------------------------------------------------- mechanism

test('the OLD pattern loses the second write — this is the bug, reproduced', async () => {
  // Closure-captured mtime, no serialisation. Both saves read the same value.
  const disk = makeDisk()
  const capturedMtime = disk.mtime
  const run = async (text) => {
    try {
      await disk.save(text, capturedMtime)
    } catch {
      /* the conflict the user never caused */
    }
  }
  await Promise.all([run('first'), run('second')])

  assert.equal(disk.writes, 1, 'the fixture did not actually overlap two writes')
  assert.equal(disk.conflicts, 1, 'the second write was expected to be refused')
})

test('a ref plus a promise chain lets both writes land, in order', async () => {
  const disk = makeDisk()
  const mtimeRef = { current: disk.mtime }
  let chain = Promise.resolve()
  const persist = (text) => {
    chain = chain.then(async () => {
      const saved = await disk.save(text, mtimeRef.current)
      mtimeRef.current = saved.mtime
    })
    return chain
  }

  persist('first')
  await persist('second')

  assert.equal(disk.conflicts, 0, 'a save was still refused')
  assert.equal(disk.writes, 2, 'both writes did not land')
  assert.equal(disk.text, 'second', 'the writes landed out of order')
})

test('a genuine outside edit is still refused — the guard is not weakened', async () => {
  // The point of the guard is Obsidian writing the file behind us. Serialising
  // our own writes must not make us start clobbering someone else's.
  const disk = makeDisk()
  const mtimeRef = { current: disk.mtime }
  disk.mtime = 9999 // Obsidian saved while we were idle

  await disk.save('ours', mtimeRef.current).catch(() => {})
  assert.equal(disk.conflicts, 1, 'an outside edit was silently overwritten')
  assert.equal(disk.writes, 0)
})

// ------------------------------------------------------------------- wiring

test('persist reads the mtime from a ref, not from the render closure', () => {
  // THE LOAD-BEARING ASSERTION. A closure-captured value cannot see the mtime
  // the previous save returned, which is the whole defect.
  const body = persistBody()
  assert.match(body, /mtimeRef\.current/, 'persist still reads a closure-captured mtime')
  assert.match(body, /mtimeRef\.current = /, 'the ref is never advanced after a save')
})

test('saves are serialised, so two can never be in flight against one file', () => {
  assert.match(
    persistBody(),
    /saveChain\.current = saveChain\.current\.then\(/,
    'saves are not chained',
  )
})

test('a save is addressed to the board it was queued for', () => {
  // If the board changes between queueing and running, the write still belongs
  // to the file it was made on -- and its result must not be written back as
  // the CURRENT board's mtime.
  const body = persistBody()
  assert.match(body, /const target = path/, 'the save does not capture its target board')
  assert.match(body, /pathRef\.current === target/, 'the result is applied to the wrong board')
})

// ------------------------------------------------------- preservation rule

test('the preservation rule is intact: a board still round-trips untouched', () => {
  const RICH = {
    nodes: [{ id: 'a', type: 'file', file: 'A.md', subpath: '#H', x: 0, y: 0, width: 9, height: 9 }],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'a', label: 'x', color: '3' }],
    extra: { keep: true },
  }
  const text = `${JSON.stringify(RICH, null, 2)}\n`
  assert.equal(serializeCanvas(parseCanvas(text)), text)
})
