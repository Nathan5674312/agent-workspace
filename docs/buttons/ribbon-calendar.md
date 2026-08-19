---
tier: DECIDE
control: The calendar "Daily notes" icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:32 (definition), :41-52 (render)
status: DONE
---

> **✅ BUILT 2026-08-18.** The scope question this file says a human must answer
> was answered by LOOKING, not by guessing: the vault has `Daily/YYYY-MM-DD.md`
> plus a `Daily/_Template.md`, and no date-named notes anywhere else. So the
> panel reads the folder and the filename shape off the vault tree, marks days
> that have notes, and creates a missing day from that template — which is the
> "does clicking a date CREATE one" question answered yes, because that is the
> point of daily notes. See `src/renderer/panes/vault/DailyNotesView.tsx` and
> `src/shared/daily.ts`. The Obsidian-duplication argument below still stands
> and is worth reading before this grows further.


> **⚠ STALE IN ONE PLACE (checked 2026-08-18).** Everything below about the
> sidebar going blank when this icon is clicked is fixed. `activeRibbon` used
> to have exactly one consumer; commit `4bc9878` added
> `src/renderer/panes/vault/SidebarPlaceholder.tsx`, which renders a panel
> naming the feature this icon is a promise of. Skip the "fix the blank panel
> first" instruction. The scope question this file asks is still open and is
> still why the icon is not built.


# Ribbon: Daily notes

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar**.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views; `calendar`
  (labelled "Daily notes") is at `LeftRibbon.tsx:32`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing the state at `VaultPane.tsx:47`.
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345` — the `activeRibbon === 'files'`
  branch rendering the explorer header and folder tree. There is no else.

The sidebar collapses to the vault switcher row (`VaultPane.tsx:362-365`) while
the icon lights up and reports `aria-pressed` (`LeftRibbon.tsx:43,48`).

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Does this vault have a daily-notes practice, and if so what is its file
convention?**

This is the unusual one in the ribbon set: it cannot be scoped from the code at
all, because the answer lives in how the vault is actually used. Before any
design question, someone has to state:

- **Do daily notes exist in this vault today?** If the answer is no, the feature
  is a calendar with nothing behind it and the icon should go.
- **If yes: what is the path template?** `Daily/2026-08-16.md`?
  `Journal/2026/08/16.md`? A `type: daily` frontmatter field? The app has no way
  to guess, and guessing wrong makes every date in the calendar a dead link.
- **Is the panel a calendar, or just "open today's note"?** Obsidian's core Daily
  Notes plugin is the second; the Calendar community plugin is the first. They
  are different features with different costs.
- **Should clicking a date with no note CREATE one?** That is the point of daily
  notes, and it turns a read-only panel into a write feature — see "What is at
  stake".

Or, as with the other six unbuilt ribbon icons: **remove it.**

### Where this duplicates Obsidian

**Squarely.** Obsidian ships Daily Notes as a first-party core plugin: a date
format, a folder, an optional template, a "open today's note" command and a
ribbon icon. The widely used Calendar community plugin adds the month grid with
dots for days that have notes. Both operate on this same vault.

Re-solving Obsidian is a known trap in this project. A calendar built here would
render the same daily notes Obsidian already indexes, from the same folder, and
would additionally need to be told the date format that Obsidian already has
configured in `.obsidian/`. The bar for building is **"what does a calendar here
do that Obsidian's does not?"**

One possible genuine answer, worth putting to the human explicitly: this app has
an **Inbox** of agent-captured notes that Obsidian knows nothing about
(`src/renderer/panes/vault/InboxView.tsx:4-20`, and the `captured` date parsed
per item). A time-based view over *agent activity* — what was captured on which
day — is not something Obsidian can offer, because the proposal frontmatter is
this system's own. If a date view is built, that is the version with a reason to
exist. Note it is a different feature from daily notes.

### What is at stake either way

**If it is built:**
- **Creating a note on click is a vault write.** The path exists —
  `window.api.vault.save(path, text, 0)` creates a file, because the note server
  skips its lost-update guard when the file does not exist
  (`C:\Users\Nathan\Desktop\note-system\app\server.py:765`, and the comment at
  `:763-764`: *"Creating a note still needs no stamp: there is no version to
  lose."*). But `atomic_write` (`server.py:182-209`) stages its temp file in the
  target's **parent directory**, so creating `Daily/2026-08-16.md` fails if
  `Daily/` does not exist. See `new-folder.md` in this directory.
- **A template would be needed**, and there is no template system. Obsidian's
  daily-note template lives in `.obsidian/`, which this app deliberately hides
  as *"machine state, not content"* (`src/main/vault.ts:328`).
- **Marking "which days have notes" costs a vault scan.** `vault.getNotes()`
  returns 258 rows with an `updated` field
  (`src/renderer/panes/vault/useVault.ts:64-67`, `src/main/vault.ts:179-221`) —
  but that `updated` is **frontmatter, not filesystem mtime**, so it says when
  someone last wrote a date into the note, not when the file changed. And rows
  from `list()` always carry `mtime: 0`; the trap is documented at
  `src/main/vault.ts:212-218`. Matching days by *filename* is the only reliable
  route, which is why the path convention question above is load-bearing.

**If it is removed:**
- `test/review-s2-vault-pane.test.mjs:70-84` asserts all eight ribbon ids exist
  and will fail. That test encodes the original brief's eight-icon layout, so
  removing an icon is a deliberate spec revision — update the test in the same
  change and say so.
- The same question applies to the other six unbuilt icons, documented separately
  here: `ribbon-search.md`, `ribbon-bookmarks.md`, `ribbon-graph.md`,
  `ribbon-canvas.md`, `ribbon-terminal.md`, `ribbon-plugins.md`.

### The one thing to do regardless of the answer

**The sidebar must not silently empty.** Either the unbuilt ribbon icons become
`disabled` with a title — the idiom used everywhere else in this pane, see
`src/renderer/panes/vault/TabBar.tsx:38-48` — or `VaultPane.tsx:345` gains an
else-branch with an explicit "Not built yet" panel.

## What already exists to build on

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The sidebar container** is `.vault-sidebar` at `VaultPane.tsx:344-366`. A
  calendar panel is a sibling of `<ExplorerHeader>`/`<FolderTree>` inside it.
- **The note list with dates:** `vault.getNotes()` at
  `src/renderer/panes/vault/useVault.ts:64-67`, backed by
  `src/main/vault.ts:179-221`, returning `path`, `title`, `folder`, `type`,
  `status`, `updated`, `depth`, `orphan`. `updated` is a frontmatter string.
- **The date-grouping precedent:** the database view already sorts and groups by
  the `updated` column (`src/renderer/panes/vault/DatabaseView.tsx:44-50`,
  `:100-108`, `:87-128`). Read `DatabaseView.tsx:100-108` for the "empty sorts
  last regardless of direction" rule, which matters for a field 190 of 258 notes
  do not have.
- **Note creation is possible over the existing channel.**
  `window.api.vault.save(path, text, mtime)` —
  `src/preload/index.ts:27-28` → `src/main/ipc.ts:53` →
  `src/main/vault.ts:307-321`. `requireMtime` (`src/main/vault.ts:170-175`)
  rejects `null`/`undefined`/`NaN` but accepts `0`, deliberately
  (`vault.ts:169`). Full detail in `new-note.md` in this directory.
- **Opening a note from a list:** `openNote(path)` at
  `src/renderer/panes/vault/VaultPane.tsx:177-186` returns `Promise<boolean>`;
  `false` means refused (open conflict, declined discard, failed read). Existing
  callsites that respect it: `MainCanvas.tsx:254-258`, `:265-273`, `:293-300`.
- **A list panel with a meaningful zero state**, as a model:
  `src/renderer/panes/vault/InboxView.tsx:32-41` — it says what the empty state
  *means* rather than reporting an empty list.
- **The agent-capture date**, if the Inbox-timeline idea is chosen: parsed per
  item by `parseProposal` in `src/shared/notemeta.ts`, surfaced as
  `item.captured` and rendered at `src/renderer/panes/vault/InboxView.tsx:60`.
- **Icon and selected-state conventions:** `LeftRibbon.tsx:41-52`.

## What does NOT exist yet

- **Any date, calendar or daily-note concept** in `src/`. Grep for "daily",
  "calendar", "today": the only hits are the Lucide `Calendar` icon import at
  `LeftRibbon.tsx:15` and the ribbon label.
- **Any configured path convention.** Nothing in `AppSettings`
  (`src/shared/ipc.ts:46-60`) — it holds exactly one setting, the vault
  directory.
- **Any reader for `.obsidian/`**, where Obsidian's daily-note format is
  configured. `src/main/vault.ts:328` lists `.obsidian` in `HIDDEN` and skips it.
- **Any template system.**
- **Directory creation.** Creating `Daily/2026-08-16.md` needs `Daily/` to exist
  first; there is no mkdir anywhere in the stack. See `new-folder.md`.
- **Reliable file timestamps.** `VaultTreeNode` (`src/shared/ipc.ts:24-29`) has
  no date field, and `tree()` uses `readdir(..., { withFileTypes: true })`
  (`src/main/vault.ts:363`), which returns no stat data.
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one branch
  and no else.

## Constraints

- **The scope question must be answered by a human before any code is written.**
  The path convention in particular cannot be inferred; a wrong guess produces a
  calendar of dead dates.
- **🔒 The vault is read-only by default for agents.** Creating daily notes is a
  vault write and needs explicit approval for that specific thing. Reading,
  searching and listing are always fine.
- **A "create on click" flow must be an explicit click, never automatic.**
  `test/review-s2-vault-pane.test.mjs:230-240` hard-fails on `setInterval`,
  `setTimeout`, `requestIdleCallback`, `debounce`, `throttle`, `onBlur=`,
  `beforeunload`, `visibilitychange` and `pagehide` across this pane. A panel
  that creates today's note on mount would be the same class of surprise.
- **Do not make frontmatter editable as a side effect.** The database view
  deliberately kept status read-only; the reasoning at
  `src/renderer/panes/vault/DatabaseView.tsx:28-32` applies here.
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`.
- **No node, electron or network access in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155`.
- **No inline styles, no hex colours, no `rgb()`/`hsl()`, no `app.css` import.**
  `test/review-s2-vault-pane.test.mjs:185-216`. A month grid needs CSS — put it
  in a co-located stylesheet, following `src/renderer/panes/vault/settings.css`.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer stating whether daily notes exist
in this vault, the exact path convention if so, whether clicking an empty date
creates a note, and what this panel does that Obsidian's Daily Notes and Calendar
plugins do not. Then update `status:` in this file's frontmatter.

**For the sidebar-empties bug**, closable now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the Daily notes icon. The sidebar must show
either a real panel or an explicit "not built" message — never an empty column
with the icon lit. Clicking Files must restore the tree with its expansion state
intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail. Update it in the same commit and state in your report that you changed
a spec assertion, not just code.
