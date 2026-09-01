/**
 * `Templates/` discovery.
 *
 * Pure, so it is unit-tested against trees built here and then against the
 * REAL vault at the bottom — the same shape `wikilink-write.test.mjs` uses, and
 * for the same reason: the rules in `templates.ts` were read off this vault, so
 * a test that only sees invented trees cannot tell if that reading was right.
 */
import './fixtures/ts-hooks.mjs'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { listTemplates, TEMPLATE_DIR } from '../src/shared/templates.ts'

const tree = (children) => ({ name: 'vault', path: '', kind: 'folder', children })
const folder = (path, children) => ({
  name: path.split('/').pop(),
  path,
  kind: 'folder',
  children,
})
const note = (path) => ({ name: path.split('/').pop(), path, kind: 'note' })

test('templates come back as name and path, extension stripped', () => {
  const t = listTemplates(
    tree([folder(TEMPLATE_DIR, [note('Templates/Project.md'), note('Templates/Decision Log.md')])]),
  )
  assert.deepEqual(t, [
    { name: 'Project', path: 'Templates/Project.md' },
    { name: 'Decision Log', path: 'Templates/Decision Log.md' },
  ])
})

test('tree order is kept, because the main process already sorted it', () => {
  const t = listTemplates(
    tree([folder(TEMPLATE_DIR, [note('Templates/Zeta.md'), note('Templates/Alpha.md')])]),
  )
  assert.deepEqual(t.map((x) => x.name), ['Zeta', 'Alpha'])
})

test('an _-prefixed file is a document about the folder, not a template', () => {
  // Templates/_Index.md is real and indexes the folder. Offering it would
  // create a note that is a list of templates.
  const t = listTemplates(
    tree([folder(TEMPLATE_DIR, [note('Templates/_Index.md'), note('Templates/Project.md')])]),
  )
  assert.deepEqual(t.map((x) => x.name), ['Project'])
})

test('only direct children — a nested folder is not flattened into the list', () => {
  const t = listTemplates(
    tree([
      folder(TEMPLATE_DIR, [
        note('Templates/Project.md'),
        folder('Templates/Old', [note('Templates/Old/Retired.md')]),
      ]),
    ]),
  )
  assert.deepEqual(t.map((x) => x.name), ['Project'])
})

test('a canvas in Templates/ is not a note and is not offered', () => {
  // `kind` is checked, not the extension: buildIndex gives .canvas its own kind
  // precisely so it never gets read as markdown.
  const t = listTemplates(
    tree([
      folder(TEMPLATE_DIR, [
        { name: 'Board.canvas', path: 'Templates/Board.canvas', kind: 'canvas' },
        note('Templates/Project.md'),
      ]),
    ]),
  )
  assert.deepEqual(t.map((x) => x.name), ['Project'])
})

test('no Templates/ folder, no templates — and no throw', () => {
  // This is what makes the control absent rather than empty in another vault.
  assert.deepEqual(listTemplates(tree([folder('Daily', [note('Daily/2026-01-01.md')])])), [])
  assert.deepEqual(listTemplates(tree([])), [])
  assert.deepEqual(listTemplates(null), [])
})

test('the folder is matched at the ROOT, not by name at any depth', () => {
  // A nested folder that happens to be called Templates is somebody's notes.
  const t = listTemplates(
    tree([folder('Fate', [folder('Fate/Templates', [note('Fate/Templates/Thing.md')])])]),
  )
  assert.deepEqual(t, [])
})

// ------------------------------------------------------------- the real vault

const VAULT = 'C:/Users/Nathan/Desktop/Universal Vault'
const has = existsSync(join(VAULT, TEMPLATE_DIR))

test('the real Templates/ folder yields templates, and none of them is the index', {
  skip: !has && 'vault not on this machine',
}, () => {
  const entries = readdirSync(join(VAULT, TEMPLATE_DIR), { withFileTypes: true })
  const root = tree([
    folder(
      TEMPLATE_DIR,
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => note(`${TEMPLATE_DIR}/${e.name}`)),
    ),
  ])
  const t = listTemplates(root)
  assert.ok(t.length >= 4, `only ${t.length} templates found`)
  assert.ok(!t.some((x) => x.name.startsWith('_')), '_Index leaked into the list')

  /**
   * THE VERBATIM RULE, checked against the files themselves.
   *
   * Every template here opens with frontmatter. That is the whole reason this
   * module does not reuse `noteFromTemplate` from `daily.ts`: that function
   * splits on the first `---` and keeps the tail, which on these files would
   * drop the opening fence and leave `title:` in the body as prose.
   */
  for (const x of t) {
    const text = readFileSync(join(VAULT, x.path), 'utf-8')
    assert.ok(text.startsWith('---'), `${x.path} does not open with frontmatter`)
  }
  console.log(`      ${t.length} real templates: ${t.map((x) => x.name).join(', ')}`)
})
