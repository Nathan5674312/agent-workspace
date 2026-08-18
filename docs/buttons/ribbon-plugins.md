---
tier: DECIDE
control: The blocks "Plugins" icon in the left ribbon
location: src/renderer/panes/vault/LeftRibbon.tsx:34 (definition), :41-52 (render)
status: NOT STARTED
---

> **⚠ STALE IN ONE PLACE (checked 2026-08-18).** Everything below about the
> sidebar going blank when this icon is clicked is fixed. `activeRibbon` used
> to have exactly one consumer; commit `4bc9878` added
> `src/renderer/panes/vault/SidebarPlaceholder.tsx`, which renders a panel
> naming the feature this icon is a promise of. Skip the "fix the blank panel
> first" instruction. The scope question this file asks is still open and is
> still why the icon is not built.


# Ribbon: Plugins

## Today

Clicking it changes state that nothing consumes, and **empties the sidebar**.

- `src/renderer/panes/vault/LeftRibbon.tsx:26-35` defines eight views; `plugins`
  is at `LeftRibbon.tsx:34`.
- `src/renderer/panes/vault/LeftRibbon.tsx:41-52` renders each as a button whose
  `onClick` is `() => onViewChange(id)`.
- `onViewChange` is `setActiveRibbon` (`src/renderer/panes/vault/VaultPane.tsx:342`),
  writing the state at `VaultPane.tsx:47`.
- **`activeRibbon` has exactly one consumer**, at
  `src/renderer/panes/vault/VaultPane.tsx:345` — the `activeRibbon === 'files'`
  branch rendering the explorer header and folder tree. There is no else.

The sidebar collapses to the vault switcher row (`VaultPane.tsx:362-365`) while
the icon lights up and reports `aria-pressed` (`LeftRibbon.tsx:43,48`).

**This icon contradicts the app's own written scope, in two places.**

- `src/renderer/panes/vault/VaultPane.tsx:14-15`: *"v1 editor scope: read, edit,
  wikilinks, backlinks, graph. **No plugin API**, no live preview, no canvas."*
- `src/renderer/panes/vault/Editor.tsx:7-8`: *"No live preview, no CodeMirror,
  **no plugins**."*
- And a test enforces it: `test/review-s2-vault-pane.test.mjs:124-133` fails the
  build if `registerPlugin`, `pluginApi` or `loadPlugin` appears anywhere in
  `src/renderer/panes/vault/`.

So the ribbon advertises the one capability the codebase has explicitly written
down that it will not have, and has a test standing guard against.

## What it should do

**This is a DECIDE item. Do not write an implementation plan; get an answer to
the scope question first.**

### The question a human must answer

**Was this icon ever meant to be a plugin system, or was it copied from
Obsidian's ribbon along with the other seven?**

Three coherent answers:

1. **Remove it.** The v1 scope says no plugin API, a test enforces it, and
   nothing about the app's direction suggests third-party extensibility. This is
   the answer the codebase already argues for.
2. **Reinterpret it as a read-only view of Obsidian's plugins** — list what is
   installed and enabled in this vault's `.obsidian/plugins/`, as information
   rather than as an extension point. A different feature wearing the same icon.
3. **Build a plugin API.** This reverses a written scope decision and requires
   deleting a test that exists to prevent it.

### Where this duplicates Obsidian

**Answer 3 duplicates it in the deepest possible way, and answer 2 is a read of
it.**

Obsidian's plugin ecosystem is its defining feature: a documented API, a
community directory of thousands of plugins, a security model, versioning, and
an installer. Any plugin system built here would be a second, empty ecosystem
over the same vault — with no plugins in it, because nobody has written any.

That is the trap in its purest form. The value of Obsidian's plugin system is
the *plugins*, not the API, and this app cannot acquire those by building an API.
Under answer 3 the honest question is not "can we build a plugin host" but "who
would write a plugin for it, and why would they not write it for Obsidian
instead?"

Answer 2 is the only one that does not re-solve anything: it surfaces what
Obsidian already has, so the user can see the vault's real configuration without
switching apps. Note that it would be the app's first read of `.obsidian/`, which
`src/main/vault.ts:328` currently hides from the tree as *"machine state, not
content"* — a deliberate line that answer 2 would cross, and therefore worth a
human's yes rather than an agent's assumption.

### What is at stake either way

**If answer 3 (build a plugin API):**
- A plugin host in Electron is an arbitrary-code-execution surface. The renderer
  here is deliberately sandboxed — `src/shared/ipc.ts:4-9` states *"The renderer
  has NO node integration and NO network access to the vault. Everything crosses
  this boundary"*, `src/main/ipc.ts:21-47` refuses IPC from any subframe, and
  `src/renderer/panes/corner/ArtifactItem.tsx:33-48` documents a real bypass
  found in review where page script reached the full `window.api` bridge. Loading
  third-party code into that renderer discards the entire model.
- It reverses `VaultPane.tsx:14-15` and `Editor.tsx:7-8` and requires deleting or
  rewriting `test/review-s2-vault-pane.test.mjs:124-133`. Deleting a guard test
  is a decision that must be made out loud, not as a step in a ticket.

**If answer 2 (read-only plugin list):**
- Small, and it needs a main-process directory read of `.obsidian/plugins/` plus
  a parse of `community-plugins.json` / each plugin's `manifest.json`. Both are
  undocumented Obsidian internals that can change between releases.
- It must stay strictly read-only. Enabling or disabling a plugin means writing
  Obsidian's config, which risks corrupting a file Obsidian owns while it is
  running.

**If answer 1 (remove):**
- `test/review-s2-vault-pane.test.mjs:70-84` asserts all eight ribbon ids exist
  and will fail. That test encodes the original brief's eight-icon layout, so
  removing an icon is a deliberate spec revision — update it in the same change
  and say so.
- The same question applies to the other six unbuilt icons, documented separately
  here: `ribbon-search.md`, `ribbon-bookmarks.md`, `ribbon-graph.md`,
  `ribbon-canvas.md`, `ribbon-calendar.md`, `ribbon-terminal.md`.

### The one thing to do regardless of the answer

**The sidebar must not silently empty.** Either the unbuilt ribbon icons become
`disabled` with a title — the idiom used everywhere else in this pane, see
`src/renderer/panes/vault/TabBar.tsx:38-48` — or `VaultPane.tsx:345` gains an
else-branch with an explicit "Not built yet" panel. Given that the v1 scope says
"no plugin API" outright, `disabled` is the honest default for this icon
specifically.

## What already exists to build on

Recorded so whoever implements a decision does not re-derive it. As with
`ribbon-canvas.md`, note how little there is.

- **The ribbon and its state:** `src/renderer/panes/vault/LeftRibbon.tsx:21-56`,
  `src/renderer/panes/vault/VaultPane.tsx:47`, `:342`, `:345`.
- **The sidebar container** is `.vault-sidebar` at `VaultPane.tsx:344-366`.
- **The scope statements that argue against answer 3:**
  `src/renderer/panes/vault/VaultPane.tsx:14-15` and
  `src/renderer/panes/vault/Editor.tsx:7-8`, enforced by
  `test/review-s2-vault-pane.test.mjs:124-133`.
- **Main-process `node:fs` reads of the vault directory are an established,
  argued pattern**, if answer 2 is chosen: `src/main/vault.ts:344-415` (`tree()`
  imports `readdir`, `realpath`, `stat` from `node:fs/promises`), with the
  justification at `vault.ts:330-343` — a directory listing carries none of the
  atomic-write / backup / lost-update hazards that put note writes behind the
  Python server. The same argument covers reading `.obsidian/plugins/`.
- **`VAULT_DIR` and its accessor:** `src/main/vault.ts:27-51`.
- **The `HIDDEN` set that currently excludes `.obsidian`:**
  `src/main/vault.ts:328`.
- **The channel-adding pattern**, end to end, most recently done for settings:
  `src/shared/ipc.ts:141-163` (`CH`) and `:175-205` (`Api`) →
  `src/preload/index.ts:22-50` → `src/main/ipc.ts:49-60` → `src/main/settings.ts`.
  `src/main/ipc.ts:37-47` shows the `handle()` wrapper that every channel must go
  through — it enforces the top-frame check and converts throws into plain
  messages across the bridge.
- **A read-only list panel with a meaningful zero state**, as a model:
  `src/renderer/panes/vault/InboxView.tsx:32-41`.
- **Icon and selected-state conventions:** `LeftRibbon.tsx:41-52`.

## What does NOT exist yet

- **Everything.** There is no plugin, extension, module-loading or manifest
  concept anywhere in `src/`. The only hit for "plugin" outside comments and
  tests is the `Blocks` icon import at `LeftRibbon.tsx:17` and the ribbon label.
- **Any reader for `.obsidian/`.** `src/main/vault.ts:328` lists it in `HIDDEN`
  and `tree()` skips it entirely (`vault.ts:369` also skips every dot-prefixed
  entry).
- **Any IPC channel for plugins.** `CH` (`src/shared/ipc.ts:141-163`) has six
  vault channels, five unimplemented `claude:*` channels, four corner/network
  channels and two settings channels. Nothing about plugins.
- **Any dynamic import, module registry or sandbox** for third-party code.
- **Any panel for a non-`files` ribbon view.** `VaultPane.tsx:345` has one branch
  and no else.

## Constraints

- **The scope question must be answered by a human before any code is written.**
  Answer 3 in particular reverses a written decision and deletes a guard test;
  neither is an agent's call.
- **🔒 The vault is read-only by default for agents.** Reading
  `.obsidian/plugins/` is a read and is fine. Writing anything under `.obsidian/`
  — enabling or disabling a plugin — is a vault write to a file Obsidian owns and
  needs explicit approval for that specific thing.
- **Do not delete or weaken `test/review-s2-vault-pane.test.mjs:124-133` to make
  room for a plugin API.** That test is the written scope decision in executable
  form. If the decision is genuinely reversed, the test changes as an explicit,
  separately-stated part of the change.
- **No node, electron or network access in the renderer.**
  `test/review-s2-vault-pane.test.mjs:143-155` bans `fetch(`, `require(`,
  `XMLHttpRequest`, `WebSocket`, `from 'electron'`, `from 'node:`,
  `ipcRenderer`, `process.`. Any `.obsidian/` read happens in main.
- **No `dangerouslySetInnerHTML`, no `.innerHTML`.**
  `test/review-s2-vault-pane.test.mjs:220-226`. Plugin manifests are
  third-party text and must render as text.
- **The pane may only reach `window.api.vault` and `window.api.settings`.**
  `test/review-s2-vault-pane.test.mjs:164-172`. A new `window.api.plugins`
  surface fails that test and widening `ALLOWED_API` is an architectural change.
- **No timers, no inline styles, no hex colours, no `app.css` import.**
  `test/review-s2-vault-pane.test.mjs:230-240`, `:796-801`, `:185-216`.
- **Files not to touch:** `src/renderer/panes/vault/GraphView.tsx`,
  `src/renderer/panes/vault/graphPhysics.ts`, `src/renderer/panes/vault/Editor.tsx`,
  `src/renderer/app.css`.

## Acceptance

**For the decision itself:** a written answer naming which of the three options
was chosen. If it is answer 3, it must state why
`src/renderer/panes/vault/VaultPane.tsx:14-15` ("No plugin API") is being
reversed, who the plugins would be written by, and how third-party code is kept
away from the `window.api` bridge. Then update `status:` in this file's
frontmatter.

**For the sidebar-empties bug**, closable now without the decision:

```
npm run typecheck     # expect: clean, no output
npm test              # expect: "pass 189" or higher, "fail 0"
```

Baseline at the time this was written: **189 tests passing, 0 failing.**

Manual, in `npm run dev`: click the Plugins icon. The sidebar must show either a
real panel or an explicit "not built" message — never an empty column with the
icon lit. Clicking Files must restore the tree with its expansion state intact.

**If the decision is "remove the icon":** `test/review-s2-vault-pane.test.mjs:70-84`
will fail. Update it in the same commit and state in your report that you changed
a spec assertion, not just code.
