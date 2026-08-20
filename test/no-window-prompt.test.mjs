/**
 * `window.prompt` DOES NOT WORK IN ELECTRON, AND NOTHING WARNS YOU.
 *
 * Measured on the Electron 33 binary this app ships, by driving a real
 * BrowserWindow rather than by reading documentation:
 *
 *   typeof window.prompt  -> 'function'
 *   window.prompt('x')    -> throws  prompt() is not supported.
 *   window.confirm('x')   -> opens a real modal and blocks
 *   typeof window.confirm -> 'function'
 *
 * That asymmetry is the entire trap, and it caught "+ Folder". The handler
 * reasoned that a native prompt was an established idiom because this pane
 * already asks with `window.confirm` — but confirm is implemented and prompt
 * never has been. The throw landed on the handler's FIRST line, ahead of its
 * own try/catch, and the call site was `void handleNewFolder()`, so the
 * rejection went nowhere. The button did nothing. Silently. For every user.
 *
 * TypeScript cannot catch this: `lib.dom.d.ts` declares prompt as a function
 * returning `string | null`, which is exactly what the calling code expected.
 * There is no type error, no lint, and no console output unless someone has
 * devtools open. A source-level ban is the only thing that sees it.
 *
 * `confirm` and `alert` are deliberately NOT banned — both work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RENDERER = join(ROOT, 'src/renderer')

/** Every .ts/.tsx under the renderer, recursively. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...sources(abs))
    else if (/\.tsx?$/.test(entry)) out.push(abs)
  }
  return out
}

/** Newlines normalised: core.autocrlf=true means CRLF on disk, and an assertion
 *  spanning a line break silently matches nothing without this. */
const read = (abs) => readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n')

const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('no renderer source calls window.prompt', () => {
  const offenders = []
  for (const abs of sources(RENDERER)) {
    const code = stripComments(read(abs))
    // Both spellings. A bare `prompt(` is the one people reach for when they
    // have already written `confirm(` on the line above.
    if (/\bwindow\s*\.\s*prompt\s*\(/.test(code) || /(^|[^.\w])prompt\s*\(/.test(code)) {
      offenders.push(abs.slice(ROOT.length))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `window.prompt throws "prompt() is not supported." in Electron — the call ` +
      `does nothing and says nothing. Use <NameDialog>. Offenders: ${offenders.join(', ')}`,
  )
})

test('the folder name dialog exists and is what "+ Folder" opens', () => {
  const pane = stripComments(read(join(RENDERER, 'panes/vault/VaultPane.tsx')))

  assert.match(pane, /<NameDialog/, 'the replacement dialog is not rendered')
  assert.match(
    pane,
    /onNewFolder=\{\(\) => setNewFolderOpen\(true\)\}/,
    '"+ Folder" does not open the dialog',
  )
  // The regression in full: a handler that throws before its own try/catch,
  // invoked as a floating promise so nothing ever sees the rejection.
  assert.doesNotMatch(pane, /void handleNewFolder\(\)/, 'the old floating call is back')
})

test('the name dialog refuses a path before anything is created', () => {
  const pane = stripComments(read(join(RENDERER, 'panes/vault/VaultPane.tsx')))
  const dialog = stripComments(read(join(RENDERER, 'panes/vault/NameDialog.tsx')))

  // `../Escaped` typed while Notes/Untitled.md was open resolved to `Escaped`
  // at the vault ROOT. Containment held; the CONTROL promised something
  // narrower than it delivered.
  assert.match(pane, /const folderNameError/, 'the name check is gone')
  assert.match(pane, /validate=\{folderNameError\}/, 'the dialog does not run the check')
  assert.match(dialog, /validate \? validate\(trimmed\)/, 'the dialog ignores its validate prop')
  assert.match(dialog, /disabled=\{!canSubmit\}/, 'an invalid name can still be submitted')
})
