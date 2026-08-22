/**
 * A card and the board must not share a cursor.
 *
 * Dragging a CARD moves that one card. Dragging the BOARD pans the view, which
 * slides every card at once. Those are entirely different outcomes from the
 * same gesture, and which one you get depends only on whether the pointer
 * happened to be over a card or over the gap beside it.
 *
 * While both were `cursor: grab` there was no way to tell them apart before
 * pressing, and pressing the gap read as "I grabbed one card and they all
 * moved". Nathan reported exactly that. The cursor is the only signal available
 * at that moment, so the two have to differ.
 *
 * Pure source read of the stylesheet. No DOM.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readSource } from './fixtures/source.mjs'

const CSS = readSource('canvas.css')

/** The declared `cursor` inside a rule, by selector. */
const cursorIn = (selector) => {
  const at = CSS.indexOf(selector)
  if (at < 0) return null
  const open = CSS.indexOf('{', at)
  const close = CSS.indexOf('}', open)
  const body = CSS.slice(open, close)
  const m = body.match(/cursor:\s*([a-z-]+)/)
  return m ? m[1] : null
}

test('the board is grab, because dragging it pans the view', () => {
  assert.equal(cursorIn('.canvas-surface {'), 'grab')
})

test('a card is not grab, because dragging it moves one card', () => {
  const card = cursorIn('.canvas-node {')
  assert.ok(card, 'the card rule no longer declares a cursor')
  assert.notEqual(card, 'grab', 'a card and the board are indistinguishable again')
  assert.equal(card, 'move')
})

test('the two cursors actually differ', () => {
  // The property, stated once, independent of which values are chosen. If both
  // are ever set to the same thing again this fails whatever that thing is.
  assert.notEqual(
    cursorIn('.canvas-node {'),
    cursorIn('.canvas-surface {'),
    'a card and the board look identical to the pointer',
  )
})

test('the resize grip has its own cursor, distinct from both', () => {
  // A third outcome from the same press: resize one card. It gets the corner
  // arrow, so all three gestures are legible before they are committed to.
  const grip = cursorIn('.canvas-resize {')
  assert.equal(grip, 'nwse-resize')
  assert.notEqual(grip, cursorIn('.canvas-node {'))
  assert.notEqual(grip, cursorIn('.canvas-surface {'))
})
