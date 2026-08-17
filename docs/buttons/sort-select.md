---
tier: WIRE
control: The sort dropdown in the explorer header ("Sort by name")
location: src/renderer/panes/vault/ExplorerHeader.tsx:63-70
status: NOT STARTED
---

# Sort select

## Today

Nothing. It is a `<select>` with a hardcoded `disabled` attribute, exactly one
`<option>`, no `onChange` handler, and no state anywhere that a sort mode could
be written into:

```tsx
// src/renderer/panes/vault/ExplorerHeader.tsx:63-70
<select
  className="vault-sort-select"
  defaultValue="name"
  disabled
  title="Sorted by name — other sort modes are not implemented yet"
>
  <option value="name">Sort by name</option>
</select>
```

The comment above it at `ExplorerHeader.tsx:60-62` explains the current state
honestly: the tree is always sorted folders-first then by name in the main
process, and *"Offering 'Modified' with nothing behind it is a lie the user only
discovers by picking it and watching nothing move."*

The actual sort is at `src/main/vault.ts:417-425`:

```ts
node.children.sort(
  (a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) ||
    a.name.localeCompare(b.name),
)
```

`ExplorerHeaderProps` (`ExplorerHeader.tsx:13-18`) has no sort prop at all, so
there is not even a channel through which a choice could reach the tree.

## What it should do

Let the user choose the tree's sort order, and actually re-order the tree when
they do.

Ship these four modes, all of which can be computed from data the renderer
already holds:

- **Name (A→Z)** — the current behaviour, and the default.
- **Name (Z→A)** — the same comparator, reversed.
- **Folders first / Files first** — the `kind` half of the comparator, flipped.

Do **not** ship "Modified" or "Created" in this task. See "What does NOT exist
yet" — the tree carries no timestamps, and adding them is a separate job with a
real performance cost. Shipping a mode with nothing behind it would recreate
exactly the defect this control is being fixed for.

Concretely:

1. Add a `sortBy` state to `VaultPane` and pass it plus an `onSortChange` down to
   `ExplorerHeader`, the same shape as the four handler props it already takes.
2. Sort in the **renderer**, not the main process. The tree arrives from
   `vault.tree()` already sorted name-ascending; re-sorting a ~258-node tree in a
   `useMemo` is free and avoids a round trip on every dropdown change.
3. Remove `disabled`, remove `defaultValue`, make it a controlled `value` +
   `onChange` select, and replace the stale `title`.

## What already exists to build on

- **`ExplorerHeaderProps`** at `src/renderer/panes/vault/ExplorerHeader.tsx:13-18`
  is the prop interface to extend. All four existing props are callbacks passed
  from `VaultPane`.
- **The wiring site** is `src/renderer/panes/vault/VaultPane.tsx:347-352`, where
  `<ExplorerHeader onNewNote={...} onNewFolder={...} onCollapse={...} onExpand={...} />`
  is rendered.
- **The tree shape** is `VaultTreeNode` at `src/shared/ipc.ts:24-29`:
  `{ name, path, kind: 'folder' | 'note', children? }`. Note what it does
  **not** carry: no mtime, no size, no created date.
- **The comparator to copy and vary** is `src/main/vault.ts:417-425`. Keep
  `localeCompare` — the vault has non-ASCII note names and a raw `<` comparison
  orders them wrongly.
- **A near-identical control, fully working, one component away.** The database
  view's toolbar has a live "Group by" select and live sortable column headers:
  - `src/renderer/panes/vault/DatabaseView.tsx:165-177` — the controlled select:
    `value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupKey)}`
    with options mapped from a `GROUPS` const at `DatabaseView.tsx:37-42`.
  - `src/renderer/panes/vault/DatabaseView.tsx:132-138` — `toggleSort`, which
    handles the direction flip.
  - `src/renderer/panes/vault/DatabaseView.tsx:100-108` — the comparator,
    including the "empty sorts last regardless of direction" rule.
  - `src/renderer/panes/vault/DatabaseView.tsx:87-128` — the whole thing wrapped
    in a `useMemo` keyed on every input. Copy this structure.
- **`FolderTree` is already fully controlled** (`src/renderer/panes/vault/FolderTree.tsx`).
  It renders `root.children` recursively and holds no state of its own — the
  comment at `FolderTree.tsx:5-11` says its local state was deliberately
  removed. So handing it a differently-sorted tree just works.
- **`collectFolderPaths`** in `src/renderer/panes/vault/helpers.ts` (tested at
  `test/review-s2-vault-pane.test.mjs:475-503`) walks the tree; read it as a
  model for writing a recursive tree transform.

## What does NOT exist yet

- **Timestamps on tree nodes.** `VaultTreeNode` (`src/shared/ipc.ts:24-29`) has
  four fields and none is a date. `tree()` in `src/main/vault.ts:344-415` calls
  `readdir(abs, { withFileTypes: true })`, which returns no stat data — adding
  mtime means an extra `stat()` per entry across the whole vault on every tree
  load. That is why "Sort by modified" is out of scope here.
  - Related trap: the note list from `/notes` *does* carry an `updated` string
    (`src/main/vault.ts:209`), but that is **frontmatter**, not filesystem mtime,
    it is a different call (`vault.list()`, not `vault.tree()`), and
    `src/main/vault.ts:212-218` warns that rows from `list()` have `mtime: 0`
    always. Do not try to join the two here.
- **Any sort state.** `VaultPane` (`src/renderer/panes/vault/VaultPane.tsx:47-99`)
  declares fourteen pieces of state; none is a sort mode. `test/review-s2-vault-pane.test.mjs:470`
  asserts a previously-removed `treeMode` state has not come back — do not
  resurrect that name.
- **A persisted preference.** `AppSettings` (`src/shared/ipc.ts:46-60`) holds
  exactly one setting, the vault directory. Sort order resets on restart. That is
  fine; do not add settings persistence for this.

## Constraints

- **Sort a copy, never mutate `vault.tree`.** `Array.prototype.sort` mutates in
  place, and `vault.tree` is React state shared with everything else in the pane.
  Build new node objects in the `useMemo`.
- **Wrap it in `useMemo` keyed on `[vault.tree, sortBy]`.** Re-sorting the whole
  tree on every render of a pane that re-renders on every keystroke in the editor
  is a real cost, and `VaultPane` owns the edit buffer.
- **`test/review-s2-vault-pane.test.mjs:91`** asserts `ExplorerHeader.tsx`
  contains `vault-sort-select`. Keep the class name.
- **`test/review-s2-vault-pane.test.mjs:86-92`** asserts the header still
  exposes `onNewNote`, `onNewFolder`, `onCollapse`, `onExpand`. Add props; do not
  remove any.
- **`test/review-s2-vault-pane.test.mjs:439-448`** asserts `FolderTree.tsx`
  contains no `useState` and still takes `expanded: Set<string>` and `onToggle`.
  Keep the tree dumb — the sort lives above it.
- **No timers, no auto-save, no inline styles, no hex colours.**
  `test/review-s2-vault-pane.test.mjs:230-240` and `:185-216`.
- **Do not ship an option with nothing behind it.** The comment at
  `ExplorerHeader.tsx:60-62` is the standard this control is being held to; a
  greyed-out or no-op option would fail this task even if it typechecks.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

The comparator is pure and belongs in `src/renderer/panes/vault/helpers.ts`,
which the test suite already imports directly and exercises as real functions
(`test/review-s2-vault-pane.test.mjs:27-37`). Add a case there asserting each
mode's order against a small fixture tree — `helpers.ts` must stay free of React,
DOM, node and `window` (`test/review-s2-vault-pane.test.mjs:803-812`).

Manual, in `npm run dev`:

1. The select is enabled and lists four options.
2. Switch to "Name (Z→A)" → the top-level folders visibly reverse order, and so
   do the notes inside an expanded folder.
3. Switch to "Files first" → notes sort above folders at every level.
4. Switch back to "Name (A→Z)" → the tree matches what it showed on launch.
5. Expand two folders, change the sort → both stay expanded (expansion is keyed
   on `path`, which sorting does not change).
6. With unsaved edits in the editor, change the sort → no confirm prompt, and the
   status still reads "Unsaved changes". Sorting must not touch the buffer.
