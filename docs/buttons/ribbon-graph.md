---
tier: DECIDE
control: The "Graph view" waypoints icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:30 (definition), :41-52 (render)
status: NOT STARTED
---

# Ribbon: Graph view

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar** —
while a fully working graph sits one click away in a different control.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views; `graph`
  is at `LeftRibbon.tsx:30`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing the state at `VaultPane.tsx:47`.
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345` — the `activeRibbon === 'files'`
  branch that renders the explorer header and folder tree. There is no else.

So the sidebar collapses to the vault switcher row (`VaultPane.tsx:362-365`)
while the icon lights up and reports `aria-pressed` (`LeftRibbon.tsx:43,48`).

**This icon is different from the other six unbuilt ones, and that is the whole
problem.** The graph is *built*. It is reached from the view switcher in the main
canvas instead:

- `src/renderer/panes/vault/MainCanvas.tsx:212-218` — the "Graph" button, wired
  to `handleSwitchToGraph` at `MainCanvas.tsx:82-96`.
- `src/renderer/panes/vault/GraphView.tsx` — a complete force-directed canvas
  with pan, zoom, hover, drag, momentum, rubber-banding, zoom-to-fit and
  reduced-motion handling.

So the app has two graph entry points: one that works and one that blanks the
sidebar. A user who clicks the ribbon icon labelled "Graph view" reasonably
concludes the graph is broken.

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Is the ribbon "Graph view" icon the same graph that already exists, or a
different one?**

Three coherent answers, and they lead to different work:

1. **Same graph — make the icon a shortcut.** Clicking it switches the main
   canvas to the existing graph view, and the ribbon icon stops owning a sidebar
   panel at all. The ribbon becomes a mix of "panel selectors" and "commands",
   which is a real design change to the ribbon's meaning, not a wiring change.
2. **A different graph — the LOCAL graph.** Obsidian's ribbon graph is the global
   graph; its *local* graph (the open note plus its neighbours, N hops out) is a
   sidebar panel. If that is what this icon means, it is a new, smaller view over
   data that already exists — but it is still a second canvas to build, tune and
   maintain.
3. **Remove the icon**, since the graph is already reachable and the duplicate
   entry point is the source of the confusion.

### Where this duplicates Obsidian

**Twice over, and this one is worth being precise about.**

Obsidian has both a global graph and a local graph over this same vault, with
filters, groups, colour rules, depth control and force sliders. This app already
re-solved the global graph once — `src/renderer/panes/vault/GraphView.tsx` is
~940 lines of hand-rolled d3-force, canvas painting, pan/zoom maths and gesture
physics, plus `src/renderer/panes/vault/graphPhysics.ts` and a benchmark harness
referenced at `GraphView.tsx:99-110` and `:183-194`.

That rebuild is *done* and is arguably justified: the graph is described as the
app's signature screen (`docs/ACCESSIBILITY.md:69-72`). But building the local
graph too means re-solving Obsidian a second time, in the same session, for a
feature Obsidian ships in the sidebar. Answer 2 is the expensive one and needs
the strongest argument.

There is also a real, non-duplicate alternative already in the app that answer 2
should be measured against: **the backlinks list**
(`src/renderer/panes/vault/Editor.tsx:132-150`, fed by
`vault.getBacklinks(path)` at `src/renderer/panes/vault/useVault.ts:92-94`) is
already a one-hop local graph in text form, and it is accessible to a screen
reader in a way a canvas is not.

### What is at stake either way

**If answer 1 (shortcut):** the ribbon stops being a single consistent thing.
Seven icons select sidebar panels; one issues a command to the main canvas. That
is defensible — Obsidian's own ribbon is commands, not panels — but it changes
what `activeRibbon` means and should be decided, not drifted into.

**If answer 2 (local graph):** a second canvas component, a second simulation, a
second set of pointer handlers. `GraphView`'s cleanup is careful and hard-won —
`GraphView.tsx:911-926` cancels the rAF loop, stops the simulation, disconnects
the ResizeObserver and removes seven listeners, guarded by
`test/review-s2-vault-pane.test.mjs:397-424`. A second one must be equally
careful or it leaks a frame loop into a sidebar that is mounted most of the time.
Also note `docs/ACCESSIBILITY.md:58-61`: the graph is *"a `<canvas>` with no
accessible representation… a screen-reader user gets nothing at all."* A second
inaccessible canvas doubles that gap.

**If answer 3 (remove):** `test/review-s2-vault-pane.test.mjs:70-84` asserts all
eight ribbon ids exist and will fail. That test encodes the original brief's
eight-icon layout, so removing an icon is a deliberate spec revision — update the
test in the same change and say so.

### The one thing to do regardless of the answer

**The sidebar must not silently empty.** Either the unbuilt ribbon icons become
`disabled` with a title — the idiom used everywhere else in this pane, see
`src/renderer/panes/vault/TabBar.tsx:38-48` — or `VaultPane.tsx:345` gains an
else-branch with an explicit "Not built yet" panel.

## What already exists to build on

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The working graph, reachable from the canvas:**
  - `src/renderer/panes/vault/MainCanvas.tsx:59` — the `view` state
    (`'editor' | 'graph' | 'database' | 'inbox'`), local to `MainCanvas`.
  - `src/renderer/panes/vault/MainCanvas.tsx:82-96` — `handleSwitchToGraph`. The
    comment at `:70-81` explains it always re-fetches, and why the cache belongs
    in the main process.
  - `src/renderer/panes/vault/MainCanvas.tsx:212-218` — the button.
  - **For answer 1, this is the obstacle:** `view` lives *inside* `MainCanvas`
    and the ribbon lives in `VaultPane`. The ribbon cannot reach it today. The
    same problem was already solved once, for note-opening, by an effect keyed on
    the note path at `MainCanvas.tsx:141-144` — read the comment at
    `MainCanvas.tsx:125-140`, which describes exactly this class of bug: *"the
    sidebar tree, the tab bar and the back/forward arrows all call `openNote`…
    and then nothing happened, because `view` lives here and none of them can
    reach it."* That is the same fix pattern, and the same trap (key on a value,
    not an object identity).
- **The graph data:** `vault.getGraph()` at
  `src/renderer/panes/vault/useVault.ts:51-53` → `window.api.vault.graph()` →
  `src/main/vault.ts:458-465`, memoised for 30 s and invalidated by our own saves
  (`src/main/vault.ts:319`, `:444-451`). `VaultGraph` is
  `{ nodes: string[]; links: { from, to }[] }` (`src/shared/ipc.ts:31-34`).
- **One-hop neighbours without a canvas**, if answer 2 is chosen and a text
  version would do: `vault.getBacklinks(path)`
  (`src/renderer/panes/vault/useVault.ts:92-94`, `src/main/vault.ts:553-556`),
  already rendered at `src/renderer/panes/vault/Editor.tsx:132-150`. The pane
  fetches these for the open note at `VaultPane.tsx:119-136`, cancellably.
- **`resolvableLinks`** in `src/renderer/panes/vault/helpers.ts` — mandatory
  before handing edges to d3. `test/review-s2-vault-pane.test.mjs:695-726` proves
  d3's `forceLink` throws synchronously on a dangling edge, which crashes the
  whole pane.
- **The currently open note**, for a local graph's centre: `selectedNote` at
  `VaultPane.tsx:48`.

## What does NOT exist yet

- **Any sidebar graph.** `GraphView` is rendered only from `MainCanvas.tsx:291-301`.
- **Any way for the ribbon to change the canvas view.** `view` is `useState`
  inside `MainCanvas` (`MainCanvas.tsx:59`) with no prop, no lifted state and no
  callback out.
- **Any depth/hops parameter.** `VaultGraph` (`src/shared/ipc.ts:31-34`) is the
  whole graph; there is no neighbourhood query. `backlinks()`
  (`src/main/vault.ts:553-556`) is one hop, inbound only — it filters
  `l.to === path`. Outbound one-hop links are parsed client-side from the note
  body by `parseWikilinks` (`src/renderer/panes/vault/Editor.tsx:74`).
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one branch
  and no else.

## Constraints

- **The scope question must be answered by a human before any code is written.**
  Answers 1 and 2 are different products; guessing wrong means building the wrong
  one.
- **Do not edit `GraphView.tsx` or `graphPhysics.ts`.** Both are tuned against a
  measured benchmark (`GraphView.tsx:99-110`, `:183-194`) and are guarded by
  `test/review-s2-vault-pane.test.mjs:368-395`, `:397-424` and `:728-762`. In
  particular, `:754-761` asserts **exactly one file** in the pane calls
  `forceLink<` — *"the layout must have exactly one home"*. A second graph
  component must reuse `buildSimulation` from `graphPhysics.ts`, not write its
  own force setup.
- **Any new canvas must cancel its rAF loop, stop its simulation and disconnect
  its ResizeObserver on unmount.** `test/review-s2-vault-pane.test.mjs:397-424`.
  A sidebar panel is mounted far more of the time than a main-canvas view, so a
  leak here is worse.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240`, `:796-801`. The
  existing graph uses the rAF frame clock instead of `setTimeout`, and the
  reasoning is written out at `GraphView.tsx:826-835`.
- **No inline styles, no hex colours, no `rgb()`/`hsl()`.**
  `test/review-s2-vault-pane.test.mjs:185-216`. `GraphView` reads its colours
  from CSS custom properties with system-colour keyword fallbacks
  (`GraphView.tsx:66-86`) — copy that, do not hardcode.
- **The graph is read-only.** `test/review-s2-vault-pane.test.mjs:174-181`
  asserts the pane never passes data to `graph()` and never writes the index.
- **Accessibility:** `docs/ACCESSIBILITY.md:58-61` and `:64-65` record the
  existing graph as pointer-only with no accessible representation. Do not add a
  second one without at least considering a text fallback.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer naming which of the three options
was chosen, and — if it is answer 2 — the argument for building a second graph
canvas when Obsidian ships a local graph over the same vault and the backlinks
list already shows one-hop neighbours as text. Then update `status:` in this
file's frontmatter.

**For the sidebar-empties bug**, closable now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the ribbon Graph icon. The sidebar must show
either a real panel or an explicit "not built" message — never an empty column
with the icon lit. Then click "Graph" in the main canvas view switcher and
confirm the real graph still renders, pans, zooms and opens a note on click.
Clicking Files must restore the tree with its expansion state intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail. Update it in the same commit and state in your report that you changed
a spec assertion, not just code.
