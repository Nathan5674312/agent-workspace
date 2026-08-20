/**
 * Read a renderer source file for assertion, WITH ITS COMMENTS REMOVED.
 *
 * The canvas suites assert against the text of `CanvasView.tsx` because the
 * component cannot be imported by `node --test` — it is JSX and it imports a
 * stylesheet. That is a real constraint, but it had a hole: the assertions were
 * matching the raw file, so a doc comment counted as evidence.
 *
 * Two assertions were passing on prose alone. `CanvasView.tsx` contains the
 * sentence "`canvasId()` and `NEW_TEXT_SIZE` come from shared/canvas.ts", so
 * the tests named "the view invents its own ids" and "the view hardcodes a card
 * size" passed against a view that did exactly those things, as long as the
 * paragraph survived. Every `assert.doesNotMatch` had the mirror-image hole:
 * writing a comment ABOUT a hazard was enough to trip a ban on it.
 *
 * So all of them read through here now. A comment can no longer be evidence.
 *
 * The line-comment pattern refuses a `//` preceded by `:` so that a `https://`
 * inside a string is not mistaken for the start of a comment.
 */
import { readFileSync } from 'node:fs'

export const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')

/** A file under src/renderer/panes/vault/, comments stripped. */
export const readSource = (name) =>
  stripComments(readFileSync(new URL(`../../src/renderer/panes/vault/${name}`, import.meta.url), 'utf8'))

/** The same file with comments intact, for the rare assertion that wants them. */
export const readRaw = (name) =>
  readFileSync(new URL(`../../src/renderer/panes/vault/${name}`, import.meta.url), 'utf8')
