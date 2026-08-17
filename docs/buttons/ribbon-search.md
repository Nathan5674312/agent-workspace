---
tier: DECIDE
control: The magnifying-glass "Search" icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:28 (definition), :41-52 (render)
status: NOT STARTED
---

# Ribbon: Search

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar**.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views:
  `files`, `search`, `bookmarks`, `graph`, `canvas`, `calendar`, `terminal`,
  `plugins`. `search` is at `LeftRibbon.tsx:28`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing to the state declared at `VaultPane.tsx:47`
  (`const [activeRibbon, setActiveRibbon] = useState('files')`).
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345`:
  ```tsx
  {activeRibbon === 'files' && (
    <> <ExplorerHeader .../> <FolderTree .../> </>
  )}
  ```

So selecting Search un-renders the explorer header and the folder tree, and
renders nothing in their place. The sidebar collapses to the vault switcher row
at the bottom (`VaultPane.tsx:362-365`). The icon does gain its selected state —
`aria-pressed` and the `vault-ribbon-icon--active` class
(`LeftRibbon.tsx:43,48`, styled at `src/renderer/app.css:125`) — so the app
reports "you are in Search" while showing an empty panel.

This is not a missing handler. It is a handler wired to a switch with seven
unbuilt positions.

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Should this app have its own search at all, or should the Search icon be
removed from the ribbon?**

And if it stays, which of these three is it:

1. **Filename search only** — type a fragment, get matching note names. Cheap,
   and it can be computed from the tree already in memory.
2. **Full-text search across the vault** — the thing people mean by "search".
   Requires reading every note's body.
3. **Neither — delete the icon.** Seven of the eight ribbon icons are unbuilt;
   the honest ribbon might be one icon wide.

### Where this duplicates Obsidian

**Directly and almost completely.** This app manages a real Obsidian vault at
`C:\Users\Nathan\Desktop\Universal Vault` — the same files, on the same disk,
that Obsidian has open. Obsidian's built-in search already does full-text with
operators (`path:`, `file:`, `tag:`, `line:`, `section:`), regex, case
sensitivity, and result grouping by note, over that identical vault. It is
mature, indexed, and free.

Re-solving Obsidian is a known trap in this project. The bar for building search
here is not "search would be useful" — it obviously would. The bar is **"what can
this app's search do that Obsidian's cannot?"** If there is no answer, option 3
is correct.

### What is at stake either way

**If it is built (options 1 or 2):**
- Option 2 has a real cost. The only way to read note bodies today is
  `vault.read(path)` one note at a time over HTTP
  (`src/main/vault.ts:293-305`). `buildGraph` already does this across the whole
  vault and the cost is documented at `src/main/vault.ts:427-443`: on an
  800-note vault a single full scan issues 800 GET requests, against a Python
  server that *"serialises every request on one module-wide lock"*
  (`src/main/vault.ts:432-434`). It is pooled to 8 concurrent workers
  (`src/main/vault.ts:511-546`) and memoised with a 30s TTL
  (`src/main/vault.ts:444-465`) precisely because it is expensive. A naive
  search-as-you-type would re-pay that per keystroke.
- Option 2 therefore implies an index, which implies invalidation, which implies
  a file watcher — none of which exists. That is a project, not a button.
- Option 1 is much cheaper and is arguably already served: the database view has
  a live filter over name and path
  (`src/renderer/panes/vault/DatabaseView.tsx:154-163`, filtering at
  `DatabaseView.tsx:91-97`). If option 1 is the answer, the real question becomes
  "why is this a second place to do what the Database tab already does?"

**If it is removed:**
- The ribbon shrinks and the app stops advertising a capability it does not have.
- `test/review-s2-vault-pane.test.mjs:70-84` asserts all eight view ids are
  present in `LeftRibbon.tsx` and will fail. That test encodes the *original
  brief's* eight-icon layout, so removing an icon is a deliberate revision of the
  spec, not an accident — update the test in the same change and say so.
- Someone must decide whether the other six unbuilt icons go with it. They are
  documented separately in this directory: `ribbon-bookmarks.md`,
  `ribbon-graph.md`, `ribbon-canvas.md`, `ribbon-calendar.md`,
  `ribbon-terminal.md`, `ribbon-plugins.md`.

### The one thing to do regardless of the answer

Whatever is decided, **the sidebar must not silently empty**. That is a bug
independent of the scope question: today, six clicks in the ribbon produce a
blank panel with no message. Either the unbuilt icons become `disabled` with a
title (the idiom used everywhere else in this pane — see
`src/renderer/panes/vault/TabBar.tsx:38-48`), or `VaultPane.tsx:345` gains an
else-branch rendering a plain "Not built yet" panel. This is a small, safe change
and does not need the scope decision.

## What already exists to build on

Recorded so that whoever implements a decision does not re-derive it:

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The sidebar container** is `.vault-sidebar` at `VaultPane.tsx:344-366`. Any
  new panel is a sibling of `<ExplorerHeader>`/`<FolderTree>` inside it.
- **A working filter UI, in this pane, to copy:**
  `src/renderer/panes/vault/DatabaseView.tsx:154-163` — a controlled
  `<input type="search">` with an `aria-label` and a Lucide `Search` icon; the
  filtering itself is at `DatabaseView.tsx:91-97` and is wrapped in a `useMemo`
  keyed on every input (`DatabaseView.tsx:87-128`).
- **The note list with metadata**, if filename/frontmatter search is chosen:
  `useVault().getNotes()` at `src/renderer/panes/vault/useVault.ts:64-67`, backed
  by `src/main/vault.ts:179-221`, which returns `path`, `title`, `folder`,
  `type`, `status`, `updated`, `depth`, `orphan` per note. **Trap:** rows from
  `list()` always carry `mtime: 0` — the warning is at `src/main/vault.ts:212-218`.
- **The folder tree already in memory:** `vault.tree` at `VaultPane.tsx:106`, and
  `indexNotesByName` / `collectFolderPaths` in
  `src/renderer/panes/vault/helpers.ts` for walking it.
- **The note server's endpoints**, if a server-side search is ever proposed:
  `C:\Users\Nathan\Desktop\note-system\app\server.py` serves `/`, `/inbox`,
  `/notes`, `/note`, `/capture`, `/save`. There is no search endpoint. The
  comment at `src/main/vault.ts:233-238` records this was checked.
- **Icon and selected-state conventions:** `LeftRibbon.tsx:41-52` —
  `aria-label` on the button, `aria-hidden="true"` on the Lucide icon,
  `aria-pressed` for selection.

## What does NOT exist yet

- **Any search of any kind**, in the renderer or the main process. Grep `src/`
  for "search": the only hits are the Lucide `Search` icon import in
  `LeftRibbon.tsx:11` and `DatabaseView.tsx:2`, and
  `<input type="search">` in `DatabaseView.tsx:157`.
- **A search IPC channel.** `CH` (`src/shared/ipc.ts:141-163`) has six vault
  channels; none searches. `src/main/ipc.ts:50-55` confirms.
- **A full-text index, and anything that could invalidate one.** The only cache
  in the data layer is the wikilink graph memo
  (`src/main/vault.ts:444-465`), invalidated by our own saves
  (`src/main/vault.ts:319`) and otherwise by a 30-second TTL.
- **A file watcher.** `src/main/vault.ts:448` notes `invalidateGraph()` is
  *"exported so a future watcher can call it"* — there is no watcher.
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one
  branch and no else.

## Constraints

- **The scope question above must be answered by a human before any code is
  written.** Do not implement a "small version to start with" — a half-built
  search that only matches filenames while the icon says "Search" is the same
  class of defect as the dead button, moved one layer in.
- **The vault is a real Obsidian vault and is read-only by default for agents.**
  Any answer that involves writing an index into the vault folder needs explicit
  approval; a generated index is not a note.
- **No timers.** `test/review-s2-vault-pane.test.mjs:230-240` and `:796-801` ban
  `setTimeout`, `setInterval` and `queueMicrotask` across this pane — which rules
  out the debounce that a search-as-you-type input normally wants. The test names
  `debounce` and `throttle` explicitly at `:236`. Any incremental search must be
  driven by React state alone, or the invariant needs a deliberate, argued
  revision.
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`.
- **No node, electron or network access in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155` bans `fetch(`, `require(`,
  `XMLHttpRequest`, `WebSocket`, `from 'electron'`, `from 'node:`,
  `ipcRenderer`, `process.`.
- **No inline styles, no hex colours, no `app.css` import.**
  `test/review-s2-vault-pane.test.mjs:185-216`.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer to the scope question, recorded
where the project's decisions live, naming which of the three options was chosen
and — if the answer is "build it" — the one thing this search does that
Obsidian's does not. Then update `status:` in this file's frontmatter.

**For the sidebar-empties bug**, which can be closed now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the Search icon. The sidebar must show either a
real panel or an explicit "not built" message — never an empty column with the
icon lit. Clicking Files must restore the tree with its expansion state intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail, because it asserts all eight ids are present. Update that test in the
same commit and state in your report that you changed a spec assertion, not just
code.
