/**
 * The database table writes back into the note's own Markdown.
 *
 * Source-level, like the rest of the vault-pane suite: <VaultPane> is .tsx and
 * node's type stripping does not handle JSX, so behaviour here is proven by
 * driving the real app and the invariants below are what stop the shape of the
 * write path drifting between those runs.
 *
 * All four of these are properties of a write that touches notes NOBODY HAS
 * OPEN. That is what makes this different from the editor's save: the user is
 * not looking at what is about to change, so the guards are the only thing
 * standing between a mis-click and a note they will not read again for months.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n')
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const PANE = stripComments(read('src/renderer/panes/vault/VaultPane.tsx'))
const DB = stripComments(read('src/renderer/panes/vault/DatabaseView.tsx'))
const CANVAS = stripComments(read('src/renderer/panes/vault/MainCanvas.tsx'))

/** `handleSetProperty`'s body alone, sliced at the next top-level handler. */
const setProperty = (() => {
  const from = PANE.indexOf('const handleSetProperty')
  assert.notEqual(from, -1, 'handleSetProperty is gone')
  const rest = PANE.slice(from)
  return rest.slice(0, rest.indexOf('const handleSave'))
})()

test('the write goes through saveNote, so it keeps a backup and runs the guard', () => {
  // The whole argument for this feature was that a property edit is a normal
  // save, not a new kind of write. A direct file API here would be the one
  // write in the app with no pre-edit copy behind it.
  assert.match(setProperty, /vault\.saveNote\(/)
  assert.doesNotMatch(setProperty, /writeFile|fs\./, 'it writes the file itself')
})

test('the mtime is the one just read, never the row the table drew', () => {
  // The table is a long-lived view over hundreds of notes; its own mtime column
  // can be minutes stale. Using it would raise a conflict on nearly every edit,
  // which teaches the user to ignore the one that meant something.
  assert.match(setProperty, /const note = await vault\.readNote\(path\)/)
  assert.match(setProperty, /vault\.saveNote\(path, next, note\.mtime\)/)
  assert.doesNotMatch(setProperty, /n\.mtime|row\.mtime/)
})

test('an unchanged value is not a write', () => {
  // Every save copies the file into .backups/ first. Re-committing a cell
  // without changing it would grow the history for nothing.
  assert.match(setProperty, /if \(next === note\.text\) return/)
})

test('it refuses rather than merges when the note has unsaved edits open', () => {
  // Two legitimate texts and no way to know which was meant. Writing the file
  // strands the buffer on a stale mtime; writing the buffer discards typing.
  assert.match(setProperty, /if \(openHere && isDirty\)/)
  assert.match(setProperty, /throw new Error\(/)
  // And when it does write a note that IS open, it moves the buffer with it --
  // otherwise the editor shows frontmatter the file no longer has, and the next
  // Save silently undoes the property edit.
  assert.match(setProperty, /if \(openHere\)[\s\S]*setBuffer\(next\)/)
})

test('a failed write reaches the cell that asked for it', () => {
  // The cell is the only thing on screen that can say WHICH row did not change.
  // A try/catch in the pass-through would leave the table showing the old value
  // with no sign anything went wrong.
  const passthrough = CANVAS.slice(CANVAS.indexOf('onSetProperty={'))
  const body = passthrough.slice(0, passthrough.indexOf('/>'))
  assert.match(body, /await onSetProperty\(path, key, value\)/)
  assert.doesNotMatch(body, /catch/, 'the pass-through swallows the failure')
  assert.match(body, /setNotes\(await getNotes\(\)\)/, 'the table is not re-read after a write')
})

test('the cell reports a conflict itself instead of opening the dialog', () => {
  // The conflict dialog is about the edit buffer and has nothing to offer a
  // table cell. VersionsView made the same call for the same reason.
  assert.match(DB, /isSaveConflict\(message\)/)
  assert.doesNotMatch(DB, /onConflict/, 'the table reaches for the editor dialog')
})

test('only Enter commits — no blur-save anywhere in the cell', () => {
  // review-s2 hard-fails on `onBlur=` across the whole pane and this is the
  // control most likely to want one. The table owning which cell is open is
  // what replaces it: opening a second closes the first.
  assert.doesNotMatch(DB, /onBlur/, 'the cell saves on blur')
  assert.match(DB, /const \[editingCell, setEditingCell\] = useState<string \| null>\(null\)/)
  assert.match(DB, /if \(e\.key === 'Enter'\)[\s\S]{0,200}void commit\(e\.currentTarget\.value\)/)
})

test('the two editable columns are the two hand-maintained scalars', () => {
  // Area is derived from the folder, links are the wikilinks in the body,
  // updated is a stamp, and tags is a list setFrontmatter will not write.
  const cells = [...DB.matchAll(/onCommit=\{\(next\) => onSetProperty\(n\.path, '(\w+)'/g)].map((m) => m[1])
  assert.deepEqual(cells.sort(), ['status', 'type'])
})
