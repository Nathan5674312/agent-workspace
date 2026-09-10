# Changelog

Notable changes, newest first. Dates are the day the release was cut.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.1.0] — 2026-09-09

Everything on the 9/4–9/6 list. The theme underneath it is waiting: the app now
says when it is working, keeps the screen you are on until the next one can
draw, and stops charging you a pause for a move you already made.

### Added

- **Ctrl+P opens a note by name.** The app had one search and it answered one
  question — which notes *say* this. Reaching a note you can already name meant
  scrolling the tree. Ctrl+P or Ctrl+O (both, because both are muscle memory)
  opens a box over the pane: type, arrow, Enter. It matches names against the
  tree this process already holds, so it runs on every keystroke with no disk
  read and no IPC round trip.
- **The window says when it is working.** Two pixels of light along the top
  edge. Every read had its own local spinner and none could tell the *window*
  anything, so a 200ms vault read looked like a click that missed. No box, no
  percentage, `pointer-events: none` so the tab strip and window controls
  underneath are untouched, and it uses `--accent`, so it is the theme's own
  colour in all seven.

### Changed

- **Search matches words, not the literal string.** `fate food` searched for
  those nine characters in that order and returned nothing. Measured on a
  471-note vault: 0 notes as a phrase, 7 notes in 196ms as words. A note matches
  when every term appears somewhere in it.
- **A surface waits until it can draw, instead of blanking first.** Clicking
  Graph swapped the pane on the click and then sat on an empty "Building the
  graph…" for as long as the vault took. The work is the same; you now wait on
  the screen you already have, which still scrolls and still reads.
- **Returning to a surface is one frame.** Only a first load waits. The hold
  asked two questions where one would do, and every *return* paid a round trip
  for data already on screen. Measured against 1.0.7: the graph paints in 15ms
  against 300ms, the database in 343ms against 509ms.
- **The first run asks where your notes are, and nothing else.** The tour that
  named Graph and Canvas stood between a new install and the one thing it has to
  do. Two steps now: the vault folder, then the theme.
- **The canvas sidebar splits into two panes.** The file tree was a sliver that
  could not be resized, and the vault name overlapped the search box.
- **Hovering across the graph fades instead of flashing.** Every node the
  pointer passed over re-dimmed the entire canvas, so crossing six in a second
  was six full-contrast flips. A pointer travelling *through* a node is not
  pointing at it: nothing happens until it has stayed 70ms.

### Fixed

- **A folder picker on next launch, after the settings file was damaged.** The
  app answers with defaults when `settings.json` cannot be read, which is right.
  The first setting you then touched wrote a fresh file over the damaged one and
  the vault folder you had picked was gone for good. A damaged file is now kept.
- **Highlighting lagged when moving between two nodes.** One dwell was charged
  for two different events. Dimming the whole canvas is worth deliberating over;
  changing *which* node is lit while the canvas is already dim is not, and it was
  paying the same 70ms.
- **The Forces panel opened below the bottom of the window.** Nothing threw and
  every slider worked, which is why a first pass called it fine. It is 733px of
  sliders in a fixed box with no `max-height`, and an unbounded fixed box has no
  reason to scroll.
- **The Forces button animated backwards before settling.** It measured, moved
  the control back where it *was*, then tweened it to where it now is — so every
  play began by going the wrong way, and the eye read it as the app fighting
  itself.
- **The canvas could keep showing the previous node after a hover switch.** The
  repaint only happened because the simulation was warm; on a settled layout, or
  with Reduced Motion where the simulation is stopped, the highlight stayed put
  while the label underneath had already changed.
- **Zooming the canvas popped a scrollbar and shifted the whole app.**

### Known limitations

- **Windows only.** The macOS and Linux targets are configured and have never
  been built.
- **Unsigned.** No code-signing certificate, so SmartScreen warns on first run.
  Verified on this build: `Get-AuthenticodeSignature` reports `NotSigned`.
- **The agent reads but does not write.** Its tool list is Read, Glob and Grep.
- **Nothing prunes version history.** It grows until you clear it.
- **No sync, sharing, comments or multiplayer.** One machine, one user.

## [1.0.7] — 2026-09-06

The rest of the 9/4 list, and the app fits in a corner of a screen.

### Added

- **The window can be small.** The floor was 1100x700 — wider than half of a
  1920 screen, so Fate could not sit beside an editor at all. It is 360x400
  now, and the sidebar is capped against the window rather than fixed, so a
  quarter-screen snap keeps a usable note instead of a 90px sliver. Drag the
  sidebar to whatever width you like; it only gives way when the window is too
  small to honour it.

### Changed

- **The Forces button gets out of the agent panel's way, smoothly.** It moved
  before; it moves better now — GSAP animates it on a transform instead of a
  CSS transition on `top`, so the graph pane no longer reflows on every frame
  of it, behind a canvas of several hundred nodes.

### Fixed

- **The Forces button no longer hunts up and down** while agents are working.
  It was measuring its own position mid-animation, so every update from the
  activity panel computed a move against a target that was itself still
  moving, and relaunched from a wrong number.
- **Settings → Appearance → Motion → Reduced now applies to everything.** It
  was honoured by the stylesheet and ignored by every animation the app runs
  itself, which made the setting a half-truth.

## [1.0.6] — 2026-09-05

The update button updates the app. It used to open a web page.

### Changed

- **"Get the update" now downloads, installs and restarts.** It was a link to
  the release page: the app told you a version existed and then left you to
  find a 100 MB installer, run it, and reinstall Fate over itself — every time,
  for every release. It worked exactly as written and still read as broken,
  because that is not what the button says. Pressing it now fetches the update,
  checks it, closes Fate and reopens it on the new version.
- **The download is only what changed.** Around 350 MB of the install is the
  Electron runtime and it is identical between releases, so the update fetches
  the blocks that actually differ rather than the whole installer. A release
  that only changes app code moves single-digit megabytes.
- **Nothing downloads until you press the button.** No background download, no
  timer, and an abandoned download is not left primed to install the next time
  you quit. The launch check is still a single GET that sends nothing, and
  "Don't notify me about updates" still ends it for good.
- **A failed update leaves the download page on offer** rather than a dead end,
  and says what went wrong.

### Fixed

- **1.0.5 installed and then never opened.** The window is created hidden and
  shown when Electron reports it has painted, and in a packaged 1.0.5 build
  that report never arrived: the app started, loaded, rendered its whole
  interface and put nothing on screen. Found by attaching a debugger to the
  packaged build — the page was complete and error-free while Windows was told
  about no window at all. There is now a second, independent trigger, so the
  app becoming visible no longer depends on one event that can go missing.
- **The installer's filename no longer contains spaces.** GitHub rewrites
  spaces to dots when an asset is uploaded, which would have left the update
  metadata asking for a file the release does not have, on a release page that
  looks perfectly complete.

### Note

- **Updating FROM 1.0.5 or earlier is still manual, once.** Those releases were
  published before any of this existed and carry no update metadata, so 1.0.6
  has to be installed by hand. Every release after it updates in place.

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

[Unreleased]: https://github.com/Nathan5674312/agent-workspace/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.7...v1.1.0
[1.0.7]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Nathan5674312/agent-workspace/compare/v1.0.4...v1.0.5
[1.0.0]: https://github.com/Nathan5674312/agent-workspace/releases/tag/v1.0.0
