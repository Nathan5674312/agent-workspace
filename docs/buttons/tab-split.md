---
tier: WIRE
control: The split-pane button (two columns icon) at the right of the tab bar
location: src/renderer/panes/vault/TabBar.tsx:43-45
status: NOT STARTED
---

# Split pane

## Today

Nothing. A `disabled` button with no `onClick`:

```tsx
// src/renderer/panes/vault/TabBar.tsx:43-45
<button className="vault-tab-split" disabled title={NOT_YET}>
  <Columns2 size={14} aria-hidden="true" />
</button>
```

`NOT_YET` is `'Not implemented yet'` (`TabBar.tsx:7`). `TabBarProps`
(`TabBar.tsx:9-14`) has no split-related prop. `VaultPane` renders exactly one
`<MainCanvas>` (`src/renderer/panes/vault/VaultPane.tsx:385-403`) and holds no
state about panes or layout.

## What it should do

Show the canvas twice, side by side, so the user can look at two views of the
vault at once.

**Scope this to the minimum honest version, which is genuinely one sitting:**
a second `<MainCanvas>` rendered beside the first, sharing the one open note and
the one edit buffer, but with its **own independent view mode**. So: markdown on
the left, graph on the right. Or the editor on the left and the database table on
the right. That is the thing people actually want a split for, and it works
today with no new data model.

Concretely:

1. Add a `split: boolean` state to `VaultPane` and an `onToggleSplit` prop
   through `TabBar`.
2. When `split` is true, render two `<MainCanvas>` elements inside a flex row,
   passing **the same props to both**.
3. Toggle it off from the same button, with `aria-pressed` reflecting the state.
4. Remove `disabled` and `title={NOT_YET}`.

**Explicitly out of scope, and do not build them:** independent buffers per
pane, independent open notes per pane, drag-to-resize, more than two panes,
vertical split, or per-pane tab strips. Each is a separate feature; three of them
would break invariants the test suite holds (see Constraints).

## What already exists to build on

- **`MainCanvas` is already self-contained and view-state-local.**
  `src/renderer/panes/vault/MainCanvas.tsx:59` —
  `const [view, setView] = useState<'editor' | 'graph' | 'database' | 'inbox'>('editor')`.
  The view mode, the fetched graph, the fetched note list and the fetched inbox
  all live **inside** the component (`MainCanvas.tsx:59-68`). Two instances
  therefore get two independent view modes for free. This is the single fact
  that makes this task small.
- **Nothing note-related is stored in `MainCanvas`.** The header comment at
  `MainCanvas.tsx:10-16` states the rule: *"The editor unmounts when the graph is
  shown. That is only safe because the edit buffer is owned by `<VaultPane>`;
  nothing note-related may be stored here."* Because the buffer is upstream, two
  canvases sharing it is correct by construction, not a compromise.
- **The full prop list to duplicate** is `MainCanvasProps` at
  `MainCanvas.tsx:17-38`, and the existing callsite is
  `src/renderer/panes/vault/VaultPane.tsx:385-403`. Pass the identical set to
  both instances.
- **The buffer and its owner:** `src/renderer/panes/vault/VaultPane.tsx:50`
  (`const [buffer, setBuffer] = useState('')`) and the reasoning at
  `VaultPane.tsx:17-25`.
- **Each canvas re-fetches its own data on view switch**, deliberately, and the
  cost is already reasoned about:
  - `MainCanvas.tsx:82-96` — `handleSwitchToGraph`; the graph is memoised in the
    main process with a TTL (`src/main/vault.ts:444-465`), so a second canvas
    opening the graph hits that memo rather than rebuilding it.
  - `MainCanvas.tsx:112-123` — `handleSwitchToDatabase`; `MainCanvas.tsx:98-111`
    explains there is deliberately no cache behind it.
  - `MainCanvas.tsx:151-162` — `handleSwitchToInbox`.
- **The layout container** is `.vault-main` in `src/renderer/app.css`, which also
  paints the artwork layer via `.vault-main::before` (see the comment at
  `src/renderer/panes/vault/VaultPane.tsx:405-407`). Your split row goes inside
  it, beside `<TabBar>` and `<ArtCredit>`.
- **`Columns2` is already imported** at `TabBar.tsx:5`.
- **Toggle-button idiom with `aria-pressed`:** `src/renderer/panes/vault/LeftRibbon.tsx:41-52`,
  and the orphans chip at `src/renderer/panes/vault/DatabaseView.tsx:181-190`.

## What does NOT exist yet

- **Any layout state.** `VaultPane` (`src/renderer/panes/vault/VaultPane.tsx:47-99`)
  has no concept of panes. You are adding the first one.
- **Any CSS for a split.** `.vault-tab-split` appears nowhere in
  `src/renderer/app.css`; nor does any two-column rule for `.vault-main`. You
  need a flex row with two equal children, each scrolling independently.
- **Per-pane note state.** There is exactly one `selectedNote`
  (`VaultPane.tsx:48`) and one `buffer` (`VaultPane.tsx:50`). Both panes will
  show the same note. That is the accepted v1 behaviour, not a bug to fix here.
- **A second `ArtCredit` slot.** `ArtCredit` (`src/renderer/panes/vault/ArtCredit.tsx`)
  hit-tests what is drawn under it (`ArtCredit.tsx:75-87`) and hides itself when
  occluded. It is a sibling of the canvas, not a child (`VaultPane.tsx:405-407`).
  Leave it exactly where it is — it will handle the busier screen on its own.

## Constraints

- **One buffer. Do not give each pane its own.**
  `test/review-s2-vault-pane.test.mjs:265-282` asserts the editor holds no local
  text state, that `VaultPane` declares `const [buffer, setBuffer]`, and that
  `MainCanvas.tsx` contains `onTextChange={onTextChange}`. Two buffers over one
  file is a data-loss design and the suite will stop you.
- **Both panes must receive the same `onSave`.** `test/review-s2-vault-pane.test.mjs:242-250`
  asserts `Editor.tsx` calls `onSave(` exactly once, and
  `:590-633` guards the save path against cross-writing two notes. Do not
  introduce a second save route.
- **Do not import `app.css`.** `test/review-s2-vault-pane.test.mjs:191-209`
  permits only a co-located `./name.css`. Add
  `src/renderer/panes/vault/split.css` (or fold into a tabbar stylesheet) if you
  need rules.
- **No inline style objects, no hex colours.** `test/review-s2-vault-pane.test.mjs:185-216`.
  This rules out `style={{ flex: 1 }}` — it must be a class.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240`, `:796-801`.
- **Watch the graph in the second pane.** `GraphView` builds a d3 simulation, a
  rAF loop and a `ResizeObserver` per instance
  (`src/renderer/panes/vault/GraphView.tsx:61-927`). Two simultaneous graph
  views is two simulations. It cleans up correctly on unmount
  (`GraphView.tsx:911-926`), so this is acceptable — but confirm the fan does not
  spin up, and do **not** edit `GraphView.tsx` to "fix" it.
- **Keep the class name `vault-tab-split`.**
  `test/review-s2-vault-pane.test.mjs:98` asserts it is present.
- **Accessibility** (`docs/ACCESSIBILITY.md:41-50`): the button is icon-only and
  currently has **no** `aria-label` — add one, keep `aria-hidden="true"` on the
  Lucide icon, and add `aria-pressed` for the on/off state.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`:

1. The split button is enabled with a real tooltip and an `aria-label`.
2. Click it → the canvas area becomes two equal columns, both showing the
   editor with the same note.
3. Click "Graph" in the right column → the right column shows the graph, the
   left column **stays** on the editor. This is the whole point of the task; if
   both columns switch, the view state has been lifted too far up.
4. Type in the left editor → the text appears in the right editor too (one
   buffer), and both status labels read "Unsaved changes".
5. Click Save in either column → both read "Saved". No conflict dialog.
6. Click a note in the sidebar tree → both columns follow to that note.
7. Click the split button again → back to one column. The buffer is unchanged
   and still dirty if it was dirty.
8. Toggle split five times with the graph open on one side → no console errors,
   and CPU returns to idle when the graphs are closed.
