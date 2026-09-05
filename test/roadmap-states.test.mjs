/**
 * The roadmap pane's state vocabulary.
 *
 * Worth a test because two things here are easy to get subtly wrong and
 * impossible to notice from the UI: an unrecognised status quietly becoming a
 * real state (a lie that sorts), and a partial label object blanking the labels
 * it does not mention.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_STATE_LABELS,
  STATE_ORDER,
  labelOf,
  stateOf,
  stateRank,
} from '../src/shared/roadmapStates.ts'

test('the four states are in progress order, not alphabetical', () => {
  assert.deepEqual(STATE_ORDER, ['idea', 'partial', 'complete', 'done'])
  // Rank is the sort key, so it must follow the array rather than repeat it.
  for (let i = 0; i < STATE_ORDER.length; i++) {
    assert.equal(stateRank(STATE_ORDER[i]), i)
  }
})

test('an unrecognised status stays unrecognised', () => {
  // The failure this prevents: coercing `blocked` to `idea` so it sorts. The
  // row is still shown, it just keeps its own word.
  assert.equal(stateOf('blocked'), null)
  assert.equal(stateOf(''), null)
  assert.equal(stateOf('   '), null)
  // And it sorts after everything known, so a typo is visible at the bottom
  // rather than looking deliberate at the top.
  assert.equal(stateRank(null), STATE_ORDER.length)
  for (const s of STATE_ORDER) assert.ok(stateRank(s) < stateRank(null))
})

test('status matching ignores case and surrounding space', () => {
  assert.equal(stateOf('  Complete '), 'complete')
  assert.equal(stateOf('IN PROGRESS'), 'partial')
})

test('the app roadmap vocabulary and the vault one meet', () => {
  // src/shared/roadmap.ts grades code with built/partial/planned. A vault note
  // written in those words must land somewhere sensible rather than nowhere.
  assert.equal(stateOf('built'), 'complete')
  assert.equal(stateOf('partial'), 'partial')
  assert.equal(stateOf('planned'), 'idea')
})

test('renaming one state leaves the other three alone', () => {
  // The bug this is here for: `labels ?? DEFAULTS` blanks every key the stored
  // object does not mention, so renaming Idea would empty Partial.
  const labels = { idea: 'Backlog' }
  assert.equal(labelOf('idea', labels), 'Backlog')
  assert.equal(labelOf('partial', labels), DEFAULT_STATE_LABELS.partial)
  assert.equal(labelOf('done', labels), DEFAULT_STATE_LABELS.done)
})

test('a blank or absent vocabulary falls back rather than rendering empty', () => {
  assert.equal(labelOf('complete', null), 'Complete')
  assert.equal(labelOf('complete', undefined), 'Complete')
  assert.equal(labelOf('complete', { complete: '   ' }), 'Complete')
})
