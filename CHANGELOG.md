# Changelog

Notable changes, newest first. Dates are the day the release was cut.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
