# Releasing

How a version reaches the people running the last one. Short, because the whole
mechanism is a static JSON file and a button.

## The update channel

There isn't an auto-updater, and that is a decision rather than a gap.

- **In the app:** Settings → About → *Check for updates*. It fetches
  `https://www.divineconstruc.com/updates/fate.json`, compares the version to
  the running build, and either says you are current or offers a link. It sends
  nothing, downloads nothing executable, and runs only when the button is
  pressed — no check on launch, no timer. See the header of
  `src/main/update.ts`.
- **Not electron-updater.** It would need a publish target, and the obvious one
  is out: `api.github.com/repos/Nathan5674312/agent-workspace/releases/latest`
  returns **404 to an anonymous caller** because the repository is private.
  Measured, not assumed. The only way past that is a token inside the app,
  which is a credential handed to everyone who downloads it.
- **`publish` is `null`** in `package.json` for the same reason: nothing is
  auto-uploaded anywhere. Artifacts are put on the site by hand.

Repointing the feed is one constant, `UPDATE_FEED` in `src/shared/update.ts`.
If the repository ever goes public, that line becomes the GitHub releases API
and nothing else changes.

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
6. **Update the feed LAST**, once the files are actually downloadable. It is
   two keys:
   ```json
   { "version": "1.0.1", "url": "https://www.divineconstruc.com/" }
   ```
   `url` is optional and falls back to the site root. Anything that is not
   `http:` or `https:` is ignored and the fallback used instead — that value
   reaches `shell.openExternal`, so it is held to the same rule as every other
   URL in the app.

Updating the feed before the download exists is the one ordering mistake that
matters: it tells every user a version is available and then sends them to a
404.

> **The feed does not 404 when it is missing.** The site is a single-page app
> behind a catch-all, so `GET /updates/fate.json` with no such file returns
> `200 text/html` and the home page. Verified 2026-09-01. The app copes — the
> body fails to parse and it reports that it could not read the feed — but it
> means "the request succeeded" is not evidence the file is there. Check the
> content type, or just read the body.

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
