# Releasing

How a version reaches the people running the last one. Short, because the whole
mechanism is a static JSON file and a button.

## The update channel

There isn't an auto-updater, and that is a decision rather than a gap.

- **In the app:** Settings → About → *Check for updates*. It reads
  `https://api.github.com/repos/Nathan5674312/agent-workspace/releases/latest`,
  compares the tag to the running build, and either says you are current or
  offers a link to the release page. It sends nothing, downloads nothing
  executable, and runs on launch and when the button is pressed — no timer.
  The launch check is gated by `notifyUpdates` in settings.json, which the
  update panel can switch off permanently; settings are read before the request,
  so a refusal means it is never made. See the header of `src/main/update.ts`.
- **Cutting a release IS publishing the version.** There is no second file to
  remember to update, which is the failure mode a hand-written feed has.
- **This only works because the repository is public.** It was private until
  2026-09-01, and the same endpoint returned 404 to an anonymous caller; the
  feed pointed at a static JSON file on the product site instead. If the
  repository ever goes private again, `UPDATE_FEED` in `src/shared/update.ts`
  is one line to repoint and `parseFeed()` already understands the
  `{ "version": "1.0.1", "url": "…" }` file shape as well as GitHub's
  `tag_name`/`html_url`.
- **Not electron-updater**, which would need a real publish target and a
  differential-download story. A version number and a link is the whole
  requirement.
- **`publish` is `null`** in `package.json`: nothing is auto-uploaded. Artifacts
  go up with `gh release create`, deliberately, so no build ever publishes
  itself as a side effect of running.

Two things the GitHub API demands that are easy to get wrong, both handled in
`src/main/update.ts` and both silent failures if removed:

- **A `User-Agent` header is mandatory.** Without one GitHub answers 403, so the
  check never works rather than working badly.
- **`X-GitHub-Api-Version` is pinned** to `2022-11-28`. Unpinned, the response
  shape is whatever GitHub defaults to on the day a user clicks — a breaking
  change arriving inside an already-shipped binary.

Anonymous calls are rate-limited to 60 an hour per IP. That was irrelevant when
the check only fired on a button press; with a launch check it is worth stating
the arithmetic. One launch costs two requests — the feed, then the comparison —
so a person would have to open the app thirty times in an hour to reach the
limit, and behind shared NAT enough colleagues could. The failure is soft:
`fetchJson` returns null on the 403, so the panel does not appear rather than
appearing broken.

## Cutting a release

1. **Bump the version** in `package.json`. It is the single source: the About
   panel reads it through `__APP_VERSION__`, substituted at build time by
   `electron.vite.config.ts`, and `electron-builder` names the artifacts from
   it.
2. **Write the CHANGELOG entry.** Move anything under `[Unreleased]` into the
   new version, add the compare link at the bottom.
3. **Verify.**
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
4. **Build the artifacts.**
   ```bash
   npm run dist
   ```
   Windows only in practice — see the note below. Output lands in `dist/`:
   an NSIS installer and a zip.
5. **Publish the artifacts** to the download page.
6. **Preflight.** Between building and publishing, and nowhere else:
   ```bash
   node scripts/release-preflight.mjs
   ```
   It refuses a dirty tree, a `dist/` that does not match the version, and — the
   one that has actually bitten — a tag that already exists at some other commit.
   It prints the `gh release create` line with the sha filled in.
7. **Publish the release LAST**, once the artifacts are built and verified.
   ```bash
   gh release create v1.0.1 dist/*.exe dist/*.zip \
     --target <sha printed by the preflight> \
     --title "Fate 1.0.1" --notes-from-file CHANGELOG.md
   ```
   Creating the release is what tells every existing install that a new version
   exists, because `/releases/latest` starts answering with the new tag the
   moment it is published. So the artifacts have to be attached in the same
   command, not uploaded afterwards.

   The tag must parse as a version — `v1.0.1` or `1.0.1`. Anything else is
   refused by `isVersion()` and the app reports that it could not read the feed
   rather than guessing.

## The tag has to name the commit that was built

`v1.0.0` does not. It points at `aef15d7` (2026-08-11); the binaries published
under it were built from `de80b34` (2026-09-01 22:05), one minute before the
timestamps inside `Fate-1.0.0-win.zip` and 155 commits later. The two were
checked against each other by rebuilding `de80b34` from a clean clone: the
resulting `app.asar` came out within 2 KB of the shipped one, which 155 commits
and +26,872/-1,514 lines could not.

Nothing did anything obviously wrong. The tag was made when the version was
bumped, main kept moving, the artifacts were built weeks later, and
`gh release create` silently reused the tag that already existed rather than
making one at the code it was handed.

It cost nothing while nothing read the tag: `/releases/latest` returns
`tag_name`, the app compares it to its own version, and neither asks what commit
it points at. **An update panel that renders "what changed" from
`compare/<old tag>...<new tag>` changes that.** A tag naming the wrong commit
becomes a changelog telling every user they are 155 commits and 26,000 lines
behind code they are already running.

Hence `--target <sha>` and the preflight. Two rules behind them:

- **Tag at build time, never before.** A tag created at "version bump" o'clock
  names whatever main was then, and main moves.
- **Never reuse an existing tag for a new build.** Delete and recreate it at the
  built commit, or bump the version. `gh release create` will not warn you.

**The ordering mistake that matters:** publishing a release with no artifacts
attached. Every user is told a version is available and then sent to a page with
nothing on it. A DRAFT release is safe — `/releases/latest` skips drafts, and
`parseFeed()` refuses one a second time — so build the draft, attach, verify the
download, then publish.

## Platforms

Only Windows has ever been built. The `mac` and `linux` targets in
`package.json` are configured and unverified:

- **macOS** artifacts require macOS. Nothing about the config has been tested.
- **Linux** AppImage builds from a non-Linux host require Docker, which is not
  installed on the build machine.

Neither should be offered on the download page until one has actually been
built and launched.

## Signing

There is no code-signing certificate, so Windows SmartScreen warns on first
run. The README and the CHANGELOG both say so. Adding one is `win.certificateFile`
plus `CSC_KEY_PASSWORD` in the environment; nothing else in the build changes.
