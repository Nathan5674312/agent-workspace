/**
 * Section 2 review suite — vault pane.
 *
 * Two honest halves, no pretend DOM:
 *
 *  1. BEHAVIOUR. Imports `src/renderer/panes/vault/helpers.ts` directly and
 *     exercises the real functions. Not a re-implementation, not a copy — if
 *     that file changes, these tests change with it.
 *
 *  2. SOURCE INVARIANTS. There is no DOM library here and none may be added, so
 *     React components cannot be rendered. Instead the .tsx sources are read
 *     from disk and checked for the properties that caused real data-loss bugs:
 *     no auto-save of any kind, no buffer stranded inside a component that
 *     unmounts, no dangerouslySetInnerHTML, no node/network escape hatches, no
 *     inline styling, and a d3 simulation that is stopped on unmount.
 *
 *     These are grep-shaped assertions and they are honest about it: they prove
 *     the dangerous constructs are absent, not that the happy path is correct.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MERGE_SEPARATOR,
  collectFolderPaths,
  indexNotesByName,
  isBufferDirty,
  isSaveConflict,
  mergeVersions,
  parseWikilinks,
  resolvableLinks,
  resolveWikilink,
} from '../src/renderer/panes/vault/helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANE = join(HERE, '..', 'src', 'renderer', 'panes', 'vault')

const FILES = readdirSync(PANE).filter((f) => /\.tsx?$/.test(f))
const src = (name) => readFileSync(join(PANE, name), 'utf8')
const all = () => FILES.map((f) => [f, src(f)])

/** Strip line and block comments so prose about a hazard is not mistaken for it. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// --------------------------------------------------------------- structure

test('every component named in the brief exists', () => {
  const required = [
    'VaultPane.tsx',
    'useVault.ts',
    'LeftRibbon.tsx',
    'ExplorerHeader.tsx',
    'FolderTree.tsx',
    'VaultSwitcher.tsx',
    'TabBar.tsx',
    'MainCanvas.tsx',
    'Editor.tsx',
    'GraphView.tsx',
    'ConflictDialog.tsx',
  ]
  for (const f of required) assert.ok(FILES.includes(f), `missing ${f}`)
})

test('left ribbon carries all eight views', () => {
  const code = src('LeftRibbon.tsx')
  for (const id of [
    'files',
    'search',
    'bookmarks',
    'graph',
    'canvas',
    'calendar',
    'terminal',
    'plugins',
  ]) {
    assert.match(code, new RegExp(`id: '${id}'`), `ribbon missing ${id}`)
  }
})

test('explorer header exposes new note, new folder, sort, collapse, expand', () => {
  const code = src('ExplorerHeader.tsx')
  for (const hook of ['onNewNote', 'onNewFolder', 'onCollapse', 'onExpand']) {
    assert.ok(code.includes(hook), `explorer header missing ${hook}`)
  }
  assert.match(code, /vault-sort-select/, 'explorer header missing sort control')
})

test('tab bar has named tabs, new tab, chevron and split', () => {
  const code = src('TabBar.tsx')
  assert.match(code, /vault-new-tab/)
  assert.match(code, /vault-tab-chevron/, 'tab-list chevron missing')
  assert.match(code, /vault-tab-split/, 'split control missing')
  assert.match(code, /tabs\.map/, 'tabs are not rendered from the tab list')
})

test('vault switcher is the bottom row: name, help, settings', () => {
  const code = src('VaultSwitcher.tsx')
  assert.match(code, /vault-name/)
  assert.ok(code.includes('onHelp'))
  assert.ok(code.includes('onSettings'))
})

test('backlinks and wikilinks are wired, not just mentioned', () => {
  assert.match(src('useVault.ts'), /backlinks/)
  assert.match(
    src('VaultPane.tsx'),
    /getBacklinks\(/,
    'useVault exposes backlinks but the pane never calls it',
  )
  assert.match(src('Editor.tsx'), /parseWikilinks\(/)
  assert.match(src('Editor.tsx'), /vault-editor-backlinks/)
})

// ------------------------------------------------- the v1 cut is not exceeded

test('v1 cut respected: no CodeMirror, live preview, canvas doc, or plugin API', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    assert.doesNotMatch(body, /codemirror|prosemirror|monaco/i, name)
    assert.doesNotMatch(body, /livePreview|live-preview/i, name)
    assert.doesNotMatch(body, /registerPlugin|pluginApi|loadPlugin/i, name)
    assert.doesNotMatch(body, /remark-|rehype-|markdown-it/i, name)
    assert.doesNotMatch(body, /^import[^\n]*\bmarked\b/m, name)
  }
})

test('the editor is a plain textarea', () => {
  const code = src('Editor.tsx')
  assert.match(code, /<textarea/)
  assert.match(code, /className="vault-editor-textarea"/)
})

// ------------------------------------------- renderer sandbox is not escaped

test('no node, electron or network access anywhere in the pane', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    assert.doesNotMatch(body, /\bfetch\s*\(/, `${name} calls fetch`)
    assert.doesNotMatch(body, /\brequire\s*\(/, `${name} calls require`)
    assert.doesNotMatch(body, /\bXMLHttpRequest\b/, `${name} uses XHR`)
    assert.doesNotMatch(body, /\bWebSocket\b/, `${name} opens a socket`)
    assert.doesNotMatch(body, /from\s+['"]electron['"]/, `${name} imports electron`)
    assert.doesNotMatch(body, /from\s+['"]node:/, `${name} imports a node builtin`)
    assert.doesNotMatch(body, /\bipcRenderer\b/, `${name} touches ipcRenderer`)
    assert.doesNotMatch(body, /\bprocess\./, `${name} touches process`)
  }
})

test('all vault IPC goes through window.api.vault', () => {
  for (const [name, code] of all()) {
    for (const m of stripComments(code).matchAll(/window\.api\.(\w+)/g)) {
      assert.equal(m[1], 'vault', `${name} reaches into window.api.${m[1]}`)
    }
  }
})

test('the graph is read-only — the pane never writes the index', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    assert.doesNotMatch(body, /setGraph\s*\([^)]*save/i, name)
    // graph() takes no arguments; a call with one would mean a write attempt.
    assert.doesNotMatch(body, /vault\.graph\s*\(\s*[^)\s]/, `${name} passes data to graph()`)
  }
})

// ------------------------------------------------------------ no styling

test('no inline style props, no CSS colours, no stylesheet imports', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    assert.doesNotMatch(body, /style=\{\{/, `${name} has an inline style object`)
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${name} has a hex colour`)
    assert.doesNotMatch(body, /\brgba?\(|\bhsla?\(/, `${name} has a CSS colour function`)
    assert.doesNotMatch(body, /from\s+['"][^'"]+\.css['"]/, `${name} imports CSS`)
    assert.doesNotMatch(
      body,
      /(background|padding|margin|fontSize|fontFamily|color)\s*:\s*['"]/,
      `${name} sets a style property`,
    )
  }
})

// ------------------------------------------------------------------- XSS

test('note text is never injected as HTML', () => {
  for (const [name, code] of all()) {
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/, name)
    assert.doesNotMatch(stripComments(code), /\.innerHTML\b/, name)
    assert.doesNotMatch(stripComments(code), /document\.write/, name)
  }
})

// ------------------------------------------------- SAVE PATH / DATA LOSS

test('HARD FAIL GUARD: no auto-save, debounce, blur-save or unmount-save', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    assert.doesNotMatch(body, /setInterval\s*\(/, `${name} has an interval`)
    assert.doesNotMatch(body, /setTimeout\s*\(/, `${name} has a timer`)
    assert.doesNotMatch(body, /requestIdleCallback/, name)
    assert.doesNotMatch(body, /\bdebounce\b|\bthrottle\b/i, name)
    assert.doesNotMatch(body, /onBlur\s*=/, `${name} saves on blur`)
    assert.doesNotMatch(body, /beforeunload|visibilitychange|pagehide/, name)
  }
})

test('the only call to onSave is the Save button click', () => {
  const body = stripComments(src('Editor.tsx'))
  const calls = [...body.matchAll(/\bonSave\s*\(/g)]
  assert.equal(calls.length, 1, 'onSave is invoked from more than one place')
  assert.match(body, /await onSave\(text, note\.mtime\)/)
  assert.match(body, /onClick=\{handleSave\}/, 'save is not click-driven')
  // handleSave must not be reachable from an effect.
  assert.doesNotMatch(body, /useEffect\([\s\S]*handleSave/, 'save runs from an effect')
})

test('SaveConflict is caught in the editor and does not surface as a raw error', () => {
  const body = stripComments(src('Editor.tsx'))
  assert.match(body, /if \(isSaveConflict\(message\)\)/, 'SaveConflict is not detected')
  assert.match(
    body,
    /window\.api\.vault\.read\(note\.path\)/,
    'conflict path never re-reads the disk version',
  )
  assert.match(body, /onConflict\(diskNote\.mtime, diskNote\.text\)/)
  // The buffer must not be reset anywhere in the catch.
  assert.doesNotMatch(body, /catch[\s\S]{0,400}onTextChange\(/, 'catch clobbers the buffer')
})

test('the edit buffer is owned above the editor, so unmounting cannot drop it', () => {
  const editor = stripComments(src('Editor.tsx'))
  assert.doesNotMatch(
    editor,
    /useState[^\n]*\(\s*''\s*\)[^\n]*\/\/?\s*text|const \[text, setText\]/,
    'the editor holds the buffer in local state',
  )
  assert.match(editor, /text: string/, 'the editor does not take text as a prop')
  assert.match(editor, /onTextChange/, 'the editor cannot report edits upward')

  const pane = stripComments(src('VaultPane.tsx'))
  assert.match(pane, /const \[buffer, setBuffer\]/, 'VaultPane does not own the buffer')
  assert.match(
    src('MainCanvas.tsx'),
    /onTextChange=\{onTextChange\}/,
    'the canvas does not thread the buffer through',
  )
})

/**
 * The dirty/conflict guards live in `loadNote`, the single loader that every
 * navigation entry point routes through. These tests slice the whole navigation
 * region rather than one function, because which function holds the guard is an
 * implementation detail — that it cannot be bypassed is not.
 */
function navRegion() {
  const pane = stripComments(src('VaultPane.tsx'))
  const start = pane.indexOf('const loadNote')
  const end = pane.indexOf('const handleOpenWikilink')
  assert.ok(start >= 0 && end > start, 'navigation region not found')
  return pane.slice(start, end)
}

test('switching notes with unsaved edits requires an explicit confirmation', () => {
  const nav = navRegion()
  assert.match(nav, /if \(isDirty\)/, 'note switch does not check the dirty flag')
  assert.match(nav, /window\.confirm\(/, 'note switch drops the buffer silently')
  assert.match(nav, /if \(!ok\) return/, 'the confirmation result is ignored')
})

test('every navigation entry point routes through the guarded loader', () => {
  const nav = navRegion()
  // Only loadNote may read a note. If openNote/goBack/goForward could call
  // vault.readNote directly they would skip the dirty and conflict guards
  // entirely — which is exactly the bug this whole region exists to prevent.
  const reads = nav.match(/readNote\(/g) ?? []
  assert.equal(reads.length, 1, 'more than one place reads a note; a guard can be bypassed')

  for (const fn of ['const openNote', 'const goBack', 'const goForward']) {
    const i = nav.indexOf(fn)
    assert.ok(i >= 0, `${fn} not found`)
    const body = nav.slice(i, i + 320)
    assert.match(body, /loadNote\(/, `${fn} does not go through loadNote`)
  }
})

test('an open conflict cannot be dismissed by navigating away', () => {
  const nav = navRegion()
  assert.match(nav, /if \(conflictOpen\) return/, 'opening a note closes the conflict dialog')

  const dialog = stripComments(src('ConflictDialog.tsx'))
  assert.doesNotMatch(dialog, /onCancel|onClose|onDismiss/, 'the dialog has an escape hatch')
  for (const handler of ['onKeepBuffer', 'onKeepDisk', 'onMerge']) {
    assert.ok(dialog.includes(handler), `dialog missing ${handler}`)
  }
})

test('force-overwrite is double-gated and preserves the losing side', () => {
  const pane = stripComments(src('VaultPane.tsx'))
  const keep = pane.slice(
    pane.indexOf('const handleKeepBuffer'),
    pane.indexOf('const handleKeepDisk'),
  )
  assert.ok(keep.length > 0, 'handleKeepBuffer not found')
  assert.match(keep, /window\.confirm\(/, 'force overwrite is a single reflex click')
  assert.match(keep, /if \(!ok\) return/)
  assert.match(keep, /setDiscarded\(/, 'the overwritten disk text is not preserved')
  // It must write the LIVE buffer, never a snapshot captured at conflict time.
  assert.match(keep, /saveNote\(\s*selectedNote\.path,\s*buffer,/)

  const disk = pane.slice(pane.indexOf('const handleKeepDisk'), pane.indexOf('const handleMerge'))
  assert.match(disk, /setDiscarded\(/, 'the discarded buffer is not preserved')
})

test('the conflict dialog reads the live buffer, not a stale snapshot', () => {
  const pane = stripComments(src('VaultPane.tsx'))
  assert.match(pane, /bufferText=\{buffer\}/, 'dialog is fed a snapshot')
  assert.doesNotMatch(
    pane,
    /bufferText:\s*selectedNote/,
    'dialog is fed the pre-edit text loaded from disk',
  )
})

test('a successful save does not silently revert keystrokes made during it', () => {
  const pane = stripComments(src('VaultPane.tsx'))
  const save = pane.slice(pane.indexOf('const handleSave'), pane.indexOf('const handleConflict'))
  assert.doesNotMatch(save, /setBuffer\(/, 'save overwrites the live buffer')
  assert.doesNotMatch(save, /readNote\(/, 're-reading after save clobbers in-flight edits')
})

// -------------------------------------------------- effects and simulations

test('d3 simulation is stopped on unmount and the effect cleans up', () => {
  const code = stripComments(src('GraphView.tsx'))
  assert.match(code, /return \(\) => \{[\s\S]*?sim\.stop\(\)[\s\S]*?\}/, 'sim.stop() missing')
  assert.match(code, /\}, \[graph\]\)/, 'the effect is not keyed on the graph')

  // This used to assert requestAnimationFrame was ABSENT, which was a fine
  // proxy when the canvas only painted on simulation ticks. The graph now
  // needs its own loop so that hover, drag and zoom keep repainting after the
  // layout cools. The real invariant was never "no rAF" — it is "no rAF that
  // outlives the effect", so check for the cancel instead of banning the loop.
  if (/requestAnimationFrame/.test(code)) {
    assert.match(
      code,
      /return \(\) => \{[\s\S]*?cancelAnimationFrame\([\s\S]*?\}/,
      'a requestAnimationFrame loop is never cancelled on unmount',
    )
  }

  // Same class of leak: a ResizeObserver that is never disconnected keeps the
  // canvas and its whole closure alive after the pane is gone.
  if (/new ResizeObserver/.test(code)) {
    assert.match(
      code,
      /return \(\) => \{[\s\S]*?\.disconnect\(\)[\s\S]*?\}/,
      'a ResizeObserver is never disconnected on unmount',
    )
  }
})

test('async effects are cancellable so late responses cannot overwrite state', () => {
  for (const name of ['useVault.ts', 'VaultPane.tsx']) {
    const code = stripComments(src(name))
    for (const m of code.matchAll(/useEffect\(/g)) {
      void m
    }
    assert.match(code, /let cancelled = false/, `${name} has an uncancellable effect`)
    assert.match(code, /cancelled = true/, `${name} never sets the cancel flag`)
  }
})

// --------------------------------------------- expand / collapse correctness

test('tree expansion is controlled, so expand-all and collapse-all actually fire', () => {
  const tree = stripComments(src('FolderTree.tsx'))
  assert.doesNotMatch(tree, /useState/, 'FolderTree still seeds expansion once on mount')
  assert.match(tree, /expanded: Set<string>/)
  assert.match(tree, /onToggle/)

  const pane = stripComments(src('VaultPane.tsx'))
  assert.match(pane, /setExpanded\(new Set\(collectFolderPaths\(vault\.tree\)\)\)/)
  assert.match(pane, /setExpanded\(new Set\(\)\)/)
})

test('no undeclared identifiers in the pane (every used local is bound)', () => {
  // Cheap structural proxy for the "referenced identifiers it never declared"
  // regression: the state names threaded into JSX must all be declared.
  const pane = src('VaultPane.tsx')
  for (const name of [
    'buffer',
    'expanded',
    'conflictOpen',
    'conflictData',
    'discarded',
    'selectedNote',
    'backlinks',
    'isDirty',
  ]) {
    assert.match(
      pane,
      new RegExp(`const \\[?${name}\\b|const ${name} =`),
      `${name} is used but never declared`,
    )
  }
  assert.doesNotMatch(pane, /\btreeMode\b/, 'dead treeMode state left behind')
})

// ------------------------------------------------------- helper behaviour

test('collectFolderPaths includes the root and walks in vault order', () => {
  const tree = {
    name: 'Universal Vault',
    path: '',
    kind: 'folder',
    children: [
      {
        name: 'Business',
        path: 'Business',
        kind: 'folder',
        children: [
          { name: 'Deep', path: 'Business/Deep', kind: 'folder', children: [] },
          { name: 'A.md', path: 'Business/A.md', kind: 'note' },
        ],
      },
      { name: 'Home.md', path: 'Home.md', kind: 'note' },
    ],
  }
  assert.deepEqual(collectFolderPaths(tree), ['', 'Business', 'Business/Deep'])
  assert.deepEqual(collectFolderPaths(null), [])
})

test('collectFolderPaths keeps the root so expand-all can open the top level', () => {
  const tree = { name: 'V', path: '', kind: 'folder', children: [] }
  assert.ok(
    collectFolderPaths(tree).includes(''),
    'root path dropped — expand-all would leave the tree collapsed',
  )
})

test('parseWikilinks: plain, aliased, headed, deduped, ordered', () => {
  assert.deepEqual(parseWikilinks('see [[Home]] and [[Projects/AI]]'), [
    'Home',
    'Projects/AI',
  ])
  assert.deepEqual(parseWikilinks('[[Home|the home note]]'), ['Home'])
  assert.deepEqual(parseWikilinks('[[Home#Section]]'), ['Home'])
  assert.deepEqual(parseWikilinks('[[Home]] [[Home]] [[home]]'), ['Home', 'home'])
  assert.deepEqual(parseWikilinks('no links here'), [])
  assert.deepEqual(parseWikilinks('[[]] [[   ]]'), [])
  assert.deepEqual(parseWikilinks('[single] [[Real]]'), ['Real'])
})

test('wikilink resolution is case-insensitive and extension-tolerant', () => {
  const tree = {
    name: 'V',
    path: '',
    kind: 'folder',
    children: [
      { name: 'Home.md', path: 'Home.md', kind: 'note' },
      {
        name: 'Projects',
        path: 'Projects',
        kind: 'folder',
        children: [{ name: 'AI.md', path: 'Projects/AI.md', kind: 'note' }],
      },
    ],
  }
  const index = indexNotesByName(tree)
  assert.equal(resolveWikilink('Home', index), 'Home.md')
  assert.equal(resolveWikilink('home', index), 'Home.md')
  assert.equal(resolveWikilink('  HOME.md  ', index), 'Home.md')
  assert.equal(resolveWikilink('AI', index), 'Projects/AI.md')
  assert.equal(resolveWikilink('Nope', index), null)
})

test('MERGE INVARIANT: merge cannot drop either side', () => {
  const cases = [
    ['mine', 'theirs'],
    ['', 'theirs'],
    ['mine', ''],
    ['', ''],
    ['line\nline2\n', '\n\ntrailing'],
    ['emoji 🧠 and ünïcode', 'tabs\tand\r\ncrlf'],
    ['x'.repeat(50_000), 'y'.repeat(50_000)],
    [MERGE_SEPARATOR, MERGE_SEPARATOR],
    ['[[wikilink]]', '# heading\n---\n'],
  ]
  for (const [mine, theirs] of cases) {
    const merged = mergeVersions(mine, theirs)
    assert.ok(merged.includes(mine), 'buffer side lost')
    assert.ok(merged.includes(theirs), 'disk side lost')
    assert.equal(merged.length, mine.length + MERGE_SEPARATOR.length + theirs.length)
    assert.equal(merged.indexOf(mine), 0)
    assert.ok(merged.endsWith(theirs))
  }
})

test('merge is not lossy even when one side is a prefix of the other', () => {
  const merged = mergeVersions('abc', 'abcdef')
  assert.ok(merged.startsWith('abc'))
  assert.ok(merged.endsWith('abcdef'))
  assert.notEqual(merged, 'abcdef')
  assert.notEqual(merged, 'abc')
})

test('isBufferDirty: exact comparison, no trimming', () => {
  assert.equal(isBufferDirty('a', 'a'), false)
  assert.equal(isBufferDirty('a', 'a '), true)
  assert.equal(isBufferDirty('a\n', 'a'), true)
  assert.equal(isBufferDirty('', ''), false)
  assert.equal(isBufferDirty(null, 'anything'), false)
})

test('the merge separator is distinctive enough to find afterwards', () => {
  assert.ok(MERGE_SEPARATOR.length > 10)
  assert.ok(MERGE_SEPARATOR.includes('<<<<<<<'))
  assert.ok(MERGE_SEPARATOR.includes('>>>>>>>'))
})

// ================================================================= round two
// Findings from the second review pass. Each test below has a defect behind it.

// --- HIGH: an in-flight save raced a note switch and cross-wrote two notes ---

test('REGRESSION: a save landing after a note switch cannot re-adopt the old note', () => {
  const pane = stripComments(src('VaultPane.tsx'))
  const save = pane.slice(
    pane.indexOf('const handleSave'),
    pane.indexOf('const handleConflict'),
  )
  assert.ok(save.length > 0, 'handleSave not found')

  // The bug: `setSelectedNote({ ...selectedNote, ... })` after an await. The
  // spread uses the note captured when the closure was built, so a save that
  // resolves after the user opened note B put note A's identity back on screen
  // underneath B's buffer — and the next Save wrote B's text into A.
  assert.doesNotMatch(
    save,
    /setSelectedNote\(\s*\{\s*\.\.\.selectedNote/,
    'post-save update spreads the captured note instead of the current one',
  )
  assert.match(
    save,
    /setSelectedNote\(\s*\(prev\)\s*=>/,
    'post-save update is not a functional state update',
  )
  assert.match(
    save,
    /prev\.path === target\.path/,
    'post-save update does not check it is still on the same note',
  )
  // The write itself must still target the note the user pressed Save on.
  assert.match(save, /vault\.saveNote\(target\.path, text, mtime\)/)
})

test('every await inside handleSave is followed by an identity check, not a blind write', () => {
  const pane = stripComments(src('VaultPane.tsx'))
  const save = pane.slice(
    pane.indexOf('const handleSave'),
    pane.indexOf('const handleConflict'),
  )
  const afterAwait = save.slice(save.indexOf('await'))
  // Nothing after the await may touch the buffer, and the only state write is
  // the guarded setSelectedNote.
  assert.doesNotMatch(afterAwait, /setBuffer\(/, 'save writes the live buffer back')
  const writes = [...afterAwait.matchAll(/set[A-Z]\w*\(/g)].map((m) => m[0])
  assert.deepEqual(writes, ['setSelectedNote('], `unexpected state writes: ${writes}`)
})

// --- MEDIUM: conflict resolution failed into console.error alone ---

test('a conflict choice that fails to save says so instead of doing nothing', () => {
  const pane = stripComments(src('VaultPane.tsx'))
  assert.match(pane, /const \[conflictError, setConflictError\]/, 'no conflict error state')

  for (const [name, next] of [
    ['const handleKeepBuffer', 'const handleKeepDisk'],
    ['const handleMerge', 'const handleNewNote'],
  ]) {
    const block = pane.slice(pane.indexOf(name), pane.indexOf(next))
    assert.ok(block.length > 0, `${name} not found`)
    const katch = block.slice(block.indexOf('catch'))
    assert.match(katch, /setConflictError\(/, `${name} fails silently`)
    assert.doesNotMatch(
      katch,
      /console\.error/,
      `${name} reports failure only to the console`,
    )
    // A failed resolution must leave the dialog open and both versions alive.
    assert.doesNotMatch(katch, /setConflictOpen\(false\)/, `${name} closes on failure`)
    assert.doesNotMatch(katch, /setConflictData\(null\)/, `${name} drops the disk text`)
    assert.doesNotMatch(katch, /setBuffer\(/, `${name} touches the buffer on failure`)
  }

  const dialog = stripComments(src('ConflictDialog.tsx'))
  assert.match(dialog, /error: string \| null/, 'the dialog cannot show an error')
  assert.match(dialog, /\{error &&/, 'the dialog never renders the error')
  assert.match(pane, /error=\{conflictError\}/, 'the error is never passed down')
})

// --- MEDIUM: a dangling graph edge crashed the root and took the buffer ---

test('resolvableLinks drops edges d3 cannot resolve, keeps the ones it can', () => {
  const nodes = ['A.md', 'B.md']
  assert.deepEqual(
    resolvableLinks(nodes, [
      { from: 'A.md', to: 'B.md' },
      { from: 'A.md', to: 'Ghost.md' },
      { from: 'Ghost.md', to: 'B.md' },
      { from: 'Ghost.md', to: 'Other.md' },
    ]),
    [{ source: 'A.md', target: 'B.md' }],
  )
  assert.deepEqual(resolvableLinks([], [{ from: 'A.md', to: 'B.md' }]), [])
  assert.deepEqual(resolvableLinks(nodes, []), [])
  // Self-links are d3-resolvable and are not this function's business to judge.
  assert.deepEqual(resolvableLinks(nodes, [{ from: 'A.md', to: 'A.md' }]), [
    { source: 'A.md', target: 'A.md' },
  ])
  // Order and duplicates are preserved — filtering must not dedupe silently.
  assert.equal(
    resolvableLinks(nodes, [
      { from: 'A.md', to: 'B.md' },
      { from: 'A.md', to: 'B.md' },
    ]).length,
    2,
  )
})

test('PROOF: d3 really does throw on a dangling edge, and resolvableLinks stops it', async () => {
  // Not a claim about d3 — the real library, the real call GraphView makes.
  // d3-force is pure JS and needs no DOM, so this runs here honestly.
  const d3 = await import('d3-force')
  const graph = {
    nodes: ['A.md', 'B.md'],
    links: [
      { from: 'A.md', to: 'B.md' },
      { from: 'A.md', to: 'Ghost.md' },
    ],
  }
  const build = (links) =>
    d3
      .forceSimulation(graph.nodes.map((id) => ({ id })))
      .force('link', d3.forceLink(links).id((d) => d.id))
      .stop()

  // The old code path: raw edges straight into forceLink.
  assert.throws(
    () => build(graph.links.map((l) => ({ source: l.from, target: l.to }))),
    /node not found/,
    'd3 tolerates dangling edges now — this guard may be redundant',
  )

  // The shipped path: no throw, and the good edge survives.
  const safe = resolvableLinks(graph.nodes, graph.links)
  const sim = build(safe)
  assert.equal(safe.length, 1)
  assert.equal(safe[0].source.id ?? safe[0].source, 'A.md')
  assert.equal(safe[0].target.id ?? safe[0].target, 'B.md')
  sim.stop()
})

test('GraphView never hands raw graph.links to d3', () => {
  const code = stripComments(src('GraphView.tsx'))
  assert.match(code, /resolvableLinks\(graph\.nodes, graph\.links\)/)
  assert.doesNotMatch(
    code,
    /graph\.links\.map\(/,
    'raw edges reach forceLink and an unresolvable one throws out of the effect',
  )
  assert.match(code, /forceLink</, 'the guard is guarding nothing')
})

// --- LOW/hardening: conflict detection survives Electron's error stringifying ---

test('isSaveConflict recognises the conflict however Electron stringifies it', () => {
  // What `String(e)` actually yields in the renderer for each plausible shape.
  const conflicts = [
    "Error: Error invoking remote method 'vault:save': SaveConflict: Note changed on disk since you opened it.",
    "Error: Error invoking remote method 'vault:save': Error: Note changed on disk since you opened it.",
    'SaveConflict: Note changed on disk since you opened it.',
    'Note changed on disk since you opened it.',
  ]
  for (const m of conflicts) assert.equal(isSaveConflict(m), true, m)

  const notConflicts = [
    "Error: Error invoking remote method 'vault:save': VaultUnavailable: Vault server is not running on 127.0.0.1:8765.",
    'Error: vault: unreadable response from /save',
    'Error: ipc: refused call from a subframe',
    'Error: 500 /save',
    '',
  ]
  for (const m of notConflicts) assert.equal(isSaveConflict(m), false, m)
})

test('the conflict branch is the ONLY branch that can reach onConflict', () => {
  const body = stripComments(src('Editor.tsx'))
  assert.equal([...body.matchAll(/onConflict\(/g)].length, 1)
  // And the non-conflict branch must surface the error rather than eat it.
  assert.match(body, /else \{\s*setError\(message\)/)
  assert.doesNotMatch(body, /catch[\s\S]{0,300}console\.(error|log)/, 'save errors go to the console')
})

// --- standing invariants that must survive the round-two edits ---

test('the pane still holds no timers of any kind after the round-two fixes', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    assert.doesNotMatch(body, /setInterval|setTimeout|queueMicrotask/, `${name} gained a timer`)
  }
})

test('helpers.ts stays pure: no React, no DOM, no node, no window', () => {
  const body = stripComments(src('helpers.ts'))
  assert.doesNotMatch(body, /from ['"]react['"]/, 'helpers imports React')
  assert.doesNotMatch(body, /\bdocument\.|\bwindow\./, 'helpers touches the DOM')
  assert.doesNotMatch(body, /from ['"]node:/, 'helpers imports a node builtin')
  // Type-only import of the contract is fine; a value import is not.
  for (const m of body.matchAll(/^import (?!type )/gm)) {
    assert.fail(`helpers has a value import: ${m[0]}`)
  }
})

test('the conflict dialog still has no escape hatch after gaining an error prop', () => {
  const dialog = stripComments(src('ConflictDialog.tsx'))
  assert.doesNotMatch(dialog, /onCancel|onClose|onDismiss|onEscape/, 'dialog can be dismissed')
  assert.doesNotMatch(dialog, /onClick=\{[^}]*\bclose\b/i, 'dialog has a close click')
  // The overlay must not close the dialog when clicked.
  assert.doesNotMatch(dialog, /vault-conflict-dialog-overlay"\s*onClick/, 'backdrop dismisses')
})
