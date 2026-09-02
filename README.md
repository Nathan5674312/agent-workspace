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

- **The agent reads only.** The Claude session in the terminal panel has its
  tool list fixed to `['Read', 'Glob', 'Grep']` at `src/main/agentHost.ts:128`.
  It can answer questions about the vault. It cannot write a note, edit one, or
  run anything. This is a boundary, not an oversight — the consent gate that
  would front an agent write already exists in `src/main/consent.ts`, and what
  is missing is the write tools behind it and the lost-update handling for an
  agent editing a note the user has open.
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
- **Nothing leaves the machine** except two requests, both of which you start:
  the agent panel, which sends what you type and what it reads to Anthropic's
  API; and Settings → About → *Check for updates*, which asks GitHub for this
  repository's latest release tag and sends nothing. There is no update check on
  launch and no timer — see `src/main/update.ts`.

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
