---
tier: WIRE
control: The vertical-ellipsis button at the far right of the tab bar
location: src/renderer/panes/vault/TabBar.tsx:46-48
status: NOT STARTED
---

# Tab menu (ellipsis)

## Today

Nothing. A `disabled` button with no `onClick`:

```tsx
// src/renderer/panes/vault/TabBar.tsx:46-48
<button className="vault-tab-menu" disabled title={NOT_YET}>
  <EllipsisVertical size={14} aria-hidden="true" />
</button>
```

`NOT_YET` is `'Not implemented yet'` (`TabBar.tsx:7`). The comment above it
(`TabBar.tsx:38-39`) records the deliberate choice to disable rather than leave
inert: *"none of these three had an onClick at all, so they were decoration that
read as controls."*

`TabBarProps` (`TabBar.tsx:9-14`) exposes `tabs`, `activeTabId`, `onTabChange`
and `onNewTab`. There is no menu prop and no menu anywhere in the pane.

## What it should do

Open a small actions menu for the **active tab**. Ship only actions that can
actually be performed with what exists today:

- **Close this tab** — remove it from `tabs`, and if it was active, activate its
  neighbour. Disable (do not hide) the item when only one tab is open.
- **Close others** — reduce `tabs` to just the active one.
- **Copy note path** — `navigator.clipboard.writeText(selectedNote.path)`.
  Disabled when no note is open.

That is the honest set. **Do not put Rename, Delete, Move, or "Reveal in
Explorer" on this menu.** None of them has an IPC channel behind it (see below),
and adding a menu item that does nothing is the exact defect this whole
`docs/buttons/` queue exists to remove.

Then remove `disabled` and `title={NOT_YET}`.

## What already exists to build on

- **The tab state and its setter.** `src/renderer/panes/vault/VaultPane.tsx:52-53`:
  `const [tabs, setTabs] = useState([{ id: 'default', name: 'Universal Vault' }])`
  and `const [activeTabId, setActiveTabId] = useState('default')`.
  `handleNewTab` at `VaultPane.tsx:308-312` shows the mutation idiom.
- **The wiring site** is `src/renderer/panes/vault/VaultPane.tsx:369-374`. Closing
  tabs needs new props (`onCloseTab`, `onCloseOthers`) threaded from there,
  because `setTabs` lives in `VaultPane` and `TabBar` only receives the array.
- **The open note**, for "Copy note path": `VaultPane.tsx:48` —
  `const [selectedNote, setSelectedNote] = useState<VaultNoteBody | null>(null)`.
  `VaultNoteBody` is `VaultNote & { text: string }`, and `VaultNote` carries
  `path`, `title`, `mtime` (`src/shared/ipc.ts:14-22`).
- **A complete overlay to copy**, including all the keyboard behaviour:
  `src/renderer/panes/vault/SettingsDialog.tsx`.
  - `SettingsDialog.tsx:78-102` — Escape to close, Tab trapped at both edges.
  - `SettingsDialog.tsx:69-76` — capture `document.activeElement` on open and
    restore focus on close.
  - `SettingsDialog.tsx:125-127` — dismiss on `onMouseDown`, not `onClick`, with
    the reasoning inline.
  - `SettingsDialog.tsx:21-22` — the `FOCUSABLE` selector, including why
    `:not(:disabled)` matters for items that are present but unusable.
  - `SettingsDialog.tsx:14` + `src/renderer/panes/vault/settings.css` — the
    sanctioned co-located-stylesheet pattern.
- **A working disabled-with-a-reason item, for the "only one tab" case:**
  `src/renderer/panes/vault/FolderTree.tsx:74-85` uses `disabled={!hasChildren}`
  on a row that cannot act.
- **Icon-button conventions:** `src/renderer/panes/vault/LeftRibbon.tsx:41-52`
  (`aria-label` on the button, `aria-hidden` on the icon, `aria-pressed` for
  state).
- `EllipsisVertical` is already imported at `TabBar.tsx:5`.
- **Prior art for the same button one row down:** the "More options" ellipsis in
  the note header (`src/renderer/panes/vault/MainCanvas.tsx:200-202`) is the
  *worse* version of this control — it has no handler **and** no `disabled`. See
  `note-more-options.md` in this directory; it is a separate item.

## What does NOT exist yet

- **Rename, delete or move.** The IPC contract at `src/shared/ipc.ts:141-163`
  registers six vault channels: `vault:tree`, `vault:list`, `vault:read`,
  `vault:save`, `vault:graph`, `vault:backlinks`. There is no rename, no delete,
  no move. The main-process registrations at `src/main/ipc.ts:50-55` confirm it.
  The note server exposes `/`, `/inbox`, `/notes`, `/note`, `/capture` and
  `/save` (`C:\Users\Nathan\Desktop\note-system\app\server.py`, `do_GET` around
  `server.py:636-670` and `do_POST` from `server.py:676`) and has no delete or
  rename endpoint either.
- **`shell.openPath` or any "reveal in folder" bridge.** Deliberately absent —
  `src/renderer/panes/corner/ArtifactItem.tsx:33-48` documents an
  attacker-influenced-path bypass and states *"There is no shell.openPath channel
  on the bridge."* Do not add one for a context menu.
- **Any menu or popover primitive** in `src/renderer/`. `SettingsDialog` is a
  modal; copy its keyboard and focus logic, not its layout.
- **A meaningful tab model.** Today a tab is `{ id, name }` and `activeTabId` is
  consumed only for a CSS class (`TabBar.tsx:28`). "Close tab" will work
  mechanically but will not change what is on screen until `tab-bar-tabs.md` in
  this directory is done. Note that in your report.
- **Styling for `.vault-tab-menu`.** The class appears nowhere in
  `src/renderer/app.css`; it inherits the global `button` rules at
  `app.css:70-73`.

## Constraints

- **Ship no dead menu items.** Every row must either act or be `disabled` with a
  title saying why — `docs/ACCESSIBILITY.md:48-49`.
- **Do not import `app.css`.** `test/review-s2-vault-pane.test.mjs:191-209` allows
  only a co-located stylesheet matching `^\./[a-z][a-z0-9-]*\.css$` and names
  `../../app.css` as the thing being prevented. Add
  `src/renderer/panes/vault/tabbar.css`.
- **No inline style objects, no hex colours, no `rgb()`/`hsl()`.**
  `test/review-s2-vault-pane.test.mjs:185-216`.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240` and `:796-801` ban
  `setTimeout`, `setInterval` and `queueMicrotask` in this pane.
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`. `navigator.clipboard` is a web
  API, not part of `window.api`, and is fine.
- **Remove every listener on unmount.** If you add a document-level
  click-outside handler, clean it up. `test/review-s2-vault-pane.test.mjs:397-424`
  exists because of leaked observers and frame loops.
- **Closing a tab must not silently drop the edit buffer.** Today the buffer is
  global to the pane, so closing a tab does not touch it — keep it that way.
  If you find yourself clearing `buffer` or `selectedNote` on tab close, stop:
  `test/review-s2-vault-pane.test.mjs:298-319` guards the "unsaved edits require
  an explicit confirmation" rule and it applies to anything that discards text.
- **Keep the class name `vault-tab-menu`.** No test asserts it today (unlike
  `vault-tab-chevron` at `:97` and `vault-tab-split` at `:98`), but the three are
  a set and renaming one makes the group harder to find.
- **Accessibility:** the button is icon-only with **no** `aria-label` today — add
  one. Add `aria-expanded`. `docs/ACCESSIBILITY.md:62-63` already records the tab
  bar's missing arrow-key navigation as a known gap; arrow keys inside your menu
  are welcome but not required to close this item.
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

1. The ellipsis is enabled, has an `aria-label`, and its tooltip is not "Not
   implemented yet".
2. Click it → a menu appears with exactly three items and no others.
3. With one tab open, "Close this tab" and "Close others" are visibly disabled
   and carry a title explaining why.
4. Click "+" twice, then "Close others" → the strip returns to one tab.
5. Click "+", then "Close this tab" → the tab disappears and a neighbour becomes
   active. The editor content and dirty state are unchanged.
6. With a note open, click "Copy note path", then paste into the editor → the
   vault-relative path appears (e.g. `Business/Home.md`).
7. With no note open, "Copy note path" is disabled.
8. Press Escape → the menu closes and focus returns to the ellipsis.
9. Click outside the menu → it closes.
10. Open and close the menu ten times, then switch to the Graph view → no
    console warnings about listeners or unmounted-component state updates.
