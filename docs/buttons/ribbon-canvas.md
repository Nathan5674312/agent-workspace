---
tier: DECIDE
control: The frame "Canvas" icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:31 (definition), :41-52 (render)
status: NOT STARTED
---

# Ribbon: Canvas

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar**.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views; `canvas`
  is at `LeftRibbon.tsx:31`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing the state at `VaultPane.tsx:47`.
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345` — the `activeRibbon === 'files'`
  branch rendering the explorer header and folder tree. There is no else.

The sidebar collapses to the vault switcher row (`VaultPane.tsx:362-365`) while
the icon lights up and reports `aria-pressed` (`LeftRibbon.tsx:43,48`).

**Note the name collision before you go further.** "Canvas" means three unrelated
things in this codebase and confusing them will waste a session:

1. This ribbon icon — Obsidian's Canvas, an infinite whiteboard document.
2. `MainCanvas.tsx` — the app's *main content area*, the dispatcher between
   editor / graph / database / inbox (`src/renderer/panes/vault/MainCanvas.tsx:10-16`).
   Nothing to do with whiteboards.
3. The `<canvas>` element the graph paints into
   (`src/renderer/panes/vault/GraphView.tsx:933`).

Only sense 1 is what this icon promises.

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Is building a whiteboard document editor inside this app in scope at all?**

This is the largest of the eight ribbon items by an order of magnitude and the
question is close to binary:

1. **No — remove the icon.** The most likely correct answer.
2. **Read-only — render existing `.canvas` files** so the vault's whiteboards are
   at least viewable here without switching to Obsidian.
3. **Yes, build an editor** — nodes, edges, drag, zoom, groups, embedded notes,
   and a `.canvas` file writer.

### Where this duplicates Obsidian

**Totally, and this is the clearest case in the whole `docs/buttons/` set.**

Obsidian Canvas is a first-party core plugin. It stores whiteboards as `.canvas`
files (JSON: nodes, edges, positions, colours, embedded note references) directly
in the vault — the same vault this app manages. Obsidian's implementation
supports embedding live notes, images, PDFs and web pages as cards, arbitrary
edge routing, groups, and its own undo history.

Building any of that here produces a second, worse whiteboard over the same
files. Building option 3 specifically means writing `.canvas` files that Obsidian
will also read — so a format bug here corrupts documents Obsidian owns.

The project's own v1 scope already said no to this. `src/renderer/panes/vault/VaultPane.tsx:14-15`:
*"v1 editor scope: read, edit, wikilinks, backlinks, graph. No plugin API, no
live preview, **no canvas**."* The icon in the ribbon contradicts the file's own
stated scope. That contradiction is the thing the decision has to resolve — and
the existing written scope is evidence for answer 1.

### What is at stake either way

**If answer 3 (build it):** this is a multi-week feature, not a button. It needs
a JSON schema reader and writer for a format Obsidian owns and can change, a
node/edge canvas with hit-testing and drag, embedded-note rendering (which means
a markdown renderer — explicitly banned by
`test/review-s2-vault-pane.test.mjs:124-133`, which rejects `remark-`, `rehype-`,
`markdown-it` and `marked` across this pane), and a write path with the same
lost-update guarantees as notes. It also breaks the v1 scope statement quoted
above, which would need rewriting deliberately.

**If answer 2 (read-only viewer):** much smaller, and it has a real justification
answer 3 lacks — "see the whiteboard without leaving the app". Still needs a
`.canvas` parser and a rendering surface, and note that `.canvas` files are
currently **invisible to this app entirely**: `src/main/vault.ts:400` only admits
files ending in `.md` into the tree, and the note server's `/notes` index is
markdown-only too. So even listing them is new work.

**If answer 1 (remove):** `test/review-s2-vault-pane.test.mjs:70-84` asserts all
eight ribbon ids exist and will fail. That test encodes the original brief's
eight-icon layout, so removing an icon is a deliberate spec revision — update the
test in the same change and say so. The same question applies to the other six
unbuilt icons, documented separately here.

### The one thing to do regardless of the answer

**The sidebar must not silently empty.** Either the unbuilt ribbon icons become
`disabled` with a title — the idiom used everywhere else in this pane, see
`src/renderer/panes/vault/TabBar.tsx:38-48` — or `VaultPane.tsx:345` gains an
else-branch with an explicit "Not built yet" panel. Given the v1 scope statement
at `VaultPane.tsx:14-15` says "no canvas" outright, `disabled` is the honest
default for this icon specifically.

## What already exists to build on

Recorded so whoever implements a decision does not re-derive it. Note how little
there is — that is itself information.

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The sidebar container** is `.vault-sidebar` at `VaultPane.tsx:344-366`.
- **The v1 scope statement that argues against this feature:**
  `src/renderer/panes/vault/VaultPane.tsx:14-15`, and the enforcing test at
  `test/review-s2-vault-pane.test.mjs:124-133`.
- **A hand-rolled interactive canvas, if answer 2 or 3 is chosen** — and the only
  one in the codebase: `src/renderer/panes/vault/GraphView.tsx`. It solves, from
  scratch, most of what a whiteboard needs:
  - `GraphView.tsx:202-207` — pan/zoom transform and screen↔world conversion
    (`toGraph`), hand-rolled rather than pulling in d3-zoom.
  - `GraphView.tsx:586-599` — `pick()`, hit-testing a point against objects.
  - `GraphView.tsx:601-635`, `:637-683`, `:721-772` — pointer move/down/up
    including drag-vs-click hysteresis (`DRAG_THRESHOLD`), grab-offset
    preservation, and pointer capture.
  - `GraphView.tsx:867-900` — wheel zoom anchored to the cursor, with log-space
    rubber-banding at the limits.
  - `GraphView.tsx:511-551` — a paint-on-demand rAF loop (`invalidate()`), and
    `:553-569` a `ResizeObserver` owning canvas sizing with devicePixelRatio.
  - `GraphView.tsx:911-926` — the full unmount cleanup.
  - `src/renderer/motion.ts` — `Decay`, `Spring`, `VelocityTracker`, `project`,
    `rubberband`, `DRAG_THRESHOLD`.
  **Read it before writing any second canvas.** Do not edit it.
- **The main-process file walk**, if `.canvas` files need to become visible:
  `src/main/vault.ts:344-415` (`tree()`), with the `.md` filter at
  `vault.ts:400` and the `HIDDEN` folder set at `vault.ts:328`.
- **The channel-adding pattern**, end to end, most recently done for settings:
  `src/shared/ipc.ts:141-163` (`CH`) and `:175-205` (`Api`) →
  `src/preload/index.ts:22-50` → `src/main/ipc.ts:49-60` → `src/main/settings.ts`.

## What does NOT exist yet

- **Everything.** There is no canvas document concept anywhere in `src/`. Grep
  for `.canvas`: the only hits are the `Frame` icon import at
  `LeftRibbon.tsx:14` and CSS class names containing the word.
- **`.canvas` files are invisible to the app.** `src/main/vault.ts:400` admits
  only `.md` into the folder tree; the note server's `/notes` index
  (`C:\Users\Nathan\Desktop\note-system\app\server.py`) is markdown-only.
- **No JSON document read/write path.** Every write goes through `/save`, which
  takes `{path, text, mtime}` and writes text
  (`src/main/vault.ts:307-321`, `server.py:750-783`).
- **No markdown renderer**, which embedded note cards would need — and it is
  banned: `test/review-s2-vault-pane.test.mjs:124-133`.
- **No undo history** for anything in the app.
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one branch
  and no else.

## Constraints

- **The scope question must be answered by a human before any code is written.**
  Given the size, an implementation started on a guess is the most expensive
  mistake available in this queue.
- **🔒 The vault is read-only by default for agents.** Writing `.canvas` files
  into `C:\Users\Nathan\Desktop\Universal Vault` is a vault write and needs
  explicit approval for that specific thing. Reading and listing are always fine.
- **A canvas writer would be writing a format Obsidian owns.** Any answer that
  involves writing must state how a malformed file is prevented from reaching the
  vault, and must go through the existing atomic-write and lost-update machinery
  (`src/main/vault.ts:307-321`) rather than around it.
- **Do not edit `GraphView.tsx` or `graphPhysics.ts`** to generalise them into a
  shared canvas engine. `test/review-s2-vault-pane.test.mjs:754-761` asserts
  exactly one file in the pane calls `forceLink<`, and `:368-395` guards a
  declaration-order crash that a refactor would silently reintroduce.
- **No markdown library.** `test/review-s2-vault-pane.test.mjs:124-133`.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240`, `:796-801`.
- **No inline styles, no hex colours, no `rgb()`/`hsl()`, no `app.css` import.**
  `test/review-s2-vault-pane.test.mjs:185-216`.
- **No node, electron or network access in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155`.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/panes/vault/MainCanvas.tsx`, `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer naming which of the three options
was chosen. If it is anything other than "remove", it must also say why the v1
scope statement at `src/renderer/panes/vault/VaultPane.tsx:14-15` ("no canvas")
is being reversed, and what this whiteboard does that Obsidian's does not. Then
update `status:` in this file's frontmatter.

**For the sidebar-empties bug**, closable now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the Canvas icon. The sidebar must show either a
real panel or an explicit "not built" message — never an empty column with the
icon lit. Clicking Files must restore the tree with its expansion state intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail. Update it in the same commit and state in your report that you changed
a spec assertion, not just code.
