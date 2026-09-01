# Settings research — Hermes, Obsidian, Notion, Zed, VS Code, Logseq

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
| **Notion desktop** | `%APPDATA%\Notion\state.json` — the LIVE preference object this machine's install has written, plus `resources\app.asar` grepped for `spellCheck`. Second pass, 2026-08-31 |
| **Zed** | `zed-industries/zed` → `assets/settings/default.json`, the shipped defaults file. Second pass, 2026-08-31 |
| **VS Code** | `code.visualstudio.com/docs/getstarted/settings` plus the settings-editor group list. Docs, not a file — VS Code is not installed here, and that is a weaker source than the rows above |
| **Logseq** | `config.edn` documentation. Docs, not a file — not installed here |

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

> **Stale as written, corrected 2026-08-31.** Three things below changed since
> the first pass, and the differences matter because §5 was a prediction about a
> modal that no longer exists:
>
> - **The flat modal is gone.** `SettingsDialog.tsx` already has the left nav §5
>   recommended, with sections **Vault · Appearance · Agent**. The restructure
>   happened in the order §5 asked for — before the second batch, not after.
> - **`appearance.contrast` was removed**, deliberately: it duplicated
>   `@media (prefers-contrast: more)` in app.css by hand. The media query still
>   answers the OS; the in-app copy was the liability.
> - **Excluded folders, approvals mode and approvals timeout all shipped**, so
>   three rows of §4 are done. `appearance.theme` shipped too — seven palettes —
>   which reopens a §4 exclusion; see §9.6.

Persisted by `src/main/settings.ts` to `settings.json` in `userData`. The real
shape on 2026-08-31 is `vaultDir` · `pendingVaultDir` · `rootMismatch` ·
`appearance{theme, transparency, motion, artwork, artworkOpacity}` ·
`approvals{mode, timeoutMs}`.

The original six, for the record:

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

---

# Second pass — 2026-08-31

The first pass surveyed an agent app (Hermes) and a notes app (Obsidian). Asked
to widen it, this pass added a **desktop shell** (Notion), a **modern editor**
(Zed), and two reference taxonomies (VS Code, Logseq).

**It found one whole category the first pass missed, and it is the category this
app has least of.** Everything below is again read off a real file where the app
was installed, and marked docs-only where it was not.

## 6. Notion desktop — the settings a WINDOW needs

Notion's page-level settings are server-rendered and not on disk, so the asar is
not the interesting part. `%APPDATA%\Notion\state.json` is: it is the live
preference object, written by this machine's own install.

| Key | Value here | What it controls |
|---|---|---|
| `isOpenAtLoginEnabled` | `true` | Start with the OS |
| `onStartup` | `"continue"` | Restore the previous session vs a fresh window |
| `isHideLastWindowOnCloseEnabled` | `true` | Close button hides vs quits |
| `isMenuBarIconEnabled` | `true` | Tray / menu-bar icon |
| `isHardwareAccelerationDisabled` | `false` | GPU rendering — the standard escape hatch for driver bugs |
| `isAutoUpdaterDisabled`, `updaterChannel` | `false`, `null` | Update policy and channel |
| `zoomFactor` | `~1.0` | Whole-UI scale, distinct from any font size |
| `quickSearchShortcut` | `Shift+CommandOrControl+K` | A GLOBAL hotkey, live while the app is unfocused |
| `notionAiShortcut` | `shift+ctrl+j` | The same, for the agent surface |
| `isNavigationHistoryEnabled` | `true` | Back / forward |
| `locale` | `en-US` | Language |
| `contrastMode`, `osHighContrastEnabled` | `standard`, `false` | Accessibility, read from the OS |
| `spellCheck` | 8 hits in the asar | Spellcheck |

## 7. Zed — the defaults file

`assets/settings/default.json`, the shipped defaults. Application-level keys
only; the per-language and LSP half does not apply here.

| Key | Default | Note |
|---|---|---|
| `theme` | `{mode: "system", light, dark}` | **A theme PAIR plus a mode**, not one name — see §9.6 |
| `ui_font_size` / `buffer_font_size` | `16` / `15` | **Two scales, not one** — see §9.5 |
| `buffer_line_height` | `"comfortable"` | Named, not numeric |
| `restore_on_startup` | `"last_session"` | Session restore |
| `confirm_quit` | `false` | Guard on exit |
| `autosave` | `"off"` | Zed also defaults to manual saving |
| `auto_update` | `true` | |
| `telemetry` | `{diagnostics, metrics}` | Two independent toggles, not one |
| `private_files` | `["**/.env*", "**/*.pem", "**/*.key", "**/*.cert", "**/secrets.yml"]` | **See §9.4 — the highest-value row in this document** |
| `redact_private_values` | `false` | |
| `file_scan_exclusions`, `file_scan_depth` | `.git`, `.DS_Store`, … / `5` | Confirms the first pass's exclusion work |
| `accessible_mode` | `false` | |
| `cursor_blink`, `scrollbar.show`, `hide_mouse` | | Presentation detail |

## 8. VS Code and Logseq — taxonomy only

Neither is installed here, so these are docs and rank below every row above.

**VS Code** groups its settings editor as *Commonly Used · Editor · Workbench ·
Window · Files · Update · Telemetry · Terminal · Extensions · Features*, plus
per-language. Two ideas are worth taking and neither is a setting:

1. **A "Commonly Used" group at the top** — a ranked entry point, not a category.
2. **Some settings are user-scope ONLY and cannot be set per workspace**, because
   they name an executable. Security expressed as *scope*, not as a checkbox.

**Logseq** contributes one thing the others do not: the journal / daily note is
configured rather than hardcoded — `:journal/page-title-format` (default
`MMM do, yyyy`), a default journal template, and a preferred format. That is the
direct precedent for the daily-notes row already in §4.

---

## 9. What the wider survey actually adds

Seven findings. The first is the big one.

### 9.1 There is a whole category this app has NOTHING of: the desktop shell

The first pass surveyed what a *document* app configures. Notion and Zed both
show a second layer underneath: what a *window* configures. Verified by grep on
2026-08-31 — `src/main/` contains **no** `autoUpdater`, **no** `Tray`, **no**
`globalShortcut`, **no** `setLoginItemSettings`, **no**
`disableHardwareAcceleration`, and `index.ts` hardcodes `width: 1600,
height: 1000` with no persistence.

| Missing | Precedent | Consequence today |
|---|---|---|
| Window size and position remembered | universal | Every launch is 1600×1000 wherever the OS puts it |
| Restore session on startup | Notion `onStartup`, Zed `restore_on_startup` | Open tabs are lost on quit |
| Start on login | Notion `isOpenAtLoginEnabled` | — |
| Close to tray vs quit | Notion `isHideLastWindowOnCloseEnabled` | Closing kills running agents |
| Tray icon | Notion `isMenuBarIconEnabled` | No surface while unfocused, though agents run in the background |
| Hardware acceleration off | Notion `isHardwareAccelerationDisabled` | No escape hatch for a GPU driver bug, on a GTX 1660 SUPER |
| Global hotkey | Notion `quickSearchShortcut` | — |

**Window bounds is the one to build first.** Cheapest, most universally
expected, and the only one here a user notices every single launch.

### 9.2 Updates are absent, and roadmap note 11 needs them

No `autoUpdater`, no channel, no "check for updates". Notion, Zed and VS Code all
carry it. `Fate/Roadmap/11 - Shipping the App` settles on Developer ID +
notarization with download-from-the-site, and that distribution has no store to
push updates — so the updater IS the delivery mechanism, not a nicety. The
setting is small; the machinery behind it is a shipping decision.

### 9.3 Telemetry: the honest answer is a STATEMENT, not a toggle

Zed ships `telemetry.{diagnostics, metrics}`; VS Code has a Telemetry group.
This app should ship **neither**, and should say so where a user looks for it.
`roadmap.ts` records the measurement: nothing under `src/` calls fetch, axios,
XHR, WebSocket, `http.request` or `createServer`, and `index.html` enforces
`connect-src 'none'` under `default-src 'none'`. A toggle implies something to
turn off and would be the only dishonest control in the app. **A line in About
is the correct build.**

### 9.4 Secret redaction — the highest-value row in this document

Zed ships `private_files` (`**/.env*`, `**/*.pem`, `**/*.key`, `**/*.cert`,
`**/secrets.yml`) and `redact_private_values`. This app has **no equivalent**,
and it matters more here than in Zed, because this app spawns agents that read
the vault: `claude.ts` starts the user's own CLI against the vault root, and
`terminal.ts` spawns a shell.

The gap is sharper than "a missing feature". The machine's own `CLAUDE.md`
states that secrets *are* blocked from agent file tools "by design". Nothing in
this repo implements that. The claim and the code disagree, and the survey is
what surfaced it. Whether the fix is a setting, a hardcoded list, or a main-side
filter in `vault.ts`'s `walk()` is a design question — but the exclusion list
belongs beside `HIDDEN` / `SKIP`, which already exist and already work.

### 9.5 The first pass conflated two different font sizes

§4 proposes "editor font size". Zed separates `ui_font_size` from
`buffer_font_size`; Notion has `zoomFactor` for the whole UI. They are different
settings with different blast radii: UI scale reflows every pane and is an
accessibility control; editor size affects prose only and is a reading-comfort
control. tokens.css already sizes everything in `rem` "so a larger system text
size scales the layout with it", which makes **UI scale nearly free** — one
property on the root — while editor size needs its own token.

### 9.6 A §4 exclusion has been overturned, correctly

§4 rules out themes: "the palette's contrast ratios are measured, and
docs/ACCESSIBILITY.md treats them as a commitment. Arbitrary themes discard the
measurement." Seven palettes shipped on 2026-08-31 and the objection was met
rather than ignored — every palette is *solved* to the founder's own ratios and
`test/themes.test.mjs` re-measures all of them on every run. The rule the
exclusion protected is intact; what was wrong was assuming a theme picker
implies *arbitrary* themes. Zed's `theme` shape — a light/dark pair plus
`mode: system` — is the next step if this app ever follows the OS.

### 9.7 One gap no reference app has, found by absence

`.backups/` grows forever. `save()` writes a pre-edit copy on **every** save and
nothing prunes: measured on the real vault, 187 files / 871 KB, and `versions.ts`
says in its own header that it "creates nothing, prunes nothing". None of the
four reference apps has a retention setting, because none of them keeps a copy
per save — Obsidian's file recovery has an interval and a retention period, which
is the nearest thing. This is an app-specific need the survey surfaced by *not*
finding it: **backup retention (count or age), with prune on write.**

---

## 10. Revised build list

Supersedes §4's ordering. §4's "Does not apply" exclusions all still stand
except themes (§9.6).

### Tier 1 — cheap, expected, nothing new underneath

| # | Setting | Section | Why now |
|---|---|---|---|
| 1 | **Window size + position remembered** | (no UI) | Noticed every launch. Not a setting at all — just persistence |
| 2 | **UI scale** | Appearance | Everything is already `rem`; one root property |
| 3 | **Editor font size** | Editor (new) | Its own token, live-applied like appearance |
| 4 | **Readable line length** + width | Editor | `max-width` on the textarea |
| 5 | **Spellcheck** | Editor | One attribute; Chromium does the rest |
| 6 | **Export / Import / Reset config** | About (new) | One object, one sanitiser, `save(defaults)` |
| 7 | **About**: version, vault path, settings path, "no telemetry, no network" | About | §9.3 |

### Tier 2 — real machinery, high value

| # | Setting | Why |
|---|---|---|
| 8 | **Backup retention** + prune on write | §9.7. Unbounded growth today |
| 9 | **Secret exclusion list** | §9.4. The claim and the code disagree |
| 10 | **Restore session on startup** | Open tabs are lost on quit |
| 11 | **Trusted networks review + revoke** | §4. Store exists, no UI |
| 12 | **Daily notes**: folder, format, template | §4 + Logseq precedent. Vault facts living in source |

### Tier 3 — needs a decision first

| # | Setting | Blocked on |
|---|---|---|
| 13 | Close-to-tray + tray icon | Product call: agents run in the background, so this changes what quitting MEANS |
| 14 | Start on login | Follows 13 |
| 15 | Auto-update + channel | Needs the updater to exist — roadmap note 11 |
| 16 | Hardware acceleration off | Needs a restart-required pattern; `vaultDir` already has one to copy |
| 17 | Global hotkey | Needs a command registry — same blocker as hotkeys in §4 |

### Still excluded

Everything in §4's "Does not apply" except themes. The eight CodeMirror-dependent
editor settings remain one decision (adopt an editor component), not eight
settings — that is the roadmap's **Markdown support** item, not a settings task.

### Structural notes for whoever builds this

- Sections become **Vault · Editor · Appearance · Agent · About**. Two new.
- §5's warning still applies and is now load-bearing: the dialog is a real
  `<dialog>` + `showModal()`, so focus trap, Escape, focus restore and top layer
  are the platform's job. **A nav rewrite must not turn it back into a div.**
- Adopt Obsidian's nesting rule from §2 at Tier 1: readable-line *length* nests
  under readable-line, as artwork opacity already sits beside artwork. Past two
  dependent settings, nesting scales and disabling does not.
- Every new key needs a row in `sanitize()` in `src/main/settings.ts`. That
  function is the single trust boundary, and an unvalidated key is how junk from
  a hand-edited `settings.json` reaches the renderer.
