/**
 * What the app opens with, on a cold start.
 *
 * The rule is small; what it must never do is not. `startupNote` runs before
 * the user has touched anything, against whatever folder they pointed the app
 * at, so the assertions that matter most here are the negative ones: it must
 * not invent a file, must not reach into the tree for a nested index, and must
 * not open a stale day.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

import { startupNote } from '../src/shared/startup.ts'

/** Terse tree builders — the real shape, minus the fields this never reads. */
const note = (name, path = name) => ({ name, path, kind: 'note' })
const folder = (name, children, path = name) => ({
  name,
  path,
  kind: 'folder',
  children,
})
const root = (children) => folder('Vault', children, '')

const AUG_18 = new Date(2026, 7, 18, 9, 0, 0)

test('a vault with a Home.md opens it', () => {
  const tree = root([note('Ideas.md'), note('Home.md'), note('Zebra.md')])
  assert.equal(startupNote(tree, AUG_18), 'Home.md')
})

test('the home note is matched case-insensitively', () => {
  // A vault is a folder a person made by hand. `home.md` is the same intent.
  assert.equal(startupNote(root([note('home.md')]), AUG_18), 'home.md')
  assert.equal(startupNote(root([note('HOME.md')]), AUG_18), 'HOME.md')
})

test('index and readme are fallbacks, in that order, behind home', () => {
  const all = root([note('README.md'), note('index.md'), note('Home.md')])
  assert.equal(startupNote(all, AUG_18), 'Home.md', 'home must win')
  const noHome = root([note('README.md'), note('index.md')])
  assert.equal(startupNote(noHome, AUG_18), 'index.md', 'index must beat readme')
  const only = root([note('README.md')])
  assert.equal(startupNote(only, AUG_18), 'README.md')
})

test('a NESTED index is not the vault front door', () => {
  /**
   * THE RULE THIS PINS. `Fate/Roadmap/00 - INDEX.md` is an index of a section,
   * and a search of the whole tree would open whichever one the walk reached
   * first — which is a different note depending on folder order, i.e. a
   * launch that is not reproducible.
   */
  const tree = root([
    folder('Fate', [folder('Roadmap', [note('index.md', 'Fate/Roadmap/index.md')], 'Fate/Roadmap')], 'Fate'),
  ])
  assert.equal(startupNote(tree, AUG_18), null)
})

test("today's daily note opens when there is no home note", () => {
  const tree = root([
    folder('Daily', [note('2026-08-18.md', 'Daily/2026-08-18.md')], 'Daily'),
  ])
  assert.equal(startupNote(tree, AUG_18), 'Daily/2026-08-18.md')
})

test('a home note still beats the daily note', () => {
  const tree = root([
    note('Home.md'),
    folder('Daily', [note('2026-08-18.md', 'Daily/2026-08-18.md')], 'Daily'),
  ])
  assert.equal(startupNote(tree, AUG_18), 'Home.md')
})

test("YESTERDAY's daily note is not opened", () => {
  /**
   * Opening a stale day reads as the app having lost your place. An empty
   * editor at least tells the truth, so the absence of today's note is a
   * null rather than a walk backwards through the folder.
   */
  const tree = root([
    folder('Daily', [note('2026-08-17.md', 'Daily/2026-08-17.md')], 'Daily'),
  ])
  assert.equal(startupNote(tree, AUG_18), null)
})

test('IT NEVER NAMES A FILE THAT IS NOT IN THE TREE', () => {
  /**
   * The assertion the whole module exists under: nothing here may create a
   * file, so nothing here may return a path the vault did not already show it.
   * A returned path is handed straight to `openNote`; inventing one would be
   * how "open the front door" turns into "write to your vault on launch".
   */
  const trees = [
    root([]),
    root([note('Something.md')]),
    root([folder('Daily', [], 'Daily')]),
    root([folder('Daily', [note('_Template.md', 'Daily/_Template.md')], 'Daily')]),
  ]
  for (const tree of trees) {
    const got = startupNote(tree, AUG_18)
    if (got === null) continue
    const paths = []
    const walk = (n) => {
      paths.push(n.path)
      for (const c of n.children ?? []) walk(c)
    }
    walk(tree)
    assert.ok(paths.includes(got), `${got} is not a path in the tree`)
  }
})

test('a folder named Home.md is not a note', () => {
  // `kind`, not the extension. A folder someone called `Home.md` would
  // otherwise be handed to a reader that expects text.
  const tree = root([folder('Home.md', [], 'Home.md')])
  assert.equal(startupNote(tree, AUG_18), null)
})

test('a canvas is not a home note either', () => {
  // `Home.canvas` exists in the author's real vault beside `Home.md`, and the
  // kinds are deliberately distinct — a board read as a note resolves every
  // quoted string on a card as a wikilink.
  const tree = root([{ name: 'Home.canvas', path: 'Home.canvas', kind: 'canvas' }])
  assert.equal(startupNote(tree, AUG_18), null)
})

test('no tree, no note', () => {
  assert.equal(startupNote(null, AUG_18), null)
})

test('the pane opens it once, and cannot be dragged back on a reload', () => {
  /**
   * READ OFF THE SOURCE, because the bug it guards is a sequencing one that
   * unit-testing the pure function cannot reach: the tree reloads after every
   * create, move and agent write, so a startup open without a one-shot guard
   * would yank the user back to Home from whatever they had opened since.
   *
   * The guard must also be claimed BEFORE the await — two trees landing while
   * the first read is in flight would otherwise both pass the check.
   */
  const src = readFileSync(
    new URL('../src/renderer/panes/vault/VaultPane.tsx', import.meta.url),
    'utf8',
  )
  const block = src.slice(src.indexOf('openedStartupNote'), src.indexOf('}, [vault.tree])'))
  assert.match(block, /if \(openedStartupNote\.current\) return/, 'the open is not guarded')
  assert.ok(
    block.indexOf('openedStartupNote.current = true') < block.indexOf('startupNote('),
    'the guard is claimed after the lookup, so a second tree can race it',
  )
  assert.match(block, /if \(openPathRef\.current\) return/, 'it would clobber an open note')
})
