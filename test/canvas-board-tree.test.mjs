/**
 * The sidebar's board hierarchy.
 *
 * `Home.canvas` is the root and a board is a child of another when the parent
 * holds a page pointing at it, so the tree is derived from the boards
 * themselves rather than from a folder layout that can disagree with them.
 *
 * `boardTree` is a pure function, so these are REAL tests — they run the thing
 * and check what it returns. No source scraping, no DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const { boardTree, ROOT_BOARD, isCanvasPath } = await import('../src/shared/canvas.ts')

const ref = (path) => ({ path, name: path.split('/').pop() })
const shape = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.path}${r.reachable ? '' : ' *'}`)

test('the root is Home.canvas', () => {
  assert.equal(ROOT_BOARD, 'Home.canvas')
})

test('boards nest under the board whose pages point at them', () => {
  const boards = ['Home.canvas', 'Ingest.canvas', 'Publish.canvas', 'Scrape.canvas'].map(ref)
  const links = {
    'Home.canvas': ['Ingest.canvas', 'Publish.canvas'],
    'Ingest.canvas': ['Scrape.canvas'],
  }
  assert.deepEqual(shape(boardTree(boards, links)), [
    'Home.canvas',
    '  Ingest.canvas',
    '    Scrape.canvas',
    '  Publish.canvas',
  ])
})

test('a board nothing links to is still listed, flagged unreachable', () => {
  // Dropping it would make a board vanish the moment it was unlinked — the file
  // would still be on disk and the app would deny it existed.
  const boards = ['Home.canvas', 'Orphan.canvas'].map(ref)
  const rows = boardTree(boards, { 'Home.canvas': [] })
  assert.deepEqual(shape(rows), ['Home.canvas', 'Orphan.canvas *'])
  assert.equal(rows.find((r) => r.path === 'Orphan.canvas').reachable, false)
})

test('with no Home.canvas at all, every board is listed as unreachable', () => {
  const boards = ['A.canvas', 'B.canvas'].map(ref)
  const rows = boardTree(boards, { 'A.canvas': ['B.canvas'] })
  assert.deepEqual(shape(rows), ['A.canvas *', 'B.canvas *'])
})

// ------------------------------------------------------------------ safety

test('two boards linking each other do not recurse forever', () => {
  // Authoring this by accident is ordinary. Without the guard it recurses until
  // the stack gives out, taking the sidebar and the app with it.
  const boards = ['Home.canvas', 'A.canvas', 'B.canvas'].map(ref)
  const links = { 'Home.canvas': ['A.canvas'], 'A.canvas': ['B.canvas'], 'B.canvas': ['A.canvas'] }
  assert.deepEqual(shape(boardTree(boards, links)), ['Home.canvas', '  A.canvas', '    B.canvas'])
})

test('a board linking to itself does not recurse forever', () => {
  const boards = ['Home.canvas'].map(ref)
  assert.deepEqual(shape(boardTree(boards, { 'Home.canvas': ['Home.canvas'] })), ['Home.canvas'])
})

test('a board reached twice is listed once, at the first place it is reached', () => {
  // Pipelines share sub-steps. Drawing the shared one under every parent would
  // turn one file into several entries you could not tell apart.
  const boards = ['Home.canvas', 'A.canvas', 'B.canvas', 'Shared.canvas'].map(ref)
  const links = {
    'Home.canvas': ['A.canvas', 'B.canvas'],
    'A.canvas': ['Shared.canvas'],
    'B.canvas': ['Shared.canvas'],
  }
  const rows = boardTree(boards, links)
  assert.equal(rows.filter((r) => r.path === 'Shared.canvas').length, 1)
  assert.deepEqual(shape(rows), [
    'Home.canvas',
    '  A.canvas',
    '    Shared.canvas',
    '  B.canvas',
  ])
})

test('a page pointing at a board that no longer exists is skipped', () => {
  // Renamed or deleted in Obsidian. Skipped rather than invented, the same way
  // a dangling edge is skipped rather than drawn.
  const boards = ['Home.canvas'].map(ref)
  assert.deepEqual(shape(boardTree(boards, { 'Home.canvas': ['Gone.canvas'] })), ['Home.canvas'])
})

test('the root is matched case-insensitively, because this runs on Windows', () => {
  const rows = boardTree([ref('home.canvas')], { 'home.canvas': [] })
  assert.equal(rows[0].reachable, true, 'home.canvas was not recognised as the root')
})

test('a root inside a folder is found by name', () => {
  const boards = [ref('Boards/Home.canvas'), ref('Boards/Step.canvas')]
  const rows = boardTree(boards, { 'Boards/Home.canvas': ['Boards/Step.canvas'] })
  assert.deepEqual(shape(rows), ['Boards/Home.canvas', '  Boards/Step.canvas'])
})

test('every board is accounted for exactly once, whatever the links', () => {
  // The invariant that matters for a sidebar: the listing shows each file once.
  const boards = ['Home.canvas', 'A.canvas', 'B.canvas', 'C.canvas', 'D.canvas'].map(ref)
  const links = {
    'Home.canvas': ['A.canvas', 'B.canvas'],
    'A.canvas': ['B.canvas', 'C.canvas'],
    'C.canvas': ['Home.canvas'],
  }
  const rows = boardTree(boards, links)
  assert.equal(rows.length, boards.length)
  assert.deepEqual(
    rows.map((r) => r.path).sort(),
    boards.map((b) => b.path).sort(),
  )
})

test('isCanvasPath knows a board from a note', () => {
  assert.equal(isCanvasPath('Notes/Alpha.md'), false)
  assert.equal(isCanvasPath('Home.canvas'), true)
  // Case-insensitive, and not fooled by the word appearing mid-path.
  assert.equal(isCanvasPath('Boards/Main.CANVAS'), true)
  assert.equal(isCanvasPath('canvas/notes.md'), false)
})
