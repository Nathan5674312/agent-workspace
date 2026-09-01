/**
 * Alt+drag in the graph writes a wikilink into the source note.
 *
 * Source-level, like the rest of the vault-pane suite — the pure halves are
 * unit-tested in `wikilink-write.test.mjs`, and what is left here is wiring
 * that a grep can hold still between watched-running passes.
 *
 * The invariants below are all about the same thing: this is the only control
 * in the app that edits PROSE in a file that is usually not on screen.
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
const GRAPH = stripComments(read('src/renderer/panes/vault/GraphView.tsx'))
const CANVAS = stripComments(read('src/renderer/panes/vault/MainCanvas.tsx'))

const addLink = (() => {
  const from = PANE.indexOf('const handleAddLink')
  assert.notEqual(from, -1, 'handleAddLink is gone')
  const rest = PANE.slice(from)
  return rest.slice(0, rest.indexOf('const handleSave'))
})()

// ------------------------------------------------------------------ the write

test('the link is written through saveNote, never straight to disk', () => {
  assert.match(addLink, /vault\.saveNote\(from, next, note\.mtime\)/)
  assert.doesNotMatch(addLink, /writeFile|fs\./)
})

test('it reads first and uses THAT mtime, so the guard covers the confirm', () => {
  // The dialog is open for as long as a person takes to read it. A note that
  // changed in that window must conflict rather than be clobbered.
  const readAt = addLink.indexOf('await vault.readNote(from)')
  const confirmAt = addLink.indexOf('window.confirm')
  const saveAt = addLink.indexOf('vault.saveNote')
  assert.ok(readAt !== -1 && confirmAt !== -1 && saveAt !== -1)
  assert.ok(readAt < confirmAt, 'it confirms before it knows what it would write')
  assert.ok(confirmAt < saveAt, 'it writes before confirming')
})

test('nothing is written without a confirmation', () => {
  assert.match(addLink, /if \(!window\.confirm\([\s\S]{0,200}\)\) return false/)
})

test('it refuses when the source note is open with unsaved edits', () => {
  assert.match(addLink, /selectedNote\?\.path === from && isDirty/)
  assert.match(addLink, /throw new Error\(/)
})

test('a link the note already has is not a write and not an error', () => {
  assert.match(addLink, /if \(next === note\.text\) return false/)
})

test('a node cannot be linked to itself', () => {
  assert.match(addLink, /if \(from === to\) return false/)
})

test('failures land on the banner — a pointer handler cannot catch a rejection', () => {
  assert.match(addLink, /catch \(e\)/)
  assert.match(addLink, /setOpenError\(/)
  assert.match(addLink, /isSaveConflict\(message\)/)
})

test('the editor buffer moves with the file when it is showing that note', () => {
  // Otherwise the editor shows a note without the link the file now has, and
  // the next Save quietly removes it again.
  // Checked against `openPathRef`, not the captured `selectedNote`: a read and
  // a save have completed since this handler started, and the user can open
  // another note in that window. See db-write's 'STILL open after the awaits'.
  assert.match(addLink, /if \(openPathRef\.current === from\)[\s\S]{0,400}setBuffer\(next\)/)
})

test("the link spelling is chosen with the editor's own resolver", () => {
  // Not a home-made lookup: the check has to be "would clicking this land on
  // the note I mean".
  assert.match(addLink, /linkTextFor\(to, \(name\) =>[\s\S]{0,120}resolveWikilink\(name, noteIndex\)/)
})

test('a shared stem is refused the short form, because the resolvers differ', () => {
  // The name index is FIRST-WINS on a shared stem; the graph builder in
  // src/main/vault.ts resolves by PROXIMITY. Passing resolveWikilink alone let
  // a short link through that the graph would then draw as an edge to a
  // DIFFERENT note — the exact failure linkTextFor exists to prevent. Declining
  // every shared stem drops those to the path form; unique stems are untouched,
  // because there both resolvers agree by construction.
  assert.match(addLink, /sharedStems\.has\(normTarget\(name\)\) \? null :/)
  assert.match(PANE, /const sharedStems = useMemo\(\(\) => ambiguousStems\(vault\.tree\)/)
})

// --------------------------------------------------------------- the gesture

test('the gesture is ALT+drag, because plain drag is taken', () => {
  // Plain drag moves a node and pins it into the simulation. That is the
  // gesture the force layout is built around and it cannot be taken back.
  assert.match(GRAPH, /if \(hit && e\.altKey && linkRef\.current\)/)
})

test('starting a link marks the gesture as a drag, or it also opens the note', () => {
  // onClick opens the note unless `moved`. Releasing the pointer fires a click.
  const at = GRAPH.indexOf('e.altKey && linkRef.current')
  const body = GRAPH.slice(at, at + 400)
  assert.match(body, /moved = true/)
})

test('the source node is never pinned — this is not a physics drag', () => {
  const at = GRAPH.indexOf('e.altKey && linkRef.current')
  const body = GRAPH.slice(at, at + 400)
  assert.doesNotMatch(body, /\bfx\b|\balphaTarget\b|setHolding/, 'the link drag moves the node')
})

test('a node cannot be dropped on itself', () => {
  assert.match(GRAPH, /hit && hit\.id !== linking\.from\.id \? hit : null/)
})

test('released on empty space, nothing is written', () => {
  assert.match(GRAPH, /if \(commit && over\) linkRef\.current\?\.\(from\.id, over\.id\)/)
})

test('the band is cleared BEFORE the handler opens its confirm', () => {
  // window.confirm blocks. A band left painted under a modal shows a
  // connection that has not been agreed to.
  const at = GRAPH.indexOf('const finish = ')
  const body = GRAPH.slice(at, at + 900)
  assert.ok(
    body.indexOf('linking = null') < body.indexOf('linkRef.current?.'),
    'the callback runs while the band is still up',
  )
})

test('the proposed edge is DASHED, so it cannot read as one that exists', () => {
  // Every real edge in this view is a line read out of somebody's Markdown.
  assert.match(GRAPH, /setLineDash\(\[6 \/ k, 4 \/ k\]\)/)
  assert.match(GRAPH, /setLineDash\(\[\]\)/, 'the dash is left set for later drawing')
})

test('the callback is held in a ref, like onOpenNote', () => {
  // A dependency would tear down and rebuild the whole simulation whenever the
  // parent re-rendered with an inline arrow.
  assert.match(GRAPH, /const linkRef = useRef\(onLinkNotes\)/)
  assert.match(GRAPH, /linkRef\.current = onLinkNotes/)
})

// ---------------------------------------------------------------- the refresh

test('the graph is re-fetched after a write, and only after a write', () => {
  const at = CANVAS.indexOf('onLinkNotes={')
  const body = CANVAS.slice(at, at + 400)
  assert.match(body, /if \(written\) setGraph\(await getGraph\(\)\)/)
})

test('the new edge comes back from the FILES, not from a local patch', () => {
  // save() invalidates the main-process graph cache, so getGraph() rebuilds.
  // The edge must appear because it is in the Markdown, not because the
  // renderer drew one it was told about.
  const at = CANVAS.indexOf('onLinkNotes={')
  const body = CANVAS.slice(at, at + 400)
  assert.doesNotMatch(body, /\.links\.push|setGraph\(\{/, 'the renderer invents the edge')
})

test('a graph rebuild clears the hover label it was reporting', () => {
  // `hover` is a local of the effect and `hoverLabel` is React state, so a
  // rebuild resets one and not the other. onMove reconciles on
  // `hit?.id !== hover?.id`, which over empty canvas is undefined !== undefined
  // -- false -- so a stale name would stay on screen forever. Alt+drag is what
  // made it reachable: it writes, re-fetches, and the effect restarts.
  const at = GRAPH.lastIndexOf('return () => {')
  const cleanup = GRAPH.slice(at, at + 600)
  assert.match(cleanup, /setHoverLabel\(null\)/)
})

test('an aborted gesture does not write', () => {
  // One handler is registered for pointerup AND pointercancel. A cancel is the
  // OS taking the gesture away -- a touch/pen takeover, a window-manager grab,
  // a context menu -- and it used to commit if the pointer happened to be over
  // a node, opening the confirm for a drag the user never finished.
  assert.match(GRAPH, /const finish = \(e: PointerEvent, commit: boolean\)/)
  assert.match(GRAPH, /if \(commit && over\) linkRef\.current\?\./)
  assert.match(GRAPH, /const onCancel = \(e: PointerEvent\) => finish\(e, false\)/)
  assert.match(GRAPH, /addEventListener\('pointercancel', onCancel\)/)
  assert.doesNotMatch(GRAPH, /addEventListener\('pointercancel', onUp\)/)
})

test('releasing pointer capture cannot throw out of the handler', () => {
  // On pointercancel the pointer is already gone and releasePointerCapture
  // raises NotFoundError. The `?.` guards an undefined method, not a throw, so
  // the rest of the teardown -- the drag pin release, the cursor reset -- would
  // be skipped.
  assert.match(GRAPH, /const release = \(e: PointerEvent\) => \{\s*try \{/)
  assert.doesNotMatch(GRAPH, /^\s*canvas\.releasePointerCapture\?\.\(e\.pointerId\)$/m)
})

test('a failed graph rebuild after a successful write is reported', () => {
  // onAddLink never rejects, so anything arriving here came from getGraph. With
  // no catch it was an unhandled rejection: no edge, no error, and no sign the
  // link had actually been written.
  const at = CANVAS.indexOf('onLinkNotes={')
  const body = CANVAS.slice(at, at + 600)
  assert.match(body, /\.catch\(\(e: unknown\) => setGraphError\(String\(e\)\)\)/)
})
