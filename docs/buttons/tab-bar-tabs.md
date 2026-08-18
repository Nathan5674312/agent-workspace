---
tier: WIRE
control: The tab strip and the "+" new-tab button in the tab bar
location: src/renderer/panes/vault/TabBar.tsx:24-37
status: DONE
---

# Tabs and "+" new tab

## Today

Both controls run code. Neither changes anything the user can see. This is the
"switches state nothing consumes" case, and it is the most misleading control in
the app because it *looks* like it works.

**The "+" button** (`src/renderer/panes/vault/TabBar.tsx:35-37`) calls
`onNewTab`, which is `handleNewTab` at
`src/renderer/panes/vault/VaultPane.tsx:308-312`:

```tsx
const handleNewTab = () => {
  const newId = `tab-${Date.now()}`
  setTabs([...tabs, { id: newId, name: 'New tab' }])
  setActiveTabId(newId)
}
```

A tab labelled "New tab" appears in the strip and becomes active. The editor
below it does not change. The note stays open. Nothing else in the app reads
that array.

**Clicking a tab** (`TabBar.tsx:26-32`) calls `onTabChange`, wired to
`setActiveTabId` at `VaultPane.tsx:372`. The only consumer of `activeTabId` in
the entire codebase is the CSS class one line away:

```tsx
// src/renderer/panes/vault/TabBar.tsx:28
className={`vault-tab ${activeTabId === tab.id ? 'vault-tab--active' : ''}`}
```

So switching tabs moves a highlight and nothing else. Grep confirms it:
`activeTabId` appears only in `TabBar.tsx` and `VaultPane.tsx`, and never in
`MainCanvas.tsx`, `Editor.tsx`, or anything that renders content.

**A tab holds no note.** The shape is `{ id: string; name: string }`
(`TabBar.tsx:11`) — there is no path field.

## What it should do

A tab should remember which note it is showing, and clicking one should open
that note.

Concretely:

1. Widen the tab shape to `{ id: string; name: string; path: string | null }`.
2. `onNewTab` creates a tab with `path: null`, activates it, and clears the
   canvas to the "No note selected" state. That empty state already exists —
   `src/renderer/panes/vault/Editor.tsx:70-72` renders
   `<div className="vault-editor-empty">No note selected</div>` when `note` is
   null, and the header falls back to `'No note selected'` at
   `src/renderer/panes/vault/MainCanvas.tsx:198`.
3. Opening a note (from the tree, a wikilink, a backlink, the graph, the table or
   the inbox) writes its path and title into the **active** tab, renaming it.
4. Clicking a tab calls the existing `openNote(tab.path)` and respects its
   `false` return.
5. Keep **one** buffer for the whole pane. Switching tabs is a note switch, and
   the existing dirty-guard confirm fires. Per-tab buffers are explicitly out of
   scope — see Constraints; the test suite forbids it.

That is the whole job. It converts three controls (the strip, "+", and by
extension the chevron menu) from decoration into navigation.

## What already exists to build on

- **The state to widen:** `src/renderer/panes/vault/VaultPane.tsx:52-53`.
- **The prop interface to widen:** `TabBarProps` at
  `src/renderer/panes/vault/TabBar.tsx:9-14`.
- **The wiring site:** `src/renderer/panes/vault/VaultPane.tsx:369-374`.
- **`openNote` is exactly the function you need**, and it already does the hard
  parts. `src/renderer/panes/vault/VaultPane.tsx:177-186`:
  - it routes through `loadNote` (`VaultPane.tsx:144-167`), which refuses when a
    conflict dialog is open, prompts before discarding a dirty buffer, and
    surfaces read failures into `openError` state;
  - it returns `Promise<boolean>` — `false` means the open was refused. The
    comment at `VaultPane.tsx:169-176` explains why callers must check it:
    *"a caller that switches view regardless yanks the user somewhere they just
    said no to."* Your tab click must not activate a tab whose note did not open.
- **Every existing "open a note" callsite already respects that boolean**, and
  they are your models:
  - `src/renderer/panes/vault/MainCanvas.tsx:265-273` (database row)
  - `src/renderer/panes/vault/MainCanvas.tsx:293-300` (graph node)
  - `src/renderer/panes/vault/MainCanvas.tsx:254-258` (inbox item)
- **The single choke point for "a note became current"** is
  `loadNote`'s success branch at `VaultPane.tsx:154-160`
  (`setSelectedNote(note)`). That is where the active tab's `path` and `name`
  should be updated — not in each caller.
- **`selectedNote` already carries the display name:** `VaultNoteBody` extends
  `VaultNote` (`src/shared/ipc.ts:14-22`), whose `title` is derived from the
  filename in `src/main/vault.ts:177` (`titleOf`).
- **The effect that brings the editor forward on any open:**
  `src/renderer/panes/vault/MainCanvas.tsx:141-144`, keyed on `note?.path`. The
  comment at `MainCanvas.tsx:125-140` explains it is keyed on the path rather
  than the object *because `handleSave` replaces `selectedNote` with a new object
  on every save*. Your tab-update logic must be keyed on path for the same
  reason, or every save will churn the tab list.
- **Navigation history already exists and is separate from tabs.**
  `VaultPane.tsx:94-97` (`nav: { trail, index }`), with the reasoning at
  `VaultPane.tsx:76-93` about why trail and cursor are one piece of state. Leave
  history global; do not make it per-tab.

## What does NOT exist yet

- **A path on a tab.** `{ id, name }` only (`TabBar.tsx:11`).
- **Any consumer of `activeTabId` other than a CSS class.** Confirmed by grep
  across `src/`.
- **Close-tab handling.** There is no way to remove a tab. Adding one is
  `tab-menu.md` in this directory, not this item — but if you land this first,
  the tab list can only grow, which is worth calling out in your report.
- **Persistence.** `AppSettings` (`src/shared/ipc.ts:46-60`) holds one setting,
  the vault directory. Open tabs are lost on restart. That is fine; do not add
  persistence.
- **Per-tab scroll position, per-tab view mode, or per-tab undo history.** All
  out of scope. Note that the view mode is already per-`MainCanvas`
  (`MainCanvas.tsx:59`), so if `tab-split.md` lands, each *column* has its own
  view — that is a different axis from tabs and the two do not need to interact.

## Constraints

- **ONE buffer, pane-wide. This is not negotiable and the suite enforces it.**
  - `test/review-s2-vault-pane.test.mjs:265-282` asserts `Editor.tsx` holds no
    local text state, that `VaultPane.tsx` declares `const [buffer, setBuffer]`,
    and that `MainCanvas.tsx` threads `onTextChange={onTextChange}`.
  - The reasoning is at `src/renderer/panes/vault/VaultPane.tsx:17-25`: the
    editor unmounts whenever the canvas switches to the graph, so a buffer stored
    below `VaultPane` is silent data loss.
  - A map of `tabId -> buffer` is a different, larger design. Do not start it
    inside this task.
- **Every note open must go through `loadNote`.**
  `test/review-s2-vault-pane.test.mjs:305-319` counts `readNote(` occurrences in
  the navigation region and asserts there is exactly **one** — *"more than one
  place reads a note; a guard can be bypassed"* — and asserts `openNote`,
  `goBack` and `goForward` each call `loadNote(`. If you add a tab-click path
  that reads a note directly, that test fails, correctly.
- **The dirty-buffer confirm must still fire on a tab switch.**
  `test/review-s2-vault-pane.test.mjs:298-303` asserts the nav region contains
  `if (isDirty)`, `window.confirm(` and `if (!ok) return`.
- **An open conflict dialog must block a tab switch.**
  `test/review-s2-vault-pane.test.mjs:321-330` asserts `if (conflictOpen) return`
  is in the nav region. Going through `loadNote` gets this for free.
- **`test/review-s2-vault-pane.test.mjs:94-100`** asserts `TabBar.tsx` contains
  `vault-new-tab`, `vault-tab-chevron`, `vault-tab-split` and `tabs.map`. Keep
  all four.
- **No timers, no auto-save, no inline styles, no hex colours.**
  `test/review-s2-vault-pane.test.mjs:230-240`, `:796-801`, `:185-216`.
- **Do not import `app.css`** — `test/review-s2-vault-pane.test.mjs:191-209`.
- **Accessibility** (`docs/ACCESSIBILITY.md:62-63`): the tab bar's lack of a
  roving tabindex and arrow-key navigation is a *recorded known gap*. You are not
  required to close it here, but do not make it worse, and if you add arrow-key
  movement, update that line in `docs/ACCESSIBILITY.md`.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev` with the note server running:

1. Open a note from the sidebar → the single tab renames itself from "Universal
   Vault" to that note's title.
2. Click "+" → a new tab appears and becomes active, and the canvas shows "No
   note selected". This is the behaviour that proves the tab is consumed.
3. Open a different note → the *new* tab renames itself; the first tab keeps its
   original name.
4. Click the first tab → that note opens in the editor, the title in the note
   header changes, and the editor comes forward even if you were on the Graph
   view.
5. Type in the editor, then click the other tab → the discard confirmation
   appears. Click Cancel → **the tab does not change** and the buffer is intact.
   (This is the `openNote` return value being respected.)
6. Click the other tab and accept the discard → the note switches and the tab
   highlight follows.
7. Save a note five times → the tab list does not grow and the tab name does not
   flicker. (This is the path-vs-object keying from `MainCanvas.tsx:125-140`.)
8. Open a note from a wikilink in the editor body, from a backlink, from a graph
   node, and from a database row → in all four cases the active tab renames
   itself. All five entry points funnel through `loadNote`.
