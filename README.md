# Fate

A local-first vault workspace. Your notes are Markdown files in a folder you
already own — Fate reads and writes them in place, adds nothing to them, and
takes nothing out of the folder. Point it at an Obsidian vault and both apps
work on the same files.

Windows desktop app, Electron. Version 1.0.0.

## What it does

Eight surfaces over one folder of Markdown:

| | |
|---|---|
| **Files** | Folder tree, honouring the vault's own exclusions |
| **Search** | Linear scan across the vault, no index to go stale |
| **Editor** | Markdown, wikilinks, frontmatter, block references |
| **Graph** | Force-directed view of `[[links]]`; alt-drag two nodes to write a link into the Markdown |
| **Database** | Table, board and gallery over frontmatter, with filter, sort, group-by and editable `type`/`status` cells |
| **Canvas** | `.canvas` boards — the JSONCanvas format Obsidian uses |
| **Planner** | The month and the daily notes on one page |
| **Versions** | Every save keeps the pre-edit copy under `.backups/` |

Plus bookmarks shared with Obsidian's `bookmarks.json`, templates from
`Templates/`, backlinks, seven themes, and a Roadmap tab that reads
`src/shared/roadmap.ts` so the app grades itself against the same list this
README does.

## What it does not do, in 1.0

Stated here so it is not discovered.

- **The agent can write, but only through two tools, and only with your
  permission.** Its BUILT-IN tools are still read-only — `['Read', 'Glob',
  'Grep']`, no Bash, and deliberately not the SDK's own `Write` or `Edit`,
  which would go straight to disk behind the vault's back. Mutation goes
  through `write_note` and `move_note` instead, which cannot touch the disk
  themselves: they round-trip to the main process, which calls the same
  `src/main/vault.ts` functions your own clicks go through. So an agent write
  gets the pre-edit backup, the atomic rename, the trash, the undo record, and
  a consent prompt carrying the agent's own stated reason. If you have the note
  open, your next save raises the conflict dialog rather than losing what you
  typed. There is no delete tool — a move to the trash is what deletion means
  here, and `move_note` already says it, reversibly.
- **The agent still cannot run anything.** No Bash, no shell, no processes. It
  reads, writes notes, and moves them; that is the whole of its reach.
- **Windows only.** The `mac` and `linux` targets in `package.json` are
  configured and have never been built or run. Treat them as untested
  scaffolding, not as supported platforms. See [Building](#building).
- **No sync, no multiplayer, no sharing, no comments.** One machine, one user.
  Sync is whatever you already put the folder in — Dropbox, Syncthing, git.
- **No plugin API.** Nothing loads third-party code.

The full feature list with honest per-item status is `src/shared/roadmap.ts`,
which is also what the Roadmap tab renders. An entry moves to `built` only when
someone has watched it work and written down what they saw.

## Install

Download the latest release and run the installer:

**[github.com/Nathan5674312/agent-workspace/releases/latest](https://github.com/Nathan5674312/agent-workspace/releases/latest)**

Windows builds are currently **unsigned**, so SmartScreen will warn on first run
— "More info" then "Run anyway". Windows is the only platform ever built; see
[Known limitations](#what-it-does-not-do-in-10) and `docs/RELEASING.md`.

To find out whether a newer version exists: Settings → About → *Check for
updates*. It reads the releases API and nothing else.

On first launch, open Settings and pick your vault folder. Nothing is read until
you do.

## Where your data lives

- **Your notes** stay in the folder you picked. Fate never copies them out.
- **Backups** of every overwritten note go to `.backups/` inside that folder.
- **App settings** — vault path, theme, layout — go to Electron's `userData`
  directory. Nothing else is stored.
- **Nothing leaves the machine** except two requests. The agent panel sends
  what you type and what it reads to Anthropic's API, and you start that one by
  typing. The other is the update check: it asks GitHub for this repository's
  latest release tag, and sends nothing — no identifier, no version, no
  telemetry.

  **The update check runs when the app opens**, and again if you press
  Settings → About → *Check for updates*. There is no timer. If a newer version
  exists you get one panel listing what changed, with three answers on it — take
  it, not now, or stop asking — and the last of those is remembered. Turning it
  off stops the launch check entirely; the button in Settings still works,
  because declining to be told is not the same as declining to be able to ask.
  See `src/main/update.ts`.

## Development

```bash
npm install
npm run dev        # electron-vite dev
npm run typecheck  # tsc --noEmit
npm test           # node --test over test/
npm run build      # typecheck + electron-vite build
```

Node 22+. The test suite is 1000+ assertions of plain `node:test` with no
framework and no mocking library; the pure logic lives in `src/shared/` for
exactly that reason.

### Building

```bash
npm run dist       # build + electron-builder, current platform
```

Windows produces an NSIS installer and a zip into `dist/`. macOS builds require
macOS. Linux AppImage builds from a non-Linux host require Docker, which is why
neither has been produced here.

Icons are generated from `build/icon.svg`:

```bash
npm run icons
```

## Architecture

Three processes, and the boundary between them is the security model.

- `src/main/` — Node. Owns the filesystem. Every vault path goes through
  `resolveInVault()`, which refuses `../`, absolute and UNC paths; fs errors are
  scrubbed of absolute paths before they cross to the renderer.
- `src/preload/` — the only bridge. Context-isolated, no node in the renderer.
- `src/renderer/` — React 19. Page-authored code lives here and gets no
  filesystem and no direct network.
- `src/shared/` — pure functions used by both sides, and where nearly all the
  tests point.

Agent turns run in their own OS process under `src/main/supervisor.ts`, so one
crashing takes neither the app nor another session with it.

## Licence

`LICENSE` currently reads **UNLICENSED — all rights reserved**. That is the
operative file. `docs/LICENSE-DRAFT.md` is an unreviewed draft and grants
nothing.

Third-party notices are in `NOTICE.md`.
