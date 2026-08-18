---
tier: DECIDE
control: The bookmark "Bookmarks" icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:29 (definition), :41-52 (render)
status: NOT STARTED
---

> **⚠ STALE IN ONE PLACE (checked 2026-08-18).** Everything below about the
> sidebar going blank when this icon is clicked is fixed. `activeRibbon` used
> to have exactly one consumer; commit `4bc9878` added
> `src/renderer/panes/vault/SidebarPlaceholder.tsx`, which renders a panel
> naming the feature this icon is a promise of. Skip the "fix the blank panel
> first" instruction. The scope question this file asks is still open and is
> still why the icon is not built.


# Ribbon: Bookmarks

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar**.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views;
  `bookmarks` is at `LeftRibbon.tsx:29`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing the state declared at `VaultPane.tsx:47`.
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345`:
  ```tsx
  {activeRibbon === 'files' && (
    <> <ExplorerHeader .../> <FolderTree .../> </>
  )}
  ```

So selecting Bookmarks removes the explorer header and folder tree and renders
nothing in their place — the sidebar collapses to the vault switcher row
(`VaultPane.tsx:362-365`). The icon still lights up and reports `aria-pressed`
(`LeftRibbon.tsx:43,48`; styled at `src/renderer/app.css:125`), so the app says
"you are in Bookmarks" over an empty panel.

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Where would a bookmark be stored, and does this app own that store?**

That is the whole decision, and it is not a UI question. A bookmark is
persistent user data about the vault. There are three possible homes and they
have different consequences:

1. **Obsidian's own store** — `.obsidian/bookmarks.json` inside the vault.
   Reading it means this app renders the *same* bookmarks Obsidian shows.
   Writing it means this app edits Obsidian's config file.
2. **This app's own store** — a new file in Electron's `userData`, alongside
   whatever `src/main/settings.ts` persists. Independent, private, and
   invisible to Obsidian.
3. **Frontmatter in the notes themselves** — e.g. a `bookmarked: true` field.
   Portable, visible in Obsidian, but means writing to every bookmarked note.

Or, as with the other six unbuilt ribbon icons: **remove it.**

### Where this duplicates Obsidian

**Completely.** Obsidian has a first-party Bookmarks core plugin. It bookmarks
notes, folders, searches, graphs and even text selections, supports nested
groups, and stores the result in `.obsidian/bookmarks.json` inside this very
vault. This app manages that same vault, so any bookmark list built here is a
second list over the same notes.

Re-solving Obsidian is a known trap in this project. Option 1 above is the only
one that is *not* a re-solve — it is a read of Obsidian's data. Options 2 and 3
both create a second, divergent set of bookmarks over one set of notes, and the
question "which list is right?" has no good answer. Note that
`src/main/vault.ts:328` deliberately hides `.obsidian` from the folder tree as
*"machine state, not content"* — reading its bookmarks file would be the first
time this app treats that directory as a data source, which is exactly the kind
of coupling that deserves a human decision rather than a default.

### What is at stake either way

**If it is built:**
- Option 1 couples this app to Obsidian's on-disk config format, which is
  undocumented and can change between Obsidian releases. Read-only is defensible;
  writing to it risks corrupting a file Obsidian owns.
- Options 2 and 3 create the divergence described above. Option 3 additionally
  means a write to every bookmarked note, through the save path — which carries
  a lost-update guard (`src/main/vault.ts:307-321`,
  `C:\Users\Nathan\Desktop\note-system\app\server.py:750-783`) that a
  bookmark-star click has nowhere to display. The database view already declined
  editable cells for exactly this reason; the reasoning is written out at
  `src/renderer/panes/vault/DatabaseView.tsx:28-32`. Read it before choosing
  option 3.
- Any option needs a new IPC channel and a persistence layer, plus a place to
  add and remove bookmarks from — which is a second control this queue does not
  yet cover.

**If it is removed:**
- `test/review-s2-vault-pane.test.mjs:70-84` asserts all eight ribbon ids exist
  and will fail. That test encodes the original brief's eight-icon layout, so
  removing an icon is a deliberate spec revision — update the test in the same
  change and say so in the report.
- The same question applies to the other six unbuilt icons, documented separately
  here: `ribbon-search.md`, `ribbon-graph.md`, `ribbon-canvas.md`,
  `ribbon-calendar.md`, `ribbon-terminal.md`, `ribbon-plugins.md`.

### The one thing to do regardless of the answer

**The sidebar must not silently empty.** Six ribbon icons currently produce a
blank panel with no message. Either the unbuilt icons become `disabled` with a
title — the idiom used everywhere else in this pane, see
`src/renderer/panes/vault/TabBar.tsx:38-48` — or `VaultPane.tsx:345` gains an
else-branch rendering an explicit "Not built yet" panel. Small, safe, and
independent of the scope decision.

## What already exists to build on

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The sidebar container** is `.vault-sidebar` at `VaultPane.tsx:344-366`. A
  bookmarks panel is a sibling of `<ExplorerHeader>`/`<FolderTree>` inside it.
- **A working persisted-setting path, end to end** — the closest existing analogue
  to "this app stores something of its own":
  - `src/main/settings.ts` (the store)
  - `src/shared/ipc.ts:46-60` (`AppSettings`), `:161-162` (`CH.settingsGet`,
    `CH.settingsPickVaultDir`), `:197-204` (the `Api.settings` surface)
  - `src/preload/index.ts:44-49`
  - `src/main/ipc.ts:59` (`settings.register(handle)`)
  - `src/renderer/panes/vault/SettingsDialog.tsx:41-57` (reading it on open)
  Copy this shape for any new persisted store.
- **A read-only list view over notes, in this pane:**
  `src/renderer/panes/vault/InboxView.tsx` — a list of notes with a title, a
  date, tags, and an open button, plus an explicit zero state at
  `InboxView.tsx:32-41` that *says what the empty state means* rather than just
  reporting an empty list. That is the model for a bookmarks panel.
- **Opening a note from a list:** `openNote(path)` at
  `src/renderer/panes/vault/VaultPane.tsx:177-186` returns `Promise<boolean>`,
  and `false` means the open was refused (open conflict, declined discard, failed
  read). Callers must respect it — the reasoning is at `VaultPane.tsx:169-176`,
  and the existing callsites are `MainCanvas.tsx:254-258`, `:265-273`, `:293-300`.
- **The vault root on disk**, if option 1 is chosen:
  `src/main/vault.ts:27-51` (`VAULT_DIR`, `getVaultDir()`), and
  `src/main/vault.ts:344-415` shows main-process `node:fs` reads of the vault
  directory are an established, argued pattern (`vault.ts:330-343`).
- **Icon and selected-state conventions:** `LeftRibbon.tsx:41-52`.

## What does NOT exist yet

- **Any bookmark, favourite, star or pin concept**, anywhere in `src/`. Grep
  confirms: the only hit is the Lucide `Bookmark` icon import at
  `LeftRibbon.tsx:12`.
- **Any per-note user state store.** `AppSettings` (`src/shared/ipc.ts:46-60`)
  holds exactly one setting, the vault directory.
- **A bookmarks IPC channel.** `CH` (`src/shared/ipc.ts:141-163`) has six vault
  channels and two settings channels; none is about bookmarks.
- **Any reader for `.obsidian/`.** `src/main/vault.ts:328` lists `.obsidian` in
  `HIDDEN` and skips it entirely.
- **A control that would *create* a bookmark.** Even with a panel, there is no
  star button on a note anywhere in the app. The panel is half the feature.
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one branch
  and no else.

## Constraints

- **The scope question must be answered by a human before any code is written.**
  Building a panel before deciding where bookmarks live means building the panel
  twice.
- **🔒 The vault is read-only by default for agents.** Writing
  `.obsidian/bookmarks.json` or adding frontmatter to notes is a vault write and
  needs explicit approval for that specific thing. Reading and listing are always
  fine.
- **Do not make frontmatter editable as a side effect.** The database view
  deliberately kept status read-only, and the reasoning at
  `src/renderer/panes/vault/DatabaseView.tsx:28-32` applies verbatim: the save
  path owns a `SaveConflict` guard *"that a table cell has nowhere to show. That
  is a feature, not a missing afternoon."*
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`. A new `window.api.bookmarks`
  surface would fail that test and needs the allowlist updated deliberately.
- **No node, electron or network access in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155`.
- **No timers, no auto-save.** `test/review-s2-vault-pane.test.mjs:230-240`,
  `:796-801`.
- **No inline styles, no hex colours, no `app.css` import.**
  `test/review-s2-vault-pane.test.mjs:185-216`.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer naming which of the four options
was chosen, and — if it is 2 or 3 — the argument for why a second bookmark list
over the same vault is better than reading Obsidian's. Then update `status:` in
this file's frontmatter.

**For the sidebar-empties bug**, closable now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the Bookmarks icon. The sidebar must show either
a real panel or an explicit "not built" message — never an empty column with the
icon lit. Clicking Files must restore the tree with its expansion state intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail. Update it in the same commit and state in your report that you changed
a spec assertion, not just code.
