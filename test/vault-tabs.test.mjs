/**
 * TABS THAT ACTUALLY HOLD A DOCUMENT.
 *
 * Reported symptom: open a note, open a new tab, click something else, click
 * back — every tab shows the same thing. A new tab said "New tab" forever even
 * while showing the database, and the first tab's name went stale the moment
 * the view changed.
 *
 * Two causes, and the tests below pin both:
 *
 *   1. `handleTabChange` read `if (tab.path && !(await openNote(...)))` and fell
 *      straight through for a tab with no path. Nothing cleared the pane-wide
 *      `selectedNote`, so the new tab rendered the previous tab's note.
 *   2. `view` lived inside <MainCanvas>, which no tab could reach. A tab could
 *      not remember it was on the graph, and its label could not describe it.
 *
 * These are source-level assertions because <VaultPane> is .tsx and node's type
 * stripping does not handle JSX — the same reason review-s2 and review-s3 test
 * this pane by reading it. They are written against the CODE with comments
 * removed, since every comment here names the very bug being forbidden.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/**
 * Newlines NORMALISED. This repo has core.autocrlf=true, so sources are CRLF on
 * disk. Any source-level assertion that spans a line break silently matches
 * nothing without this, and a guard test that cannot fail is worse than none.
 */
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const PANE = stripComments(read('src/renderer/panes/vault/VaultPane.tsx'))
const CANVAS = stripComments(read('src/renderer/panes/vault/MainCanvas.tsx'))
const TABBAR = stripComments(read('src/renderer/panes/vault/TabBar.tsx'))

// ------------------------------------------------------- a tab holds a view

test('VaultTab carries the view it was last on', () => {
  assert.match(TABBAR, /view:\s*MainView/, 'VaultTab has no view — a tab cannot restore where it was')
})

test('MainView is exported so a tab can be typed by it', () => {
  assert.match(CANVAS, /export type MainView\b/)
})

test('MainCanvas no longer owns view as local state', () => {
  // The regression this guards: putting `view` back inside the canvas makes it
  // pane-wide again, and every tab silently shows the same view once more.
  assert.doesNotMatch(
    CANVAS,
    /useState<[^>]*'editor'[^>]*>\(\s*'editor'\s*\)/,
    'MainCanvas took view back into local state',
  )
  assert.match(CANVAS, /view,\s*\n\s*onViewChange,/, 'MainCanvas does not accept view as a prop')
})

test('every view switch goes through the callback, not a local setter', () => {
  assert.doesNotMatch(CANVAS, /\bsetView\(/, 'a setView call survived the lift')
  assert.ok(
    (CANVAS.match(/onViewChange\(/g) ?? []).length >= 8,
    'not every view switch was rewired to the callback',
  )
})

// ------------------------------------------------- switching to an empty tab

test('switching to a tab with no note CLEARS the note', () => {
  const fn = PANE.slice(PANE.indexOf('const handleTabChange'))
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4)

  assert.match(body, /setSelectedNote\(null\)/, 'an empty tab keeps the previous tab\'s note')
  assert.match(body, /setBuffer\(''\)/, 'an empty tab keeps the previous tab\'s buffer')
  assert.match(body, /setBacklinks\(\[\]\)/, 'an empty tab keeps stale backlinks')
})

test('switching to an empty tab still asks before discarding unsaved edits', () => {
  const fn = PANE.slice(PANE.indexOf('const handleTabChange'))
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4)

  // The note-bearing branch inherits the confirm from loadNote. The empty
  // branch has no load to inherit it from, so it must ask for itself or a tab
  // click silently eats typed text.
  assert.match(body, /isDirty/, 'the empty-tab branch can discard unsaved edits without asking')
  assert.match(body, /window\.confirm/)
})

test('the old fall-through form is gone', () => {
  assert.doesNotMatch(
    PANE,
    /if\s*\(tab\.path\s*&&\s*!\(await openNote\(tab\.path,\s*id\)\)\)\s*return/,
    'the single-line form is back; a pathless tab falls through again',
  )
})

// ------------------------------------------------------------ tab labelling

test('a tab with no note is named after its view', () => {
  assert.match(PANE, /const VIEW_LABEL: Record<MainView, string>/)
  for (const v of ['versions', 'graph', 'database', 'inbox', 'roadmap']) {
    assert.match(PANE, new RegExp(`${v}:\\s*'`), `no label for the ${v} view`)
  }
})

test('a note title beats the view label once a tab holds a note', () => {
  // `t.path ? t.name : VIEW_LABEL[next]` — renaming an open note's tab to
  // "Database" because the user glanced at the table would lose the only
  // identifier the tab had.
  assert.match(PANE, /t\.path \? t\.name : VIEW_LABEL\[next\]/)
})

// ----------------------------------------------------------------- the split

test('the split pane keeps a view of its own', () => {
  // The whole point of split is two views of ONE note. If both canvases read
  // the tab's view they would always agree, which is not a split.
  assert.match(PANE, /const \[splitView, setSplitView\] = useState<MainView>/)
  assert.match(
    PANE,
    /canvasWith\(view, handleViewChange\)/,
    'the primary canvas does not use the tab view',
  )
  assert.match(
    PANE,
    /split \? canvasWith\(splitView, setSplitView\) : null/,
    'the split canvas shares the primary view',
  )
})

test('the primary view is derived from the active tab, never mirrored', () => {
  // A second copy in state drifts the moment a tab switch races a view click.
  assert.match(
    PANE,
    /const view: MainView = tabs\.find\(\(t\) => t\.id === activeTabId\)\?\.view \?\? 'editor'/,
  )
  assert.doesNotMatch(PANE, /useState<MainView>\('editor'\)/, 'the primary view was mirrored into state')
})
