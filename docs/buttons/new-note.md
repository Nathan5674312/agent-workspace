---
tier: WIRE
control: "+ Note" button in the explorer header, above the folder tree
location: src/renderer/panes/vault/ExplorerHeader.tsx:30-37
status: NOT STARTED
---

# + Note

## Today

Nothing. The button is rendered with a hardcoded `disabled` attribute and a
tooltip that says why:

- `src/renderer/panes/vault/ExplorerHeader.tsx:30-37` — `<button className="vault-header-button" onClick={onNewNote} disabled title={NOT_YET}>`
- `src/renderer/panes/vault/ExplorerHeader.tsx:20` — `const NOT_YET = 'Not available yet — the vault IPC contract has no create call'`
- The handler it is wired to is a console stub: `src/renderer/panes/vault/VaultPane.tsx:298-301` — `handleNewNote` does `console.log('New note')` and nothing else.

There is no code path anywhere that removes the `disabled` attribute. It is a
literal, not a prop.

**The stated reason is out of date.** The comment at `ExplorerHeader.tsx:5-11`
and the `NOT_YET` string both claim the vault IPC contract has no create call.
It does — see "What already exists to build on". That claim was true when it was
written and is not true now, so do not take it at face value the way the file
invites you to.

## What it should do

Create a new empty markdown note in the vault, then open it in the editor with
the cursor in the body.

Concretely:

1. Pick a target folder. There is no selection state for folders in this pane
   today, so the honest v1 target is the vault root (`''`), or the folder of the
   currently open note (`selectedNote.path` minus its last segment) when one is
   open. Choose the second — it is what a person means by "new note" while they
   are reading something.
2. Pick a non-colliding filename. `Untitled.md`, then `Untitled 1.md`,
   `Untitled 2.md`, and so on. The existing tree in `vault.tree` is the list to
   check against; do not ask the server.
3. Call `window.api.vault.save(path, '', 0)` to create it (see below for why the
   `0` is correct and safe).
4. Refresh the folder tree so the new note appears. `useVault` currently loads
   the tree exactly once on mount (`src/renderer/panes/vault/useVault.ts:20-38`)
   and exposes no reload, so this needs a `reload()` added to that hook.
5. Open the new note through the existing `openNote(path)` in
   `src/renderer/panes/vault/VaultPane.tsx:177-186`, so it lands in the buffer,
   joins the navigation history, and brings the editor forward.
6. Remove the `disabled` attribute and the `title={NOT_YET}` from the button.

## What already exists to build on

**Creating a note is already possible over the existing IPC channel.** This is
the fact the whole task turns on.

- `src/preload/index.ts:27-28` exposes `vault.save(path, text, mtime)` on
  `window.api`.
- `src/main/ipc.ts:53` registers it: `handle(CH.vaultSave, (p, t, m) => vault.save(p, t, m))`.
- `src/main/vault.ts:307-321` — `save()` validates the path and mtime, then
  POSTs `{path, text, mtime}` to the note server's `/save`.
- The note server is `C:\Users\Nathan\Desktop\note-system\app\server.py` on
  `127.0.0.1:8765`. Its `/save` handler is at `server.py:750-783`. The critical
  lines:
  - `server.py:765` — `if p.exists():` guards the whole lost-update check. When
    the file does **not** exist, the mtime check is skipped entirely.
  - `server.py:763-764` — the comment says it outright: *"Creating a note still
    needs no stamp: there is no version to lose."*
  - `server.py:778` — `atomic_write(p, data["text"])` then creates the file.
- `src/main/vault.ts:170-175` — `requireMtime()` rejects `undefined`, `null` and
  `NaN`, but **accepts `0`** (it is finite). The comment at `vault.ts:169`
  explains that 0 is deliberately kept working. So `save(path, '', 0)` passes
  the renderer-side guard and creates the file server-side.
- `src/main/vault.ts:319` — `save()` calls `invalidateGraph()`, so the graph
  memo is already dropped for you on create. Nothing extra needed there.
- `openNote()` at `src/renderer/panes/vault/VaultPane.tsx:177-186` loads a note
  into the buffer, truncates forward history and advances the nav cursor. It
  returns `Promise<boolean>` — `false` when the open was refused (open conflict
  dialog, declined discard prompt, failed read). Respect the return value.
- `src/renderer/panes/vault/MainCanvas.tsx:141-144` — an effect keyed on
  `note?.path` sets the view to `'editor'` whenever a note opens, from anywhere.
  So you do not need to touch view state; opening the note brings the editor
  forward by itself.
- Sibling pattern for a working header button: the Collapse-all and Expand-all
  buttons right beside this one (`ExplorerHeader.tsx:46-59`) are live, wired to
  `handleCollapseAll` / `handleExpandAll` at `VaultPane.tsx:323-329`.

## What does NOT exist yet

- **A tree reload.** `useVault` (`src/renderer/panes/vault/useVault.ts:20-38`)
  fetches `tree()` once in a mount effect with no way to re-run it. You must add
  a `reload()` to the hook's return value and call it after the create. Keep the
  `let cancelled = false` cancellation pattern already in that effect —
  `test/review-s2-vault-pane.test.mjs:426-435` asserts `useVault.ts` and
  `VaultPane.tsx` both contain `let cancelled = false` and `cancelled = true`.
- **Any notion of a "selected folder".** The folder tree
  (`src/renderer/panes/vault/FolderTree.tsx`) tracks expansion only, via the
  `expanded: Set<string>` prop. There is no selected-folder state to read.
- **A rename or delete path.** If the user does not want `Untitled.md`, there is
  nothing to fix it with. That is acceptable for this task; do not build it.
- **A `vault:create` channel.** Do not add one. `vault:save` already does this
  and adding a second write door means two things to keep the guards in sync
  across.

## Constraints

- **Do not add an auto-save of any kind.** `test/review-s2-vault-pane.test.mjs:230-240`
  hard-fails on `setInterval`, `setTimeout`, `requestIdleCallback`, `debounce`,
  `throttle`, `onBlur=`, `beforeunload`, `visibilitychange` and `pagehide`
  anywhere in `src/renderer/panes/vault/`. Creating a file on a click is fine;
  writing on a timer is not.
- **`onSave` must stay single-callsite.** `test/review-s2-vault-pane.test.mjs:242-250`
  asserts `Editor.tsx` invokes `onSave(` exactly once. Your create path must call
  `window.api.vault.save` / `vault.saveNote` from `VaultPane.tsx`, not by routing
  through the editor's save handler.
- **The pane may only touch `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172` enforces this.
- **No inline styles, no hex colours, no `rgb()`/`hsl()`.**
  `test/review-s2-vault-pane.test.mjs:185-216`. The button already has
  `.vault-header-button`; reuse it.
- **Failures must be visible in the UI, not the console.** This pane's own
  review history is about exactly that — see `VaultPane.tsx:98-99`
  (`openError` state) and the error banner it renders at `VaultPane.tsx:376-383`.
  Reuse `setOpenError` or add a sibling state; do not `console.error`.
- **Accessibility:** `docs/ACCESSIBILITY.md:48-49` — *"Controls that cannot act
  are `disabled` with a title explaining why, rather than looking live and
  silently doing nothing."* When the control can act, the `disabled` and the
  stale `title` must both go, not just one.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/app.css`.
- Before editing `src/shared/ipc.ts`, run `git status` — that file has carried
  uncommitted work from another session. You should not need it for this task.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev` with the note server running on 127.0.0.1:8765:

1. The "+ Note" button is enabled and has no "not available" tooltip.
2. Click it with no note open → a new note appears in the folder tree at the
   vault root and opens in the editor, empty, titled `Untitled`.
3. Type a character → the status beside Save reads "Unsaved changes"; click Save
   → it reads "Saved" and no conflict dialog appears.
4. Click "+ Note" again → the second note is `Untitled 1.md`, not an error and
   not a silent overwrite of the first.
5. Stop the note server, click "+ Note" → a visible error message appears in the
   pane. Nothing is logged only to the console.
6. Confirm on disk: `ls "C:\Users\Nathan\Desktop\Universal Vault\Untitled.md"`
   exists. Delete the test notes afterwards.
