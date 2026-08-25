/**
 * DERIVED FACETS, SURFACED WHERE SOMEONE CAN USE THEM.
 *
 * `shared/facets.ts` computed a complete, never-stale set of tags for 463 of
 * 465 notes and nothing read them. A feature that is computed and unread is not
 * a feature, and the roadmap said so — "partial: nothing in the UI consumes
 * facets yet". This is the wiring that closes it.
 *
 * The behaviour is tested in `facets.test.mjs`, which can execute the module.
 * This file tests the WIRING, and it does so by reading source because
 * `DatabaseView.tsx` is JSX and `node --test` cannot import it. Source
 * assertions are weak evidence, so they are kept narrow and aimed at the three
 * decisions that would silently undo the feature:
 *
 *   the threshold is computed ONCE, not per row
 *   a missing graph degrades the column instead of emptying the table
 *   the hover text is the facet's own reason, not the values repeated
 *
 * Comments are stripped before matching — see fixtures/source.mjs — so a
 * paragraph describing an intention cannot pass for the intention.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const DB = readSource('DatabaseView.tsx')
const MAIN = readSource('MainCanvas.tsx')

// ------------------------------------------------------------------ it is read

test('the database actually consumes facets', () => {
  // The whole point. Before this, `facets.ts` was imported by its test and
  // nothing else in the app.
  assert.match(DB, /from '\.\.\/\.\.\/\.\.\/shared\/facets\.js'/)
  assert.match(DB, /\bfacets\b/)
  assert.match(DB, /\bfacetKeys\b/)
})

test('facets are a grouping, which is the only way to see one nobody typed', () => {
  assert.match(DB, /'facet'/)
  assert.match(DB, /key: 'facet'/)
})

test('facets are a column, so they are visible without changing the grouping', () => {
  assert.match(DB, /key: 'facets'/)
})

// --------------------------------------------------------- computed once, not per row

test('the hub threshold is hoisted out of the per-row path', () => {
  // `facets()` defaults hubAt to `hubThreshold(hood.degrees)`, which sorts the
  // whole degree array. Calling it per row is 465 sorts of a 465-element array
  // for one number that never changes. `neighbourhoods()` returns it alongside
  // the adjacency, and it must be threaded through.
  assert.match(DB, /neighbourhoods\(/, 'the batch builder is not being used')
  assert.match(DB, /hubAt/, 'the precomputed threshold is not threaded through')
  assert.match(DB, /facets\(path, hood, hubAt\)/, 'facets() is being left to recompute it')
})

test('the index is memoised on the two things it derives from', () => {
  // Rebuilding it on every keystroke in the search box would make the whole
  // table stutter, and the inputs are exactly notes and graph.
  assert.match(DB, /useMemo\(/)
  assert.match(DB, /\[notes, graph\]/)
})

// ------------------------------------------------------- a missing graph is not an error

test('the graph prop is optional, because the table works without it', () => {
  // Folder and date facets need no neighbours at all. A graph that will not
  // build should cost the `shape` and `about` facets, not the view.
  assert.match(DB, /graph\?:/)
})

test('a failed graph load does not fail the database', () => {
  // Loaded separately and after the notes, with its own catch. If it shared the
  // notes try/catch, a graph error would render "Database failed:" over a table
  // that had loaded perfectly well.
  assert.match(MAIN, /setNotes\(await getNotes\(\)\)/)
  const after = MAIN.slice(MAIN.indexOf('handleSwitchToDatabase'))
  assert.match(after, /setGraph\(await getGraph\(\)\)/, 'the database never fetches the graph')
  assert.match(after, /if \(graph\) return/, 'it refetches a graph it already has')
})

test('the database is handed the graph it needs', () => {
  assert.match(MAIN, /graph=\{graph\}/)
})

// ------------------------------------------------------------------ it explains itself

test('the hover text is the reason, not the values again', () => {
  // A derived value a person did not type has to say where it came from, or it
  // is indistinguishable from one that was invented. `facetKeys` is what shows;
  // `why` is what the title carries.
  assert.match(DB, /facetWhy/)
  assert.match(DB, /\.why/, 'the reasons are never read off the facets')
  assert.match(DB, /title=\{facetWhy\(n\.path\)\}/)
})

test('a truncated facet list still names what it hid', () => {
  // TAG_CAP is 2 and its own comment promises "the full list is in the cell's
  // title". A title carrying only prose breaks that promise silently: a note
  // with four facets renders two and a "+2", and the two it hid are gone. Each
  // title line therefore leads with the facet before explaining it.
  assert.match(DB, /\$\{x\.kind\}:\$\{x\.value\}/, 'the title does not name the facets it explains')
})

// --------------------------------------------------------------- pane house rules

test('the addition keeps the vault pane rules', () => {
  // review-s2-vault-pane greps every .ts(x) in this pane. Checked here too so a
  // failure names this change rather than surfacing in a 51KB suite.
  const added = DB.slice(DB.indexOf('facetIndex'))
  assert.ok(!/setTimeout|setInterval/.test(added), 'a timer entered the pane')
  assert.ok(!/console\./.test(added), 'a console call entered the pane')
  assert.ok(!/style=\{\{/.test(added), 'an inline style object entered the pane')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(added), 'a hex colour literal entered the pane')
})

test('nothing writes a facet anywhere', () => {
  // They are derived and recomputed on read. The moment one is stored it can
  // disagree with what it came from, and then it is hand-maintained metadata
  // with extra steps — which is the thing facets exist to replace.
  const added = DB.slice(DB.indexOf('facetIndex'))
  assert.ok(!/vault\.save|api\.vault/.test(added), 'the facet path reaches a write channel')
})
