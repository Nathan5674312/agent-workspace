---
tier: WIRE
control: "+ Folder" button in the explorer header, above the folder tree
location: src/renderer/panes/vault/ExplorerHeader.tsx:38-45
status: NOT STARTED
---

# + Folder

## Today

Nothing. The button is rendered with a hardcoded `disabled` attribute:

- `src/renderer/panes/vault/ExplorerHeader.tsx:38-45` — `<button className="vault-header-button" onClick={onNewFolder} disabled title={NOT_YET}>`
- `src/renderer/panes/vault/ExplorerHeader.tsx:20` — `const NOT_YET = 'Not available yet — the vault IPC contract has no create call'`
- The handler behind it is a console stub:
  `src/renderer/panes/vault/VaultPane.tsx:303-306` — `handleNewFolder` does
  `console.log('New folder')` and returns.

Nothing in the codebase ever clears that `disabled`; it is a literal attribute,
not a prop.

Unlike its neighbour "+ Note", **the stated reason here is genuinely true.**
There is no create-directory call anywhere in the stack. Do not assume the two
buttons are the same job.

## What it should do

Create a real directory inside the vault and show it in the folder tree.

Concretely:

1. Add a `vault:mkdir` channel to the IPC contract and a main-process handler
   that creates the directory under the vault root.
2. On click, prompt for a name (a `window.prompt` is acceptable here — the pane
   already uses `window.confirm` for the dirty-buffer guard at
   `VaultPane.tsx:149-152`, so a native dialog is an established idiom in this
   file, not a new one).
3. Create it at the vault root, or inside the folder of the currently open note
   when one is open. There is no selected-folder state, so root is the honest
   default.
4. Reload the tree so it appears, and expand it.
5. Remove the `disabled` and the `title={NOT_YET}` from the button.

The new folder will be empty. An empty directory is invisible to the note server
(which indexes `.md` files) but **is** visible in the explorer, because the tree
is read directly off disk — see below. That asymmetry is fine and expected.

## What already exists to build on

- **The main process already reads the vault directory directly with `node:fs`.**
  `src/main/vault.ts:344-415` — `tree()` imports `readdir`, `realpath` and
  `stat` from `node:fs/promises` and walks `VAULT_DIR` itself. The comment at
  `vault.ts:330-343` explains the precedent: *"Reading the directory here does
  not reintroduce the risk that put writes behind the Python server: that was
  about atomic writes, backups and the lost-update guard. A directory listing has
  none of those hazards."* **`mkdir` has none of those hazards either** — there
  is no file content, no version to lose, no backup to keep. This is the
  argument that makes a direct `fs.mkdir` correct rather than a shortcut.
- `src/main/vault.ts:27-51` — `VAULT_DIR` is the vault root, with `getVaultDir()`
  already exported to read it.
- `src/main/vault.ts:328` — `const HIDDEN = new Set([...])` is the folder
  exclusion list the tree honours; a new folder must not collide with it.
- **The channel-adding pattern, end to end**, most recently done for settings.
  Copy it exactly:
  - `src/shared/ipc.ts:141-163` — add the channel name to the `CH` object.
  - `src/shared/ipc.ts:175-205` — add the method to the `Api` type.
  - `src/preload/index.ts:22-50` — add the `ipcRenderer.invoke` line.
  - `src/main/ipc.ts:49-60` — register it with the `handle()` wrapper, which
    already enforces the top-frame check (`src/main/ipc.ts:21-47`) and converts
    throws into plain messages across the bridge.
- `src/main/settings.ts` is the newest module doing exactly this shape and is
  the one to read as a model.
- `src/renderer/panes/vault/useVault.ts:20-38` — the tree-loading effect you
  will need to make re-runnable.
- `src/renderer/panes/vault/VaultPane.tsx:314-329` — `handleToggleFolder`,
  `handleExpandAll`, `handleCollapseAll` all mutate the `expanded: Set<string>`
  state; expanding the new folder after creating it is `setExpanded(prev => new Set(prev).add(path))`.
- Sibling live buttons in the same component: Collapse-all and Expand-all at
  `src/renderer/panes/vault/ExplorerHeader.tsx:46-59`.

## What does NOT exist yet

Almost all of it. Be explicit with yourself about the size:

- **No IPC channel.** `CH` in `src/shared/ipc.ts:141-163` has no create/mkdir
  entry. You are adding one.
- **No main-process handler.** `src/main/ipc.ts:50-55` registers six vault
  channels; none creates anything.
- **No server support, and you do not want any.** The note server's `/save`
  (`C:\Users\Nathan\Desktop\note-system\app\server.py:750-783`) writes files, not
  directories, and `atomic_write` (`server.py:182-209`) stages its temp file in
  the **target's parent directory** — so writing `NewFolder/note.md` into a
  folder that does not exist throws `FileNotFoundError`, which `server.py:671`
  turns into a 400. You cannot create a folder by creating a note inside it.
- **No path validation on the renderer side for a user-typed name.** The name
  crosses IPC from an untrusted renderer. Your main-process handler must reject
  anything that escapes the vault. Copy the shape of the server's `safe()`
  (`server.py:386-392`): resolve the joined path and require the vault root to be
  among its parents. Reject `..`, absolute paths, and drive letters. This is the
  single most important line of the task.
- **No tree reload.** See `useVault.ts:20-38`.

## Constraints

- **Do not let the renderer nominate an arbitrary path.** The precedent is
  explicit at `src/shared/ipc.ts:38-45`: settings' `pickVaultDir()` takes no
  argument *"so the renderer cannot nominate a directory for the app to read
  from."* A folder name is unavoidably renderer-supplied, so the validation has
  to be in main, not in the component.
- **The pane may only touch `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`. Put `mkdir` under `vault`.
- **No node, electron or network imports in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155` bans `fetch(`, `require(`,
  `XMLHttpRequest`, `WebSocket`, `from 'electron'`, `from 'node:`,
  `ipcRenderer` and `process.` in every pane source. All filesystem work is in
  main.
- **No timers, no auto-save.** `test/review-s2-vault-pane.test.mjs:230-240` and
  `:796-801`.
- **No inline styles, no hex colours.** `test/review-s2-vault-pane.test.mjs:185-216`.
- **Failures must surface in the UI.** Reuse the `openError` banner pattern at
  `VaultPane.tsx:98-99` and `VaultPane.tsx:376-383`. A failed mkdir that only
  logs is the defect this whole document set exists to remove.
- **Accessibility:** `docs/ACCESSIBILITY.md:48-49` — remove the `disabled` *and*
  the now-false `title` together.
- **`src/shared/ipc.ts` has carried uncommitted work from another session.** Run
  `git status` before you touch it, and if it is dirty, add your channel without
  reformatting anything around it.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/app.css`.

## Acceptance

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
npm run build         # expect: tsc clean, then electron-vite build succeeds
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Add a test for the traversal guard — this is the part that must not be verified
by hand alone. `test/` runs under `node --experimental-strip-types`, and
`src/main/vault.ts` is already imported directly by the existing main-process
tests, so the guard is testable without a DOM. Assert that a name containing
`..`, a leading `/`, or `C:\` is rejected and that no directory is created
outside a scratch vault dir (`_setVaultDirForTest` at `src/main/vault.ts:32-34`
exists for exactly this).

Manual, in `npm run dev`:

1. "+ Folder" is enabled, with no "not available" tooltip.
2. Click it, type `Scratch` → `Scratch` appears in the folder tree, expanded and
   empty.
3. Click it, type `../Escape` → a visible error in the pane; nothing is created
   at `C:\Users\Nathan\Desktop\Escape`. Verify that path does not exist.
4. Restart the app → `Scratch` is still there (it is a real directory).
5. Remove the `Scratch` directory afterwards.
