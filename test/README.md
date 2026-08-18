# Section 4: Data Layer Tests

## How to run

Tests are written as `.mjs` (JavaScript) files for direct execution:

```bash
node --test test/section4-data-layer.test.mjs
```

Or from npm:

```bash
npm test -- test/section4-data-layer.test.mjs
```

The npm test script (`package.json: "node --test test/"`) does not work without modification because it tries to load `test/` as a CommonJS module rather than discovering test files. The tests themselves require no external dependencies or frameworks — just Node's built-in `test` module.

## What is covered

- **list()**: returns all notes with correct shape
- **read()**: returns the file's text and its `mtimeMs`, stable across repeat reads; handles spaces and special characters (`#`, `&`) in paths
- **save()**: writes notes through a temp file and a rename, creates a note that does not exist yet, backs the old text up under `.backups/`, throws `SaveConflict` on a stale mtime without touching the file, and cannot truncate a note when the write fails
- **tree()**: builds nested folder structure, sorts folders before notes alphabetically, preserves all notes at any depth
- **graph()**: resolves `[[wikilinks]]` case-insensitively, ignores self-links, ignores links to nonexistent notes
- **backlinks()**: returns unique list of notes linking to a given note
- **path containment**: `../`, absolute and UNC paths are refused by `read()` and `save()` alike — see `review-s4-security.test.mjs`
- **error scrubbing**: fs errors reach the renderer with the absolute path removed

## What is deliberately not covered

- Sections 1–3 (renderer, Claude session, corner) — those are owned by other agents
- Electron process model — tests run under `node --test`
- Concurrent writers from OUTSIDE the app — the mtime guard is asserted against a file changed between a read and a save, not against a second process racing the rename

## What used to be here

The vault used to be served by `note-system/app/server.py` over HTTP on
127.0.0.1:8765, and these tests drove a mock of it (`test/helpers.mjs`). That
server was destroyed in a machine rebuild; `read()` and `save()` were the last
two calls behind it and now read and write the vault directory directly. The
mock, the `VaultUnavailable` error it raised, the response-parsing tests and the
15-second wire-timeout test all went with it. Path traversal used to be
server.py's `safe()` and explicitly trusted here; it is `resolveInVault()` now
and is tested rather than trusted.
