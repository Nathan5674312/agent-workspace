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
  headOf,
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

test('a real status keeps its own word, minus the explanation', () => {
  // The pill shows what the NOTE says, so this is what a reader actually sees.
  // Verbatim from the vault: the state is the first clause, the rest is why.
  // Case is the author's: this is what goes on the pill.
  assert.equal(
    headOf('IN PROGRESS — electron-builder landed `0871a02`, zip artifact builds'),
    'IN PROGRESS',
  )
  assert.equal(headOf('SCOPED — brief written, drafting delegated'), 'SCOPED')
  // ...and matching still works across that case difference.
  assert.equal(stateOf('IN PROGRESS — electron-builder landed `0871a02`'), 'partial')
  // A YAML comment is not part of the status. Verbatim from this vault's own
  // template, where it used to render the instructions onto the pill.
  assert.equal(headOf('idea   # idea | active | paused | abandoned | live'), 'idea')
  assert.equal(stateOf('idea   # idea | active | paused | abandoned | live'), 'idea')
  // A bare hyphen is part of a word, not a separator.
  assert.equal(headOf('north-star'), 'north-star')
  assert.equal(headOf('blocked-on-domain-access'), 'blocked-on-domain-access')
  // And an unrecognised one still reads back whole, because nothing renames it.
  assert.equal(stateOf('blocked-on-domain-access'), null)
})

test('the pipeline summary has a name for every state', () => {
  // The one place the app does the talking: counts across many vocabularies at
  // once, where "48 partial" has to mean the same thing for every row.
  for (const s of STATE_ORDER) {
    assert.equal(typeof DEFAULT_STATE_LABELS[s], 'string')
    assert.ok(DEFAULT_STATE_LABELS[s].length > 0, `${s} has no name`)
  }
})
