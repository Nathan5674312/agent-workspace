# Settings research — Hermes and Obsidian

Status: **inventory and mapping, no code.** Every row below was read off a real
file, not recalled. Where a candidate turned out not to apply to this app, it is
still listed, with the reason — a settings list is only useful if the exclusions
are as explicit as the inclusions.

## Provenance

| Source | How it was read |
|---|---|
| Hermes desktop | `%LOCALAPPDATA%\hermes\hermes-agent\apps\desktop\src\app\settings\` — `index.tsx` (nav), `constants.ts` (`SECTIONS`, `ENUM_OPTIONS`), `appearance-settings.tsx` |
| Obsidian | `%LOCALAPPDATA%\Programs\Obsidian\resources\obsidian.asar`, grepped for the i18n key space `setting.<section>.option-*`. Authoritative — these are the keys the settings UI renders from |
| This vault's Obsidian config | `Universal Vault\.obsidian\{app,appearance,core-plugins,graph}.json` |
| agent-workspace | `src/main/settings.ts`, `src/shared/ipc.ts`, `src/renderer/panes/vault/SettingsDialog.tsx` |

A note on the vault's own config: `appearance.json` is `{}` and `app.json` holds
only `promptDelete: false` and three `userIgnoreFilters`. So the *live* vault
tells us almost nothing about which settings matter — the taxonomy below comes
from Obsidian's own key space, not from what happens to be set here.

---

## 1. Hermes — the settings surface

Two layers. A **config surface** (`SECTIONS`, described in its own source as the
"curated desktop config surface: only fields a user might tune from the app"),
and a set of **standalone tabs** that are not config keys at all.

### Config sections

| Section | Keys |
|---|---|
| Model | `model_context_length`, `fallback_providers` |
| Chat | `display.personality`, `timezone`, `display.show_reasoning`, `agent.image_input_mode` |
| Appearance | *(none — hand-built panel, see below)* |
| Workspace | `terminal.cwd`, `desktop.repo_scan_enabled`, `desktop.repo_scan_roots`, `desktop.repo_scan_exclude_paths`, `code_execution.mode`, `terminal.persistent_shell`, `terminal.env_passthrough`, `file_read_max_chars` |
| Safety | `approvals.mode`, `approvals.timeout`, `approvals.mcp_reload_confirm`, `command_allowlist`, `security.redact_secrets`, `security.allow_private_urls`, `browser.allow_private_urls`, `browser.auto_local_for_private_urls`, `checkpoints.enabled` |
| Memory & Context | `memory.memory_enabled`, `memory.user_profile_enabled`, `memory.memory_char_limit`, `memory.user_char_limit`, `memory.provider`, `context.engine`, `compression.{enabled,threshold,target_ratio,protect_last_n}` |
| Voice | 40 keys — `tts.*` and `stt.*` per provider, plus `voice.record_key`, `voice.max_recording_seconds` |
| Advanced | `toolsets`, `terminal.{backend,timeout,docker_image,…}`, `tool_output.{max_bytes,max_lines,max_line_length}`, `checkpoints.max_snapshots`, `agent.{max_turns,api_max_retries,service_tier,tool_use_enforcement}`, `delegation.*`, `updates.non_interactive_local_changes` |

### Standalone tabs

Notifications · Billing · Providers (Accounts / API keys / Custom endpoints) ·
Gateway · Keybinds · API keys (Tools / Settings) · Plugins · Archived chats ·
About.

### Appearance panel

Built by hand rather than from config keys: Language, Theme (with VS Code
marketplace theme install), Mode (Light / Dark / System), UI scale (zoom %),
Translucency, Backdrop, Reactions, Tool view mode, Embeds.

### Three structural decisions worth stealing

1. **Left nav, not a flat modal.** Sections are deep-linkable
   (`?tab=…&pview=…`), and a removed section keeps its old links alive with an
   explicit redirect rather than silently coercing to the default.
2. **Export / Import / Reset live in the nav footer**, not inside a section —
   they act on the whole config, so they are not a member of any part of it.
3. **`approvals.mode` is a three-way enum**: `manual | smart | off`. Not a
   boolean. This is the single most relevant idea to this app; see §4.

---

## 2. Obsidian — the settings surface

Eleven namespaces in the i18n key space: `editor`, `file`, `appearance`,
`about`, `account`, `hotkeys`, `core-plugin`, `third-party-plugin`, `interface`,
`keychain`, `mobile-toolbar`.

**Editor** (31 options) — default new-tab view (editing/reading), default
editing mode (live preview/source), open tab in foreground, readable line
length + its width, show line numbers, indentation guide, show inline title,
fold heading, fold indent, smart indent lists, tab size, use tabs, auto-pair
brackets, auto-pair markdown, strict line breaks, auto-convert HTML, spellcheck,
vim key bindings, RTL, properties in document (visible/hidden/source), mermaid
allow, reindex vault.

**Files and links** (35 options) — confirm file deletion, delete destination
(system trash / vault `.trash` / permanent), always update internal links, new
note location (vault root / current folder / specified folder), new file folder
path, link format (shortest / relative / absolute), use `[[wikilinks]]`,
autocompleted link format, attachment location (+ subfolder path), show
unsupported files, excluded files, default open action, delete unlinked
attachments, URI callbacks.

**Appearance** (34 options) — base theme, accent colour, themes + community
themes + manage, CSS snippets, interface/text/monospace font, font size, zoom
level, frame style (native / Obsidian / hidden), native menus, show ribbon,
configure ribbon, show view header, sliding sidebar, floating navigation,
translucency, auto full screen, custom icon, open settings in window.

**Core plugins** — 31 on/off entries in this vault, each with its own settings
page. Enabled here: file explorer, search, switcher, graph, backlink, canvas,
outgoing links, tags, properties, page preview, daily notes, templates, note
composer, command palette, editor status, bookmarks, outline, word count, file
recovery, sync, bases.

### One structural decision worth stealing

**A setting that only matters when another is on is nested under it, not
disabled beside it.** `readable-line` gates `readable-line-length`;
`new-note-location: specified folder` reveals `new-file-folder-path`. This app
already does the disabled-beside variant (artwork opacity greys out when artwork
is off) and it works, but the nesting scales better past two.

---

## 3. What agent-workspace has today

Six settings, one flat modal (`SettingsDialog.tsx`), persisted by
`src/main/settings.ts` to `settings.json` in `userData`.

| Setting | Applies |
|---|---|
| `vaultDir` | On restart (deliberate — a live swap would have to atomically invalidate the graph memo, tree, edit buffer and nav trail) |
| `appearance.contrast` | `system` \| `more`, live |
| `appearance.transparency` | `system` \| `reduced`, live |
| `appearance.motion` | `system` \| `reduced`, live |
| `appearance.artwork` | boolean, live |
| `appearance.artworkOpacity` | 0 – 0.2, live, clamped in main |

The existing shape is good and should not be thrown away: sanitisation runs on
both trust boundaries through one function, writes are temp-file + rename, and
the renderer never constructs a path.

---

## 4. Mapping — what could actually land here

Ordered by value, not by ease. "Cost" is honest, not optimistic.

### Worth building

| Candidate | From | What it would control here | Cost |
|---|---|---|---|
| **Approvals mode** (`manual \| smart \| off`) | Hermes `approvals.mode` | `src/main/consent.ts` gates every agent-originated mutation and currently has exactly one policy, hard-coded. Its allowance map is already session-scoped with finite/infinite credits — the machinery for a policy setting exists, there is just no way to express one | Medium. Needs a deliberate answer to what `smart` means here, and the file's own header argues hard against anything that produces approval fatigue |
| **Approvals timeout** | Hermes `approvals.timeout` | A consent prompt currently waits forever | Small |
| **Trusted networks list** | Hermes `security.allow_private_urls` (nearest analogue) | `src/main/network.ts` keeps a trust store keyed by gateway MAC / SSID. There is IPC to trust the *current* network but no UI to review or revoke the list | Small–medium. Read-only list + revoke is the 80% |
| **Daily-note folder, filename format, template path** | Obsidian daily-notes core plugin | `src/shared/daily.ts` hard-codes `Daily/`, `YYYY-MM-DD.md` and `Daily/_Template.md`. Its header is explicit that these were read off *this* vault — so they are vault facts living in source, and any other vault breaks | Medium. Format is the awkward part: a real date-format parser is a dependency, an enum of three formats is not |
| ~~**Excluded folders**~~ **— built 2026-08-19** | Obsidian `file.option-excluded-files`, and this vault's own `userIgnoreFilters` | `tree()` now reads `<vault>/.obsidian/app.json` and applies `userIgnoreFilters` as root-relative prefixes. See the correction below — the original diagnosis here was half wrong | Done |
| **Editor font size** | Obsidian `appearance.option-font-size` | One CSS custom property. Fits the existing live-apply appearance path with no new machinery | Small |
| **Readable line length** | Obsidian `editor.option-readable-line` | `max-width` on the editor textarea. Same path as above | Small |
| **Spellcheck** | Obsidian `editor.option-spellcheck` | The `spellCheck` attribute on the editor textarea. Chromium does the rest | Trivial |
| **Export / Import / Reset config** | Hermes nav footer | `settings.json` is already one object with one sanitiser. Reset is `save(defaults)` | Small |

### Correction — there were always two exclusion lists

The table above originally claimed this app "ignores `userIgnoreFilters`
entirely". That was half wrong, and the half that was wrong is the interesting
half.

`src/main/vault.ts` carries **two** exclusion mechanisms, not one:

| | Where | Matching | Applies to |
|---|---|---|---|
| `HIDDEN` (~line 452) | `walk()` inside `tree()` | **basename**, any depth | everything |
| `SKIP` (~line 942) | `scan()` | **root-relative path prefix** | `list()` and `graph()` only |

`SKIP` already contained `System/Skills/gstack/`,
`System/Skills/skill-router/` and `System/Skill Sources/` — a hand-copied,
drifting duplicate of the vault's own `userIgnoreFilters`. So the database and
graph views were already excluding those paths. Only the **explorer tree** was
not, which is why it was rendering 1,544 markdown files Obsidian hides.

Two things follow that were not visible before:

- **`SKIP` is not purely redundant now and must not simply be deleted.** It also
  carries `Templates/`, `Inbox/`, `.backups/` and `graphify-out/`, which are
  *index-only* exclusions with a legitimate reason to differ from the explorer —
  a note you can open but do not want in the graph. The three duplicated entries
  could go, but note that `SKIP` has the **broader** `System/Skills/skill-router/`
  where `app.json` has the **narrower** `System/Skills/skill-router/skills`, so
  dropping it newly indexes skill-router's own top-level notes. That is a
  behaviour change, not a cleanup.
- **`tree()` is the shared walk.** `list()` and `graph()` are both built from
  `scan()`, which calls `tree()`. Any future exclusion belongs in `walk()`, where
  all three consumers agree by construction. Filtering in `scan()` instead hides
  a note from the database while the explorer still offers it.

Known gaps in what was built, both marked `ponytail:` in the source: Obsidian's
`/regex/` filter form is dropped rather than honoured, and matching is
case-sensitive where Obsidian's is not. Neither leaks on this vault today.
`mkdir()` and `move()` are also not filtered, so creating a note inside an
ignored folder still succeeds and then never appears.

### Does not apply, and why

These looked like candidates and are not. Recorded so they do not get
re-proposed.

| Candidate | Why not |
|---|---|
| Confirm file deletion, delete destination | **The app has no delete.** There is no `vault:delete` channel. Destructive operations are moves into `<vault>/.trash/` with an append-only journal at `.trash/moves.jsonl` and an undo. Obsidian's setting is choosing between three destructive outcomes; this app already chose the reversible one |
| Use `[[wikilinks]]`, link format (shortest/relative/absolute) | `src/shared/wikilink.ts` supports one syntax, deliberately, as one parser shared by both processes because two parsers had already disagreed once. There is no second format to switch to |
| Show line numbers, vim bindings, live preview, fold, indent guides, auto-pair, tab size | The editor is a plain `<textarea>` — its own header says "no live preview, no CodeMirror, no plugins". Every one of these is a CodeMirror feature. They are one decision (adopt an editor component), not eight settings |
| Themes, community themes, CSS snippets, accent colour | The palette's contrast ratios are measured, and `docs/ACCESSIBILITY.md` treats them as a commitment. Arbitrary themes discard the measurement. `ARTWORK_OPACITY_MAX` exists for exactly this reason |
| Voice (40 keys), Billing, Providers, Gateway, Model, Memory & Context | No such subsystem in this app |
| Plugins / community plugins | No plugin host, and adding one is not a settings change |
| Hotkeys | Real work — needs a command registry first. There isn't one |
| Language / i18n | English-only, no i18n layer |
| Frame style, native menus, ribbon config, sliding sidebar | Window chrome decisions already made in `corner.ts` / `index.ts` |

---

## 5. If the dialog grows

The current flat modal holds six settings comfortably. It will not hold twenty.
Both references solved this the same way — a left nav with sections, content on
the right — and the section split that falls out of §4 is:

**Vault** (folder, excluded folders, daily notes) · **Editor** (font size,
readable line length, spellcheck) · **Appearance** (the four existing) ·
**Agent** (approvals mode, approvals timeout, trusted networks) · **About**
(version, export / import / reset).

That is a restructure of `SettingsDialog.tsx` and `settings.css`, and it should
happen *before* the second batch of settings lands, not after — retrofitting nav
onto a modal that has already grown is the more expensive order.

One thing to preserve if it does: the dialog is a real `<dialog>` +
`showModal()`, so the focus trap, Escape, focus restore and top layer are the
platform's job. A nav rewrite must not quietly turn it back into a div.
