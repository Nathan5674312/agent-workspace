# Dead controls — work queue

Every interactive control in `src/renderer` that does nothing when activated:
no handler, an empty or console-only handler, a hardcoded `disabled` with no
code path that enables it, or a control that switches state nothing consumes.

Each file below is **self-contained**. Open exactly one, and it tells you what
the control does today with file:line proof, what exists in this repo to build
on, what does not exist, the constraints the codebase holds itself to, and how
to verify you are done. You do not need to read any other file in this
directory.

Audited against the working tree on 2026-08-16. Test baseline at audit time:
**189 passing, 0 failing** (`npm test`).

**Settings (the gear in `VaultSwitcher`) is BUILT and is not in this queue** —
`src/renderer/panes/vault/VaultSwitcher.tsx:27-34` opens the real modal at
`src/renderer/panes/vault/SettingsDialog.tsx`. It is the model to copy for any
new dialog.

---

## WIRE — implementable in one focused sitting against things that already exist

| File | Control | Tier | Summary |
|---|---|---|---|
| [new-note.md](new-note.md) | "+ Note", explorer header | WIRE | Hardcoded `disabled`; the stated reason is stale — `vault:save` already creates files, because the server skips its mtime guard when the file does not exist. |
| [new-folder.md](new-folder.md) | "+ Folder", explorer header | WIRE | Hardcoded `disabled`; genuinely needs a new `vault:mkdir` channel, since the server writes files and its atomic-write stages into a parent that must already exist. |
| [sort-select.md](sort-select.md) | Sort dropdown, explorer header | WIRE | `disabled` select with one option and no `onChange`; sort client-side and copy the working sort in `DatabaseView.tsx`. |
| [tab-bar-tabs.md](tab-bar-tabs.md) | The tab strip and "+" new tab | WIRE | Both run code and change nothing visible: a tab holds no path, and `activeTabId`'s only consumer is a CSS class. Give a tab a note. |
| [tab-chevron.md](tab-chevron.md) | Chevron-down, tab bar | WIRE | `disabled`, no `onClick`; a dropdown over the `tabs` array already passed into the component. |
| [tab-split.md](tab-split.md) | Split-pane columns icon, tab bar | WIRE | `disabled`, no `onClick`; `MainCanvas` already owns its view mode locally, so two instances give two independent views for free. |
| [tab-menu.md](tab-menu.md) | Vertical ellipsis, tab bar | WIRE | `disabled`, no `onClick`; close-tab / close-others / copy-path are the only actions that exist — rename, delete and move have no channel. |
| [switcher-help.md](switcher-help.md) | "?" in the vault switcher | WIRE | `disabled`, handler is `console.log('Help')`; copy `SettingsDialog` and write static content from what the app actually does. |
| [note-more-options.md](note-more-options.md) | "More options" ellipsis, note header | WIRE | The worst one: no handler **and** no `disabled`, so it hovers, presses and announces itself as actionable. Minimum fix is one attribute. |

## DECIDE — a whole feature wearing a button costume; a human answers the scope question first

All seven are left-ribbon icons. All seven share one mechanical fault:
`activeRibbon` (`src/renderer/panes/vault/VaultPane.tsx:47`) has exactly one
consumer, the `activeRibbon === 'files'` branch at `VaultPane.tsx:345`, with no
else — so clicking any of them **empties the sidebar** while the icon lights up
and reports `aria-pressed`.

That blank-panel bug is fixable now, without any of the scope decisions, and
every file below says so in the same words.

| File | Control | Tier | Summary |
|---|---|---|---|
| [ribbon-search.md](ribbon-search.md) | Search icon | DECIDE | Full-text search needs an index, a watcher and a scan the graph memo exists to avoid — and Obsidian already searches this exact vault. |
| [ribbon-bookmarks.md](ribbon-bookmarks.md) | Bookmarks icon | DECIDE | The question is where a bookmark is stored, not what the panel looks like; Obsidian's Bookmarks plugin already keeps one in `.obsidian/`. |
| [ribbon-graph.md](ribbon-graph.md) | Graph view icon | DECIDE | A working graph already exists in the main canvas, so this icon is either a shortcut, a *local* graph, or removable. Obsidian ships both graphs. |
| [ribbon-canvas.md](ribbon-canvas.md) | Canvas icon | DECIDE | Obsidian Canvas is a core plugin storing `.canvas` files in this vault, and the app's own v1 scope already says "no canvas". |
| [ribbon-calendar.md](ribbon-calendar.md) | Daily notes icon | DECIDE | Cannot be scoped from code at all — it needs a human to say whether daily notes exist here and what their path convention is. |
| [ribbon-terminal.md](ribbon-terminal.md) | Terminal icon | DECIDE | Ambiguous between a real shell (a security decision that punches through the renderer sandbox) and an agent chat (five `claude:*` channels are declared and unimplemented). |
| [ribbon-plugins.md](ribbon-plugins.md) | Plugins icon | DECIDE | Contradicts the app's written scope in two files, and a test at `test/review-s2-vault-pane.test.mjs:124-133` actively guards against building it. |

---

## Counts

| Tier | Count |
|---|---|
| WIRE | 9 |
| DECIDE | 7 |
| **Total** | **16** |

All 16 are `status: NOT STARTED`.

Nine of the sixteen are in the vault pane's chrome (explorer header, tab bar,
vault switcher, note header). Seven are the left ribbon, and seven of the
ribbon's eight icons are unbuilt — only `files` does anything.
