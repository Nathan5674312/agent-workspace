# Changelog

Notable changes, newest first. Dates are the day the release was cut.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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

[Unreleased]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Nathan5674312/agent-workspace/releases/tag/v1.0.0
