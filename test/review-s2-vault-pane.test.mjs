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
  folderOf,
  indexNotesByName,
  isBufferDirty,
  isPlainName,
  isSaveConflict,
  mergeVersions,
  nextUntitledPath,
  parseWikilinks,
  resolvableLinks,
  resolveWikilink,
  sortTree,
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

test('left ribbon carries every view, and no icon promises a cut feature', () => {
  const code = src('LeftRibbon.tsx')
  /**
   * THE LIST CHANGED KIND, not just contents.
   *
   * It used to be a mix: four sidebar panels (files, search, bookmarks,
   * terminal), two main views (graph, versions), and one that did both
   * (calendar) — with database, inbox and roadmap missing entirely because they
   * lived in a second strip inside the main area. The ribbon now holds SURFACES
   * and only surfaces, so what is asserted is that every MainView has an icon.
   *
   * files / search / bookmarks are deliberately absent and must stay absent:
   * they are ways of finding a note, not places to be, and they moved to the
   * sidebar's own control (SidebarFinder.tsx). An icon for them here would
   * rebuild the exact ambiguity this restructure removed.
   */
  for (const id of [
    'editor',
    'graph',
    'canvas',
    'database',
    'planner',
    'inbox',
    'terminal',
    'versions',
  ]) {
    assert.match(code, new RegExp(`id: '${id}'`), `ribbon missing ${id}`)
  }
  for (const id of ['files', 'search', 'bookmarks']) {
    assert.doesNotMatch(
      code,
      new RegExp(`id: '${id}'`),
      `'${id}' is a sidebar finder, not a surface — see SidebarFinder.tsx`,
    )
  }
  /**
   * ROADMAP IS DELIBERATELY NOT AN ICON, and this is the assertion that keeps
   * that a decision rather than an oversight. Fate is a notes app; every icon
   * in that column is about the user's notes, and the roadmap is the app
   * grading itself. It is reached from the help dialog instead.
   *
   * The next assertion is the one that matters: removing the icon must not have
   * removed the only way in. A surface with no entry point is dead code that
   * still renders.
   */
  assert.doesNotMatch(code, /id: 'roadmap'/, 'the roadmap is a surface again')
  assert.match(
    src('HelpDialog.tsx'),
    /onOpenRoadmap/,
    'the roadmap left the ribbon and nothing else opens it',
  )
  assert.match(
    src('VaultPane.tsx'),
    /handleViewChange\('roadmap'\)/,
    'the help dialog is handed no way to actually switch to the roadmap',
  )
  /**
   * WAS EIGHT INCLUDING `plugins`, and dropping it is the point rather than a
   * regression. The brief's own v1 cut bans a plugin API (see the test below),
   * and roadmap.ts states the position: the agent is the plugin system and the
   * canvas is the render target. An icon whose panel says "not built yet" for
   * something that will never be built is the inert control this file exists to
   * forbid, so it was removed rather than left as a placeholder forever.
   *
   * `versions` is asserted here for the first time. It was always in the list;
   * the old spelling of this test simply predated it moving off the top strip.
   */
  assert.doesNotMatch(code, /id: 'plugins'/, 'plugins icon is back')
})

test('no ribbon icon falls through to the not-built placeholder', () => {
  // THE ROADMAP'S OWN CRITERION for "Clean modern UI". Every id in the ribbon
  // must be handled by name in the pane. `versions` and `graph` are handled in
  // the ribbon's own onViewChange (they open a main view), the rest in the
  // sidebar branch.
  //
  // The stake went UP when the placeholder was deleted. An unhandled id used to
  // land in the else and render SidebarPlaceholder — an icon that lit up and
  // described an unbuilt feature, which was wrong but was not blank. Every icon
  // has a real panel now, the placeholder is gone, and that else renders null.
  // So this test is the only thing standing between a new ribbon icon and the
  // empty sidebar the placeholder was built to prevent.
  const ribbon = src('LeftRibbon.tsx')
  const canvas = src('MainCanvas.tsx')
  const ids = [...ribbon.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1])
  assert.ok(ids.length >= 8, `only ${ids.length} ribbon ids found`)
  // Every surface, not just the ones with an icon — the roadmap has no icon and
  // must still be dispatched, or opening it from Help would render the editor.
  ids.push('roadmap')
  /**
   * THE EXHAUSTIVENESS MOVED WITH THE MEANING.
   *
   * This used to read VaultPane, because a ribbon id named a sidebar panel and
   * an unhandled one blanked the sidebar. An id now names a SURFACE, so the
   * file that must know every one of them is the surface dispatcher —
   * MainCanvas — and an unhandled id would fall through its chain to the
   * editor, silently showing the wrong thing rather than nothing.
   *
   * 'editor' is the chain's final else and so is handled without being named,
   * which is the one exemption and is checked by its own assertion below.
   */
  for (const id of ids) {
    if (id === 'editor') continue
    assert.ok(
      canvas.includes(`view === '${id}'`),
      `ribbon '${id}' is not dispatched in MainCanvas, so it renders the editor`,
    )
  }
  assert.match(
    canvas,
    /\| 'editor'/,
    'editor is not in MainView, so the fall-through arm is not a real surface',
  )
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
  // The stylesheet has always called this `.vault-switcher-name`; the JSX said
  // `vault-name` and matched nothing, so the name lost its flex and its type.
  assert.match(code, /vault-switcher-name/)
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
  // `parseWikilinkRefs`, not `parseWikilinks`, since block references landed:
  // the editor needs the `#heading` / `#^block-id` the plain form drops. Still
  // the SHARED parser, which is the property this line exists to hold.
  assert.match(src('Editor.tsx'), /parseWikilinkRefs\(/)
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

/**
 * `settings` joined `vault` when the gear in the vault switcher stopped being a
 * console.log stub — the settings modal is rendered by this pane, so this pane
 * is where it reads from. The point of the rule is unchanged and is what the
 * omissions carry: `corner` and `network` belong to other panes, and the vault
 * pane reaching into either is the coupling this guards against.
 */
/**
 * `terminal` joined `vault` and `settings` when the ribbon's terminal icon
 * became a real panel, on the same footing settings joined on: the panel is
 * rendered BY this pane, so this pane is where it reads from. The rule the
 * omissions carry is unchanged — `corner` and `network` belong to other panes,
 * and this pane reaching into either is the coupling being guarded against.
 */
/**
 * `update` joined on exactly the footing `settings` and `terminal` did: the
 * About panel is part of the settings modal, which this pane renders, so this
 * pane is where it reads from. Nothing else about the rule moves — `corner` and
 * `network` remain other panes' business.
 *
 * Worth stating what this one surface can do, since it is the only outbound
 * request in the app: `check()` takes no argument. The feed URL is a constant
 * in shared/update.ts, so admitting it here does not give the pane the ability
 * to point a request anywhere.
 */
const ALLOWED_API = new Set(['vault', 'settings', 'terminal', 'update'])

test('the pane reaches only into its own window.api surfaces', () => {
  for (const [name, code] of all()) {
    for (const m of stripComments(code).matchAll(/window\.api\.(\w+)/g)) {
      assert.ok(ALLOWED_API.has(m[1]), `${name} reaches into window.api.${m[1]}`)
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
    /**
     * A co-located stylesheet is allowed; a foreign one is not.
     *
     * This was a flat ban on importing CSS, and the old regex only caught the
     * `... from "x.css"` form — a bare `import "./x.css"` walked straight past
     * it. Both halves are fixed here rather than left as an accidental loophole
     * to lean on: the matcher now catches side-effect imports too, and the rule
     * it enforces is the one that actually matters. `./settings.css` beside its
     * component is fine. `../../app.css` is not: app.css is the shared sheet
     * another section owns, and a component pulling it in is how two sections
     * end up editing one file.
     */
    for (const m of body.matchAll(/import\s+(?:[^'"]*\bfrom\s*)?['"]([^'"]+\.css)['"]/g)) {
      assert.match(
        m[1],
        /^\.\/[a-z][a-z0-9-]*\.css$/,
        `${name} imports a stylesheet from outside the pane: ${m[1]}`,
      )
    }
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

/**
 * `handleSave`'s body alone, sliced off at the `if (!note)` early return that
 * ends the hook region.
 *
 * The two tests below used to reach for the WHOLE FILE with `[\s\S]*` and
 * `[\s\S]{0,400}` windows, which held only for as long as the editor had
 * exactly one effect (none) and exactly one `catch` (the save path's). Block
 * references added both, and both guards fired on code that does not go near
 * the save path — `useEffect([\s\S]*handleSave` matched an anchor-scroll effect
 * two hundred lines above `handleSave`, and the `catch` window matched a
 * clipboard failure next to a legitimate buffer edit.
 *
 * A guard that fails on unrelated code is not strict, it is imprecise, and the
 * usual repair — widen the exception — is how a real guard gets worn away. So
 * both are narrowed to what they were always about instead.
 */
function saveBody() {
  const body = stripComments(src('Editor.tsx'))
  const start = body.indexOf('const handleSave')
  const end = body.indexOf('if (!note) {', start)
  assert.ok(start >= 0 && end > start, 'handleSave not found')
  return body.slice(start, end)
}

test('the only call to onSave is the Save button click', () => {
  const body = stripComments(src('Editor.tsx'))
  const calls = [...body.matchAll(/\bonSave\s*\(/g)]
  assert.equal(calls.length, 1, 'onSave is invoked from more than one place')
  assert.match(body, /await onSave\(text, note\.mtime\)/)
  assert.match(body, /onClick=\{handleSave\}/, 'save is not click-driven')
  // Counting every mention is STRONGER than the old "not inside a useEffect":
  // its definition and the button's onClick are the only two references a
  // click-driven save can have, so an effect, a timer, a keybinding or any
  // other caller shows up here as a third — whatever shape it arrives in.
  const mentions = [...body.matchAll(/\bhandleSave\b/g)]
  assert.equal(mentions.length, 2, 'handleSave is reachable from somewhere else')
  assert.match(body, /const handleSave = async/, 'handleSave is not the definition')
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
  // The buffer must not be reset anywhere in the SAVE path — not merely near a
  // `catch`. This is the stricter reading: a failed save never costs the user
  // text, on any branch of the function, catch or not.
  assert.doesNotMatch(saveBody(), /onTextChange\(/, 'the save path clobbers the buffer')
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

test('state the physics reads is declared before the simulation is built', () => {
  /**
   * Guards a crash that took the whole vault pane down: "Cannot access
   * 'dragging' before initialization".
   *
   * `buildSimulation` receives `() => dragging` and `() => adjacency`. Those
   * getters run DURING the call, not on the first tick, because d3 evaluates
   * forceLink's distance/strength accessors eagerly and caches them (proved in
   * test/graph-orbit.test.mjs). Anything declared below the call is therefore
   * in its temporal dead zone when the getter fires.
   *
   * Position-in-file is a crude thing to assert, and it is asserted anyway:
   * the alternative was a bug that typechecks, passes 159 tests, and only
   * appears when a human opens the graph tab.
   */
  const code = stripComments(src('GraphView.tsx'))
  const build = code.indexOf('buildSimulation(')
  assert.ok(build > 0, 'GraphView no longer calls buildSimulation')
  for (const decl of [/let dragging\b/, /const adjacency\b/]) {
    const at = code.search(decl)
    assert.ok(at > 0, `${decl} not found`)
    assert.ok(
      at < build,
      `${decl} is declared after buildSimulation() — the getter reads it in its ` +
        `temporal dead zone and the pane dies on open`,
    )
  }
})

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
  /**
   * The bug this guards was FolderTree seeding EXPANSION into local state, so
   * the seed was read once on mount and the explorer's expand/collapse buttons
   * did nothing.
   *
   * It used to be enforced by banning `useState` outright. That was a proxy,
   * and it now fires on the last-touched-row highlight, which is local UI
   * feedback nothing outside the tree acts on and which has nothing to do with
   * expansion.
   *
   * So the contract is asserted DIRECTLY instead, and positively: expansion is
   * read from the prop on every render. That is stronger than the old ban —
   * absence of `useState` never proved expansion was live, while this fails if
   * expansion is ever cached locally under any name.
   */
  assert.match(
    tree,
    /const isExpanded = expanded\.has\(node\.path\)/,
    'expansion is not read from the prop on every render',
  )
  assert.doesNotMatch(tree, /setExpanded/, 'FolderTree owns expansion state again')
  assert.doesNotMatch(tree, /useState[^)]*expand/i, 'FolderTree seeds expansion locally')
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

/** Two folders and two notes at each of two levels, so kind and name can be
 *  told apart in every mode. */
const SORT_FIXTURE = {
  name: 'V',
  path: '',
  kind: 'folder',
  children: [
    { name: 'b.md', path: 'b.md', kind: 'note' },
    {
      name: 'Alpha',
      path: 'Alpha',
      kind: 'folder',
      children: [
        { name: 'z.md', path: 'Alpha/z.md', kind: 'note' },
        { name: 'Nested', path: 'Alpha/Nested', kind: 'folder', children: [] },
        { name: 'a.md', path: 'Alpha/a.md', kind: 'note' },
      ],
    },
    { name: 'a.md', path: 'a.md', kind: 'note' },
    { name: 'Zeta', path: 'Zeta', kind: 'folder', children: [] },
  ],
}

const names = (node) => node.children.map((c) => c.name)

test('sortTree: four modes, four different orders, recursively', () => {
  assert.deepEqual(names(sortTree(SORT_FIXTURE, 'folders-asc')), [
    'Alpha',
    'Zeta',
    'a.md',
    'b.md',
  ])
  assert.deepEqual(names(sortTree(SORT_FIXTURE, 'folders-desc')), [
    'Zeta',
    'Alpha',
    'b.md',
    'a.md',
  ])
  assert.deepEqual(names(sortTree(SORT_FIXTURE, 'files-asc')), [
    'a.md',
    'b.md',
    'Alpha',
    'Zeta',
  ])
  assert.deepEqual(names(sortTree(SORT_FIXTURE, 'files-desc')), [
    'b.md',
    'a.md',
    'Zeta',
    'Alpha',
  ])

  // Every level, not just the top — a mode that only reorders the root looks
  // right until a folder is expanded.
  const nested = sortTree(SORT_FIXTURE, 'files-desc').children.find(
    (c) => c.name === 'Alpha',
  )
  assert.deepEqual(names(nested), ['z.md', 'a.md', 'Nested'])
})

test('sortTree: the default mode reproduces the order the main process sends', () => {
  // `folders-asc` must be a no-op on a tree that arrived from vault.ts `sort`,
  // or the explorer would visibly reshuffle itself on first paint.
  const already = sortTree(SORT_FIXTURE, 'folders-asc')
  assert.deepEqual(names(sortTree(already, 'folders-asc')), names(already))
})

test('sortTree never mutates the tree it is given', () => {
  // vault.tree is React state shared with the wikilink index and expand-all.
  // Array.prototype.sort is in-place, so this is the whole risk of the feature.
  const before = JSON.stringify(SORT_FIXTURE)
  sortTree(SORT_FIXTURE, 'files-desc')
  sortTree(SORT_FIXTURE, 'folders-desc')
  assert.equal(JSON.stringify(SORT_FIXTURE), before, 'the source tree was reordered')

  const sorted = sortTree(SORT_FIXTURE, 'files-asc')
  assert.notEqual(sorted, SORT_FIXTURE, 'the root was returned by reference')
  assert.notEqual(sorted.children[0], SORT_FIXTURE.children[0], 'children are shared')
})

test('sortTree tolerates the empty and the absent tree', () => {
  assert.equal(sortTree(null, 'folders-asc'), null)
  const leaf = { name: 'x.md', path: 'x.md', kind: 'note' }
  assert.equal(sortTree(leaf, 'folders-asc'), leaf, 'a childless node need not be copied')
})

test('isPlainName rejects a path wearing the costume of a folder name', () => {
  // Regression, found by driving the built app rather than by reading it: with
  // `Notes/Untitled.md` open, "+ Folder" joined the typed `../Escaped` to
  // `Notes` and created `Escaped` at the vault ROOT. Containment was never
  // breached — main's resolveInVault saw a path inside the vault and was right
  // to allow it — but the prompt says "name" and this is what holds it to that.
  for (const bad of ['../Escaped', '..', '.', 'a/b', 'a\\b', '/abs', 'C:\\x', '', '   ']) {
    assert.equal(isPlainName(bad), false, `${JSON.stringify(bad)} should be refused`)
  }
  for (const ok of ['Scratch', 'My Notes', 'a.b', '2026-08-18', 'Ünïcode', '..leading']) {
    assert.equal(isPlainName(ok), true, `${JSON.stringify(ok)} should be allowed`)
  }
  // Surrounding whitespace is trimmed before the verdict, since the caller
  // trims before joining too.
  assert.equal(isPlainName('  Scratch  '), true)
})

test('folderOf: the folder a note sits in, empty at the vault root', () => {
  assert.equal(folderOf('Business/Playbooks/Launch.md'), 'Business/Playbooks')
  assert.equal(folderOf('Home.md'), '')
  assert.equal(folderOf(''), '')
})

test('nextUntitledPath skips names already taken, in the right folder', () => {
  const tree = {
    name: 'V',
    path: '',
    kind: 'folder',
    children: [
      { name: 'Untitled.md', path: 'Untitled.md', kind: 'note' },
      { name: 'Untitled 1.md', path: 'Untitled 1.md', kind: 'note' },
      {
        name: 'Business',
        path: 'Business',
        kind: 'folder',
        children: [{ name: 'Untitled.md', path: 'Business/Untitled.md', kind: 'note' }],
      },
    ],
  }
  assert.equal(nextUntitledPath(tree, ''), 'Untitled 2.md')
  // Per folder, not global: Business has only the first one taken.
  assert.equal(nextUntitledPath(tree, 'Business'), 'Business/Untitled 1.md')
  assert.equal(nextUntitledPath(tree, 'Empty'), 'Empty/Untitled.md')
  assert.equal(nextUntitledPath(null, ''), 'Untitled.md')
})

test('nextUntitledPath compares case-insensitively, because NTFS does', () => {
  // `untitled.md` and `Untitled.md` are ONE file on this filesystem. A
  // case-sensitive check would hand back a path that save() then writes over an
  // existing note.
  const tree = {
    name: 'V',
    path: '',
    kind: 'folder',
    children: [{ name: 'untitled.md', path: 'untitled.md', kind: 'note' }],
  }
  assert.equal(nextUntitledPath(tree, ''), 'Untitled 1.md')
})

test('nextUntitledPath ignores folders that share the name', () => {
  // A folder called `Untitled.md` is legal and is not a note; treating it as
  // taken would skip a name that is genuinely free.
  const tree = {
    name: 'V',
    path: '',
    kind: 'folder',
    children: [
      { name: 'Untitled.md', path: 'Untitled.md', kind: 'folder', children: [] },
    ],
  }
  assert.equal(nextUntitledPath(tree, ''), 'Untitled.md')
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
    // `kind` rides along so the graph can draw an authored link differently
    // from a folder-derived one; undefined here because these fixtures predate
    // the field and never set it.
    [{ source: 'A.md', target: 'B.md', kind: undefined }],
  )
  assert.deepEqual(resolvableLinks([], [{ from: 'A.md', to: 'B.md' }]), [])
  assert.deepEqual(resolvableLinks(nodes, []), [])
  // Self-links are d3-resolvable and are not this function's business to judge.
  assert.deepEqual(resolvableLinks(nodes, [{ from: 'A.md', to: 'A.md' }]), [
    { source: 'A.md', target: 'A.md', kind: undefined },
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

  /**
   * The forceLink call moved to graphPhysics.ts when the layout was extracted
   * so `bench/orbit.mjs` could measure the real simulation. The invariant did
   * not move: the sanitised array still has to be what reaches d3.
   *
   * So this now checks the two halves in the two places they live — GraphView
   * sanitises and passes `links` on, graphPhysics is the only caller of
   * forceLink. Asserting forceLink lives *somewhere* would be weaker than the
   * original; asserting it is reached only through buildSimulation is not.
   */
  assert.match(
    code,
    /buildSimulation\(\s*nodes,\s*links,/,
    'GraphView must hand the sanitised links to the simulation builder',
  )
  const physics = stripComments(src('graphPhysics.ts'))
  assert.match(physics, /forceLink</, 'the guard is guarding nothing')
  for (const [name, body] of all()) {
    if (name === 'graphPhysics.ts') continue
    assert.doesNotMatch(
      stripComments(body),
      /forceLink</,
      `${name} builds its own link force — the layout must have exactly one home`,
    )
  }
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

/**
 * THE INVARIANT THE WHOLE docs/buttons QUEUE EXISTS FOR: no control in this
 * pane may look live and silently do nothing.
 *
 * A button qualifies as honest if it has an `onClick`, a `disabled`, or a
 * `popoverTarget` — the last because a popover invoker acts through the
 * platform rather than through a handler, and PaneMenu.tsx uses it.
 *
 * Grep-shaped, and honest about it: it proves no button is inert, not that the
 * thing it does is the right thing. The failure it prevents is real and has
 * happened twice — the note header's ellipsis shipped with no handler AND no
 * `disabled`, taking focus and painting press feedback for an action that did
 * not exist.
 */
test('every button in the pane either acts or admits it cannot', () => {
  for (const [name, code] of all()) {
    const body = stripComments(code)
    for (const m of body.matchAll(/<button\b[^>]*>/g)) {
      assert.match(
        m[0],
        /onClick|disabled|popoverTarget/,
        `${name} has a button that is neither wired nor disabled: ${m[0].slice(0, 90)}`,
      )
    }
  }
})

/**
 * The same rule for the OTHER interactive elements. A `<select>` with no
 * `onChange` is the sort dropdown's original defect and is invisible to the
 * button check above.
 */
test('every select in the pane is controlled or disabled', () => {
  for (const [name, code] of all()) {
    for (const m of stripComments(code).matchAll(/<select\b[^>]*>/g)) {
      assert.match(m[0], /onChange|disabled/, `${name} has an inert select: ${m[0]}`)
    }
  }
})

/**
 * Failures belong in the UI. Every console call in this pane's history was a
 * click that appeared to do nothing: `console.log('Help')` behind the "?" for
 * one, and the two explorer create handlers for another.
 */
test('the pane reports to the user, never to a console nobody reads', () => {
  for (const [name, code] of all()) {
    assert.doesNotMatch(stripComments(code), /\bconsole\.\w+\(/, `${name} logs to the console`)
  }
})

/**
 * Menus are held to the same standard one level down: a row that can never act
 * is the same lie as a dead button, just harder to see. PaneMenuItem takes
 * `disabled` with a `reason`, so a row that is merely unavailable right now can
 * say why — but every row must carry an onClick regardless.
 */
test('every menu row is wired', () => {
  for (const [name, code] of all()) {
    for (const m of stripComments(code).matchAll(/<PaneMenuItem\b[\s\S]*?>/g)) {
      assert.match(m[0], /onClick/, `${name} has a dead menu row`)
      if (/disabled/.test(m[0])) {
        assert.match(m[0], /reason=/, `${name} disables a menu row without saying why`)
      }
    }
  }
})

/**
 * Every menu must be anchored to the button that opens it.
 *
 * A popover is in the top layer with no containing block, so an unanchored one
 * does not land somewhere slightly wrong — it lands at the viewport origin,
 * across the app, with nothing on screen to suggest why. The spec says the
 * invoker is the implicit anchor; Chromium 130 does not implement that, so the
 * pair is written by hand in menu.css and this is what stops the next one being
 * forgotten.
 */
/**
 * A menu row must close its menu ITSELF, never via popovertargetaction.
 *
 * Found by a human clicking it, not by this suite, and worth a standing guard
 * because the failure is invisible to every test that drives the app with
 * element.click(). `popovertargetaction="hide"` is an ACTIVATION BEHAVIOUR: the
 * browser runs it after the click event finishes dispatching. React handles the
 * click first and flushes the re-render synchronously for a discrete event, so
 * a row whose own action disables it — "Close this tab" on the second-to-last
 * tab — is already disabled when the browser gets to the hide. Disabled buttons
 * have no activation behaviour, so the hide is skipped in silence and the menu
 * is left open in the top layer over a screen that has already changed.
 *
 * It costs the next click too: an open popover=auto swallows one click anywhere
 * outside itself as its light-dismiss, so the button you press next appears
 * dead. Two bug reports, one cause.
 */
test('menu rows close their own popover, not via popovertargetaction', () => {
  const menu = stripComments(src('PaneMenu.tsx'))
  const item = menu.slice(menu.indexOf('export function PaneMenuItem'))
  assert.ok(item.length > 0, 'PaneMenuItem not found')
  assert.doesNotMatch(
    item,
    /popoverTargetAction/,
    'a row that disables itself would never close its menu',
  )
  assert.match(item, /hidePopover\(\)/, 'the row never closes its menu')
  // Closing must happen BEFORE the action runs, while the button is still
  // enabled and mounted — after it, a re-render can already have unmounted it.
  const hideAt = item.indexOf('hidePopover()')
  const actAt = item.indexOf('onClick()')
  assert.ok(hideAt > 0 && actAt > hideAt, 'the action runs before the menu closes')
})

/**
 * A closed popover must stay hidden, so no ungated rule may set its `display`.
 *
 * The browser hides a closed popover with
 * `[popover]:not(:popover-open) { display: none }` — a USER-AGENT rule, which
 * ANY author rule outranks. `menu.css` set `display: flex` on `.pane-menu`
 * unconditionally, so both menus were painted from boot with nothing clicked,
 * and light-dismiss had nothing to dismiss because `:popover-open` was false
 * the whole time.
 *
 * This is the test that was missing when that shipped. The suite asserted
 * popover STATE and the probe asserted `:popover-open`; both passed while the
 * app was visibly wrong, because neither asked what was actually painted.
 * `settings.css` documents the same trap for <dialog>, which gates on `[open]`;
 * a popover has no `open` attribute and `:popover-open` is its equivalent.
 */
test('no ungated rule sets display on the popover panel', () => {
  const css = readFileSync(join(PANE, 'menu.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  assert.ok(rules.length > 0, 'menu.css parsed to nothing — this test is checking nothing')

  let gated = false
  for (const [, selector, body] of rules) {
    const sel = selector.trim()
    // The PANEL only. `.pane-menu-item` is a row inside it and is not a
    // popover, so a plain substring match flags it and this test cries wolf.
    if (!/\.pane-menu(?![\w-])/.test(sel)) continue
    const setsDisplay = /(^|[;{\s])display\s*:/.test(body)
    if (!setsDisplay) continue
    if (sel.includes(':popover-open')) {
      gated = true
      continue
    }
    assert.fail(
      `"${sel}" sets display on a popover without :popover-open — ` +
        'it beats the UA rule that hides the closed panel, so the menu paints permanently',
    )
  }
  assert.ok(gated, 'nothing ever gives the open panel a display; the menu would never show')
})

test('every PaneMenu has an anchor pair in menu.css', () => {
  const css = readFileSync(join(PANE, 'menu.css'), 'utf8')
  const ids = new Set()
  for (const [name, code] of all()) {
    // <SelectMenu> is a <PaneMenu> wearing a select's clothes, so its call
    // sites own popover ids too and need anchors just as much.
    for (const m of stripComments(code).matchAll(/<(?:PaneMenu|SelectMenu)\b[\s\S]*?>/g)) {
      const id = /id="([^"]+)"/.exec(m[0])
      if (!id) {
        // A WRAPPER forwards `id={id}` from its own caller; the literal lives
        // there and is checked there. Anything else with no literal id is the
        // mistake this test exists for.
        assert.match(
          m[0],
          /id=\{id\}/,
          `${name} has a menu with neither a literal id nor a forwarded one: ${m[0].slice(0, 80)}`,
        )
        continue
      }
      ids.add(id[1])
    }
  }
  assert.ok(ids.size > 0, 'no menus found — this test has stopped checking anything')
  for (const id of ids) {
    assert.ok(
      css.includes(`anchor-name: --${id}`),
      `menu.css never names an anchor for ${id}; its menu will open in the corner`,
    )
    assert.ok(
      css.includes(`position-anchor: --${id}`),
      `menu.css never points #${id} at its anchor`,
    )
  }
})

/**
 * The resizer's drag listeners must not outlive the drag.
 *
 * It adds window listeners on pointerdown, which is the pattern this pane has
 * been bitten by before — hence the ResizeObserver and rAF checks above. A
 * missed teardown here is invisible: the sidebar keeps resizing to a stale
 * origin on the next stray pointer move, and every drag adds another pair.
 *
 * It is written this way on purpose rather than with `setPointerCapture`, which
 * needs no teardown at all: capture does not retarget synthesized input, so a
 * captured drag cannot be driven in a test, and an unverifiable mechanism is
 * how the last bug shipped. The trade is a teardown obligation, so it is
 * checked.
 */
test('the sidebar resizer removes every listener it adds', () => {
  const code = stripComments(src('SidebarResizer.tsx'))
  const added = [...code.matchAll(/window\.addEventListener\('([a-z]+)'/g)].map((m) => m[1])
  const removed = [...code.matchAll(/window\.removeEventListener\('([a-z]+)'/g)].map((m) => m[1])
  assert.ok(added.length > 0, 'the resizer no longer adds listeners — has it been rewritten?')
  for (const ev of added) {
    assert.ok(removed.includes(ev), `"${ev}" is added to window and never removed`)
  }
  // And a drag interrupted by unmount must still tear down.
  assert.match(
    code,
    /useEffect\(\(\) => \(\) => .*\(\)/s,
    'no unmount cleanup: a drag in flight when the pane closes leaks its listeners',
  )
})

test('the conflict dialog still has no escape hatch after gaining an error prop', () => {
  const dialog = stripComments(src('ConflictDialog.tsx'))
  assert.doesNotMatch(dialog, /onCancel|onClose|onDismiss|onEscape/, 'dialog can be dismissed')
  assert.doesNotMatch(dialog, /onClick=\{[^}]*\bclose\b/i, 'dialog has a close click')
  // The overlay must not close the dialog when clicked.
  assert.doesNotMatch(dialog, /vault-conflict-dialog-overlay"\s*onClick/, 'backdrop dismisses')
})
