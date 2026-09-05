# Changelog

Notable changes, newest first. Dates are the day the release was cut.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.5] — 2026-09-05

The window is the app's own, top to bottom. Nothing in it says Electron any
more.

### Changed

- **No operating-system title bar.** The app's chrome now runs to the top edge
  of the window and Windows draws minimise, maximise and close over it. They
  are the real system buttons, not drawn ones, so snap layouts on maximise
  hover, the oversized hit target in the screen corner and every accessibility
  affordance still work exactly as they did.
- **The window controls follow your theme.** Their background and symbol colour
  are read from the palette every time you change it. This matters most on
  Parchment, which is the one light theme: a fixed dark strip would have been
  visibly wrong in six of the seven.
- **The menu bar is gone.** `File / Edit / View / Window / Help` was Electron's
  stock menu — nothing in this app created it and every entry on it was a
  framework default. There is no File command Fate has, clipboard shortcuts are
  handled by the editor itself, and Help is the `?` beside the vault name.

### Fixed

- **The app printed an error to its log on every single launch.** It read
  `ENOENT ... .obsidian/bookmarks.json`, and nothing was broken: the bookmark
  menu item read that file when it mounted, to decide whether its row should
  say Bookmark or Remove bookmark, and most vaults have never had one. The
  cause was not the read but WHEN — every menu in the app mounted its contents
  while closed, so a closed menu was reading a file to label a row nobody could
  see. Menus now build their contents the first time they are opened. An error
  printed every launch for a normal condition is how real errors stop being
  read.

### Known limitations

- **The window no longer displays its own title.** With the OS bar gone there is
  nowhere in the window that says "Fate"; the taskbar button and the task
  switcher still do.
- **The themed window icon has one fewer place to appear.** It set the icon for
  the title bar, the task switcher and the taskbar button. There is no title
  bar now, so it governs the other two.
- **Windows only, as before.** The overlay that draws these controls is a
  Windows feature. The macOS and Linux targets remain configured and never
  built.

## [1.0.4] — 2026-09-04

The taskbar shows the app's own icon.

### Fixed

- **The taskbar button kept a stale icon and would not merge with the pinned
  shortcut.** Windows identifies a taskbar button by AppUserModelID, not by the
  window's icon, and nothing ever set one — so Windows derived an identity from
  the executable path, which is a different identity from the one the installer
  stamps onto the Start Menu shortcut. Every symptom looked like "the icon did
  not update", including `setIcon` having no effect on the button. The app now
  declares the same id the installer writes, before the first window exists.

### Known limitations

Unchanged from 1.0.3. In particular: the taskbar, Start Menu, desktop and
installer icons show the Founder's palette and cannot follow your theme. Those
are read by Windows from the executable's own resource before any of this app's
code runs. The title bar and the task switcher do follow your theme, and they
are the only two that can.

## [1.0.3] — 2026-09-04

A new app icon, and it wears whatever theme you are in.

### Added

- **The icon follows your theme.** Pick Forest and the title bar, task switcher
  and taskbar button go green; pick Parchment and they go to dark ink on warm
  paper. It changes the moment you change the theme, not on the next launch.
  The seven icons are generated from the same two SVGs as the app icon and
  coloured by reading the real values out of `tokens.css` and `themes.css`, so
  a palette edit produces a new icon with nothing else touched.

### Changed

- **New mark: an hourglass.** The old one was a thread walked through a graph
  with three stops — right about the idea, wrong about the size. At 24px the
  three stops fused into a lump and the mark stopped being anything. An
  hourglass has a silhouette that survives 16px, which is the size that
  actually gets seen. The top is solid and the bottom is hollow: sand not yet
  fallen, the step not taken, which is the same thing the old hollow ring said.

### Fixed

- **"1 changes across 3 files".** The update panel did not make its counts
  singular, which 1.0.1 and 1.0.2 both shipped. Small, and the first sentence of
  a panel whose whole claim is that what it lists can be trusted.

### Known limitations

- **The installer, Start Menu and desktop icons do not follow the theme, and
  cannot.** Those are read by Windows from the executable's own resource, long
  before any of this app's code runs, and nothing may rewrite an installed
  binary. Only a running window's icon can change. The binary keeps the
  Founder's palette.
- Unchanged from 1.0.1: the update is not downloaded for you, and builds are
  unsigned.

## [1.0.2] — 2026-09-04

**No change to the app itself.** This release fixes the release tooling and
proves the update path end to end — a 1.0.1 install being told about 1.0.2,
reading what changed, and choosing. Stated plainly because a release note that
dressed this up as a feature would be the first lie in a panel whose entire
purpose is that you can trust what it lists.

### Fixed

- **The preflight only checked local tags.** `gh release create` makes the tag
  on GitHub, so a clone that has not fetched since has no such ref — and the
  check answered "does not exist, it will be created at HEAD" about a tag that
  already existed at another commit. That is precisely the fault the script was
  written to catch, reported as an all-clear. Observed on 2026-09-04, minutes
  after v1.0.1 was published, while cutting this release. It now asks `origin`
  first and says which source answered; if origin cannot be reached it falls
  back to the local ref and says the check was partial, because a preflight that
  quietly degrades is worse than one that admits it.
- **The preflight printed a fatal error while passing.** `git rev-parse` on a
  tag that does not exist writes "fatal: ambiguous argument" to stderr, which
  went straight to the terminal inside a check that was succeeding.

### Known limitations

Unchanged from 1.0.1: the update is not downloaded for you, builds are
unsigned, and anyone still on 1.0.0 has no launch check and must find an update
by hand.

## [1.0.1] — 2026-09-04

The app can now tell you an update exists, and show you what is in it before
you agree to take it. 1.0.0 could only be asked; it could never say.

### Added

- **Update panel on launch** — when a newer release exists, one panel on open
  listing what changed: the commit subjects, the files, and the lines added and
  removed in each. Three answers of equal weight — take it, not now, or stop
  asking — under the line "Your device, your choice on what happens to your
  app." Escape and the backdrop mean "not now" and can never mean "never",
  because switching notifications off is a decision and needs a button.
- **Notification setting** — `notifyUpdates` in `settings.json`, off from the
  panel itself, permanently. Absent means on, so only a refusal is ever
  written and an untouched install keeps no key. Settings are read BEFORE the
  request, so declining means the request is never made rather than that its
  answer is discarded. Settings → About keeps its manual button either way:
  declining to be told is not declining to be able to ask.
- **Skipped-release count** — miss two or more releases and the panel says how
  many and which. The changelog always spanned them all, because the comparison
  is `<your version>...<latest>`; what was missing was saying so.
- **`scripts/release-preflight.mjs`** — refuses to cut a release whose tag does
  not name the built commit, whose tree is dirty, or whose `dist/` does not
  match the version.
- **`docs/AGENT-RELEASE.md`** — the binding procedure for anyone, human or
  agent, shipping an update: the release sequence, the rubric commit subjects
  must meet (they are rendered verbatim to users in the update panel), the
  rubric for changelog entries, and the rules that exist because they were
  already broken once.

### Changed

- **The app now checks for updates when it opens.** 1.0.0 promised, in the
  README and in three places in the source, that it never would. That promise
  is withdrawn deliberately and the reasoning is in the header of
  `src/main/update.ts`: a user who is never told about a fix cannot choose to
  take it. The control moved rather than disappearing — see the setting above.
  There is still no timer, and still nothing sent: no identifier, no version,
  no telemetry.
- **`docs/RELEASING.md`** gained the tagging rules, and the rate-limit note
  gained arithmetic: one launch is one request when up to date, three when
  behind, against an anonymous ceiling of 60 an hour.

### Fixed

- **`v1.0.0`'s tag named the wrong commit.** It pointed at `aef15d7`
  (2026-08-11); the binaries published under it were built from `de80b34`
  (2026-09-01), 155 commits and +26,872/-1,514 lines later. Confirmed by
  rebuilding `de80b34` from a clean clone — its `app.asar` came out within 2 KB
  of the shipped one. The tag has been moved to `de80b34`. Nothing about the
  1.0.0 binary changes; it was always this code.
- **The graph flung the camera** when a drag stopped before the button was
  released. `VelocityTracker` measured across its own samples, and a stationary
  pointer emits no events, so it reported mid-drag speed indefinitely — the
  longer you held still, the more wrong it got. Measured after the fix: held
  still 200 ms, 0 px/s; released mid-motion, unchanged.

### Known limitations

- **The update is not downloaded for you.** "Get the update" opens the release
  page; you download and run the installer yourself. Auto-download needs code
  signing first.
- **Builds are unsigned**, so SmartScreen warns on first run.
- **Anyone on 1.0.0 will not be told about this release automatically** — 1.0.0
  has no launch check. This is the last update that has to be found by hand.

## [1.0.0] — 2026-09-01

First release. 143 commits over three weeks, from an empty repository on
2026-08-10.

### The shape of it

A local-first Markdown vault workspace for Windows. It reads and writes the
folder you point it at, in place, and adds nothing to it. Obsidian can have the
same folder open at the same time.

### Added

- **Files** — folder tree that honours the vault's own `.obsidian` exclusions,
  and a vault switcher for more than one folder.
- **Search** — a linear scan across the vault with per-note hit capping, so a
  query that matches 400 times reports "5 of 400" rather than pretending. No
  index, so nothing is ever stale.
- **Editor** — Markdown with wikilinks, frontmatter, and block references
  (`^anchors`, "Copy block ref", the Links list rendering fragments).
- **Graph** — force-directed view of `[[links]]`, with hold-to-orbit, filters
  and display controls in the view itself. Alt-drag one node onto another and
  the link is written into the Markdown.
- **Database** — table, board and gallery over frontmatter, with filter, sort
  and group-by. `type` and `status` cells are editable and write back through
  the same save path as the editor, so a property edit keeps a `.backups/` copy
  and runs the same lost-update check. Enter commits; Escape writes nothing.
- **Facets** — tags that form without anyone maintaining them, derived from
  folder, filename date, link shape and neighbourhood. This exists because
  hand-maintained metadata does not survive contact with use: across 1999 real
  notes, six separate tagging conventions each stalled near 5% coverage. Run
  over the author's vault, 463 of 465 notes carry at least one derived facet.
- **Canvas** — `.canvas` boards in the JSONCanvas format Obsidian uses, with
  groups that carry their pages, alignment guides, snapping and edge labels.
- **Planner** — the month and the daily notes on one page.
- **Versions** — every save writes through a temp file and a rename, keeping the
  pre-edit copy under `.backups/`, and refuses on a stale mtime rather than
  overwriting a change it did not see.
- **Bookmarks** — stored in Obsidian's own `.obsidian/bookmarks.json`, so a
  bookmark made in either app shows up in the other.
- **Templates** — new note from `Templates/`, as a split button on "+ Note".
- **Seven themes**, each solved against its own contrast bars, and the semantic
  colours themed alongside the palette rather than left at a stray amber.
- **Agent corner** — a Claude session per tab, each turn in its own OS process
  so one crashing takes neither the app nor another session with it. Consent
  prompts are gated on WHO originated an action, not what it was: a user who
  clicked IS the consent; an agent that decided gets a prompt with its reason.
- **Roadmap tab** — the feature list as data, read from `src/shared/roadmap.ts`
  by both the tab and the left ribbon, so the two cannot drift.
- **Network trust** — a fingerprint store keyed on the default gateway's MAC
  where it can be read, falling back to SSID as weaker evidence. Fails closed:
  an unknown network is untrusted.

### Security

- Every vault path resolves through `resolveInVault()`, which refuses `../`,
  absolute and UNC paths.
- Filesystem errors are scrubbed of absolute paths before crossing to the
  renderer.
- The renderer is context-isolated with no node integration and no direct
  filesystem access.
- Only `http:` and `https:` URLs are handed to the OS, parsed with `new URL`
  rather than matched with a regex.
- No argument reaches a subprocess as part of a built string.

### Known limitations

Stated so they are not discovered. Each is tracked in `src/shared/roadmap.ts`.

- **The agent reads only.** Its tool list is fixed to `['Read', 'Glob', 'Grep']`
  at `src/main/agentHost.ts:128`. It cannot write a note, edit one, or act on
  the vault. The consent gate that would front an agent write already exists;
  the write tools behind it do not.
- **Windows only.** The `mac` and `linux` electron-builder targets are
  configured and have never been built or run.
- **Unsigned.** No code-signing certificate, so Windows SmartScreen warns on
  first run.
- **No sync, sharing, comments or multiplayer.** One machine, one user.
- **No plugin API.** Nothing loads third-party code.
- **No import** from Notion, Evernote or anywhere else. Obsidian needs none —
  it is the same folder.

[Unreleased]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.4...v1.0.5
[1.0.0]: https://github.com/Nathan5674312/agent-workspace/releases/tag/v1.0.0
