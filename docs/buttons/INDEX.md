# Dead controls — work queue

Every interactive control in `src/renderer` that does nothing when activated:
no handler, an empty or console-only handler, a hardcoded `disabled` with no
code path that enables it, or a control that switches state nothing consumes.

Each file below is **self-contained**. Open exactly one, and it tells you what
the control does today with file:line proof, what exists in this repo to build
on, what does not exist, the constraints the codebase holds itself to, and how
to verify you are done. You do not need to read any other file in this
directory.

Audited against the working tree on 2026-08-16. **All nine WIRE items were built
on 2026-08-18**; the seven DECIDE items are unchanged and still need a human to
answer their scope question. Test baseline now: **274 passing, 0 failing**
(`npm test`). The per-file bodies below still describe the pre-build state —
they were written as briefs and are kept as the record of why each control was
built the way it was, not as a description of the code today.

**Settings (the gear in `VaultSwitcher`) is BUILT and is not in this queue** —
`src/renderer/panes/vault/VaultSwitcher.tsx` opens the real modal at
`src/renderer/panes/vault/SettingsDialog.tsx`. It is the model to copy for any
new dialog, and `HelpDialog.tsx` is what copying it looks like.

---

## WIRE — all nine built, 2026-08-18

| File | Control | Status | What it does now |
|---|---|---|---|
| [new-note.md](new-note.md) | "+ Note", explorer header | ✅ DONE | Creates `Untitled.md` (then `Untitled 1.md`, …) in the open note's folder and opens it. `vault:save` with mtime 0 IS the create; no second write door was added. |
| [new-folder.md](new-folder.md) | "+ Folder", explorer header | ✅ DONE | Prompts for a name and creates a real directory through the new `vault:mkdir` channel. Containment is `resolveInVault` in main, covered by `test/vault-mkdir.test.mjs`. |
| [sort-select.md](sort-select.md) | Sort dropdown, explorer header | ✅ DONE | Four modes, no two producing the same order: folders-or-files first × A→Z or Z→A. Sorted in the renderer against a copy of the tree. No Modified/Created — the tree carries no timestamps. |
| [tab-bar-tabs.md](tab-bar-tabs.md) | The tab strip and "+" new tab | ✅ DONE | A tab holds a path. Opening a note from anywhere renames the active tab; clicking a tab opens its note through the same guarded loader. One buffer, pane-wide. |
| [tab-chevron.md](tab-chevron.md) | Chevron-down, tab bar | ✅ DONE | Lists every open tab and switches to the one clicked. |
| [tab-split.md](tab-split.md) | Split-pane columns icon, tab bar | ✅ DONE | Two canvases over one note and one buffer, each with its own view mode — editor on the left, graph or roadmap on the right. |
| [tab-menu.md](tab-menu.md) | Vertical ellipsis, tab bar | ✅ DONE | Close this tab / Close others / Copy note path. Rows disable with a reason when they cannot act. |
| [switcher-help.md](switcher-help.md) | "?" in the vault switcher | ✅ DONE | Opens `HelpDialog.tsx`: saving, conflicts, links, the six views, where the notes live. Every claim checked against the code. |
| [note-more-options.md](note-more-options.md) | "More options" ellipsis, note header | ✅ DONE | Option B was taken, not the one-attribute Option A: Copy note path / Copy wikilink, disabled with no note open. |

Three of those menus share `PaneMenu.tsx`, built on the **native popover API** —
light dismiss, Escape, focus restore and the top layer are the platform's job,
so there is no document listener to leak and no timer (this pane bans both).
Positioning is CSS anchor positioning; see the note in `menu.css` about why each
menu needs its own anchor pair in Chromium 130.

## DECIDE — a whole feature wearing a button costume; a human answers the scope question first

All seven are left-ribbon icons.

> **⚠ These seven files are stale in one specific way.** Each describes a shared
> mechanical fault: `activeRibbon` had exactly one consumer, so clicking any
> unbuilt ribbon icon **emptied the sidebar** while the icon lit up and reported
> `aria-pressed`. **That bug was fixed on 2026-08-17** by
> `src/renderer/panes/vault/SidebarPlaceholder.tsx` (commit `4bc9878`), which
> renders a panel naming the feature the icon is a promise of. Ignore the
> paragraph in each file telling you to fix it; the scope question each file
> asks is still open and is still the real content.

| File | Control | Tier | Summary |
|---|---|---|---|
| [ribbon-search.md](ribbon-search.md) | Search icon | DECIDE | Full-text search needs an index, a watcher and a scan the graph memo exists to avoid — and Obsidian already searches this exact vault. |
| [ribbon-bookmarks.md](ribbon-bookmarks.md) | Bookmarks icon | DECIDE | The question is where a bookmark is stored, not what the panel looks like; Obsidian's Bookmarks plugin already keeps one in `.obsidian/`. |
| [ribbon-graph.md](ribbon-graph.md) | Graph view icon | DECIDE | A working graph already exists in the main canvas, so this icon is either a shortcut, a *local* graph, or removable. Obsidian ships both graphs. |
| [ribbon-canvas.md](ribbon-canvas.md) | Canvas icon | DECIDE | Obsidian Canvas is a core plugin storing `.canvas` files in this vault, and the app's own v1 scope already says "no canvas". |
| [ribbon-calendar.md](ribbon-calendar.md) | Daily notes icon | DECIDE | Cannot be scoped from code at all — it needs a human to say whether daily notes exist here and what their path convention is. |
| [ribbon-terminal.md](ribbon-terminal.md) | Terminal icon | DECIDE | Ambiguous between a real shell (a security decision that punches through the renderer sandbox) and an agent chat (five `claude:*` channels are declared and unimplemented). |
| [ribbon-plugins.md](ribbon-plugins.md) | Plugins icon | DECIDE | Contradicts the app's written scope in two files, and a test at `test/review-s2-vault-pane.test.mjs` actively guards against building it. |

---

## Counts

| Tier | Count | Status |
|---|---|---|
| WIRE | 9 | ✅ all built |
| DECIDE | 7 | the CONTROL is built; the feature behind it is not |
| **Total** | **16** | **no dead controls remain** |

**Read that second row carefully, because the title of this file invites the
wrong conclusion.** The seven DECIDE items are not dead controls and have not
been since 2026-08-17. All eight ribbon icons are wired, carry `aria-pressed`,
and show `SidebarPlaceholder` — which reads `shared/roadmap.ts` and says the
feature is not built yet, names it, and points at the Files icon for the tree.
A wired control honestly reporting an unbuilt feature is not the defect this
directory is about. What is outstanding is seven FEATURES, and the scope
question each file asks.

Audited independently on 2026-08-18 across every `.tsx` in `src/renderer`, not
just this pane: **58 interactive elements — 54 wired, 0 disabled, 4 read-only.**
The four are the conflict dialog's two panes, the discarded-version box and the
version preview, all `readOnly` by design. Nothing in the renderer is inert.

## What now stops this list growing back

`test/review-s2-vault-pane.test.mjs` gained four standing invariants over the
whole pane, so a control cannot go back to looking live and doing nothing
without a test failing:

- every `<button>` has an `onClick`, a `disabled`, or a `popoverTarget`;
- every `<select>` has an `onChange` or a `disabled`;
- every `PaneMenuItem` has an `onClick`, and a disabled row must carry a
  `reason`;
- nothing in the pane reports to `console` — failures go to the UI.

The first of those, run against the previous commit, finds exactly one offender:
the note header's ellipsis. That is the defect this whole directory was written
about, and it is now the thing the suite refuses to let back in.
