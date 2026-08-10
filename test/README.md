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
- **read()**: fetches note content and mtime; handles URL encoding for spaces and special characters (`#`, `&`)
- **save()**: writes notes, increments mtime, throws `SaveConflict` on stale mtime
- **tree()**: builds nested folder structure, sorts folders before notes alphabetically, preserves all notes at any depth
- **graph()**: resolves `[[wikilinks]]` case-insensitively, ignores self-links, ignores links to nonexistent notes
- **backlinks()**: returns unique list of notes linking to a given note
- **VaultUnavailable**: thrown when the vault server is not reachable

## What is deliberately not covered

- Sections 1–3 (renderer, Claude session, corner) — those are owned by other agents
- Integration with the real `server.py` — tests run against a local mock HTTP server
- Electron process model — tests run under `node --test`
- Network errors beyond connection failure — timeout and partial reads are not simulated
- Access control and path traversal — server.py owns those guards; we trust them
