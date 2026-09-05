/**
 * THE ONLY OUTBOUND REQUEST THIS APP MAKES ON ITS OWN BEHALF.
 *
 * The agent panel talks to Anthropic through the SDK, and that is the user
 * asking it to. Everything else in this app is local. This file is the one
 * exception and it is kept deliberately small and deliberately manual:
 *
 *   - It runs when the app opens, and when a person clicks "Check for
 *     updates". No timer, no telemetry, and no second request after the first.
 *
 *     THE LAUNCH CHECK IS NEW, AND IT REPLACED A FLAT PROMISE THAT THERE WOULD
 *     NEVER BE ONE. That promise was worth something and it is worth saying what
 *     bought it out: a user who is never told about a fix cannot choose to take
 *     it, and "we never contacted the server" is poor comfort to someone running
 *     a version with a bug we fixed months ago. So the check happens, and the
 *     control moved rather than disappearing. `notifyUpdates` in settings.json
 *     gates it, the panel it raises can switch it off for good, and settings are
 *     read BEFORE the request — declining means the request is never made, not
 *     that its answer is discarded. Absent means true, so only a refusal is ever
 *     written and an untouched install keeps no key at all.
 *   - It sends nothing. A GET for a static JSON file, no query string, no
 *     identifier, no version header. The server learns an IP fetched a public
 *     file, which is what any download would tell it anyway.
 *   - IT USED TO DOWNLOAD NOTHING EXECUTABLE. It does now, and only when a
 *     person presses the button in the update panel: see `install()` at the
 *     bottom of this file for what was traded and what was kept. The CHECK is
 *     still a bare GET that sends nothing, and it is still the only thing that
 *     happens without being asked for.
 *
 * All the judgement lives in src/shared/update.ts, which is pure and tested.
 * This file is transport and nothing else.
 */
import { BrowserWindow, app } from 'electron'
import { get } from 'node:https'
import { UPDATE_FEED, decide, isVersion, type UpdateCheck } from '../shared/update.js'
import {
  RELEASES_FEED,
  compareUrl,
  parseCompare,
  parseReleases,
  type Changelog,
} from '../shared/changelog.js'
import { CH, EV } from '../shared/ipc.js'
import type { Handle } from './ipc.js'

/** Past this, give up and say so. Long enough for a slow link, short enough
 *  that a person who clicked a button is not left watching a spinner. */
const TIMEOUT_MS = 6000

/** A version feed is a few hundred bytes. Anything beyond this is not one, and
 *  reading it into memory is how a hostile or misconfigured host wins. */
const MAX_BYTES = 64 * 1024

/**
 * A comparison is not a few hundred bytes, because GitHub returns the full
 * patch text of every changed file and there is no way to ask it not to.
 * Measured against this repository: a nine-commit delta is 311 KB, and 155
 * commits across 233 files is 1.9 MB. Under the feed's 64 KB the check would
 * not error — `fetchJson` fails closed — it would report "no changes" forever.
 *
 * 4 MB is a ceiling, not a target: past it the panel offers the update without
 * a changelog rather than holding the whole thing in memory to describe it.
 */
const MAX_COMPARE_BYTES = 4 * 1024 * 1024

/**
 * Fetch a body, or null.
 *
 * Every failure returns null rather than throwing: offline, DNS, TLS, a 404
 * because the feed has not been published yet, a redirect (deliberately NOT
 * followed — a feed that moves is an edit to UPDATE_FEED, not a chain this
 * code walks), or a body that will not stop arriving.
 *
 * DO NOT DROP THE JSON.parse GUARD ON THE GROUNDS THAT THE STATUS CODE COVERS
 * IT. The feed pointed at the product site before it pointed at GitHub, and
 * there a missing file did not 404: the site is a single-page app behind a
 * catch-all, so an absent path returned `200 text/html` with the home page in
 * the body (measured 2026-09-01). The GitHub API does 404 properly, but the
 * whole point of UPDATE_FEED being one constant is that it can go back to a
 * static file, and the parse guard is what makes that safe.
 */
function fetchJson(url: string, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string | null) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }

    const req = get(
      url,
      {
        headers: {
          /**
           * THE API VERSION IS PINNED and the User-Agent is MANDATORY.
           *
           * GitHub rejects a request with no User-Agent outright — 403, not a
           * warning — so omitting it is not a style question, it is a check
           * that never works. The value names the app rather than imitating a
           * browser, because the whole design of this file is that the request
           * is honest about what it is.
           *
           * `X-GitHub-Api-Version` freezes the response shape. Without it the
           * feed is whatever GitHub's default happens to be on the day a user
           * clicks, which is a shape change arriving in a shipped binary.
           */
          'user-agent': 'Fate-Desktop',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          return done(null)
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.length > maxBytes) {
            req.destroy()
            done(null)
          }
        })
        res.on('end', () => done(body))
        res.on('error', () => done(null))
      },
    )

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      done(null)
    })
    req.on('error', () => done(null))
  })
}

/**
 * Answer "is there a newer version", for the running build.
 *
 * `app.getVersion()` is package.json's version in a packaged build and
 * Electron's own version when unpackaged, which is why an unrecognisable
 * version resolves to `unknown` rather than to an upgrade offer: a developer
 * running `npm run dev` must not be told to download the app.
 */
export async function check(): Promise<UpdateCheck> {
  const body = await fetchJson(UPDATE_FEED, MAX_BYTES)
  const version = app.getVersion()
  if (body === null) {
    return {
      state: 'unknown',
      version,
      reason: 'Could not reach the update feed. Check your connection and try again.',
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { state: 'unknown', version, reason: 'The update feed could not be read.' }
  }
  return decide(version, parsed)
}

/**
 * What changed between two released versions, or null if it cannot be said.
 *
 * BOTH REFS ARE VALIDATED BEFORE THEY REACH A URL. They arrive over IPC, and
 * `compareUrl` interpolates them into a path — an unchecked `../../` would walk
 * off the compare endpoint onto another part of the API. `isVersion` is already
 * the gate the feed's own tag goes through, so it is the gate these go through
 * too, and anything else is `null` rather than a request.
 *
 * Null is not an error the user should see. It means the update is still on
 * offer and the panel simply cannot describe it — offline, rate-limited,
 * comparison too large, a tag that names no commit. Failing to list what
 * changed must never withhold the update itself.
 */
export async function changes(base: string, head: string): Promise<Changelog | null> {
  if (!isVersion(base) || !isVersion(head)) return null
  /**
   * VERSIONS ARRIVE NORMALISED; THE COMPARE ENDPOINT WANTS REFS. `check()`
   * strips the leading `v` — `1.0.1`, not `v1.0.1` — because that is what a
   * person should read, and `compare/1.0.1...1.0.2` then 404s against tags
   * named `v1.0.1`. Failing closed, that is a changelog that is silently always
   * empty, which is worse than one that errors.
   *
   * docs/RELEASING.md permits both spellings, so both are tried, `v` first
   * because that is what has been cut. ponytail: a second request only on the
   * miss; if tag spelling ever settles, thread the feed's own `tag_name`
   * through `UpdateCheck` and delete this.
   */
  for (const prefix of ['v', '']) {
    const body = await fetchJson(
      compareUrl(`${prefix}${base}`, `${prefix}${head}`),
      MAX_COMPARE_BYTES,
    )
    if (body === null) continue
    try {
      return parseCompare(JSON.parse(body))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Which versions the running build has missed, newest first.
 *
 * Only ever called once an update is known to exist, so the third request of a
 * launch is paid for only by someone who is actually behind. Someone up to date
 * makes one request and stops.
 *
 * The list of releases carries release NOTES, so it is not a few hundred bytes
 * either; it gets the feed's cap times sixteen rather than a comparison's 4 MB,
 * because a hundred release bodies is a different order of thing from a hundred
 * file patches.
 */
export async function releases(current: string): Promise<string[]> {
  if (!isVersion(current)) return []
  const body = await fetchJson(RELEASES_FEED, MAX_BYTES * 16)
  if (body === null) return []
  try {
    return parseReleases(JSON.parse(body), current)
  } catch {
    return []
  }
}

/** The first line of an error, capped. See the catch in `install()`. */
function first(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim()
  const line = raw.split('\n', 1)[0] ?? raw
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/**
 * DOWNLOAD THE UPDATE AND RESTART INTO IT.
 *
 * This is the promise at the top of this file being partly bought out, and it
 * is worth saying exactly which part. "No timer, no telemetry" still holds.
 * "It downloads nothing executable" does not, and the reason is that the old
 * flow did not work: clicking the offer opened a release page, and the person
 * was left to find a 100 MB installer, run it, and reinstall the app over
 * itself — every time, for every release. Almost nobody does that twice, so the
 * effect of refusing to download was that fixes did not reach anyone.
 *
 * What is kept instead of the refusal:
 *   - NOTHING IS FETCHED UNTIL A BUTTON IS PRESSED. Not on launch, not in the
 *     background, not "while you were reading the changelog". `autoDownload`
 *     is off, and it is off explicitly rather than by default.
 *   - NOTHING INSTALLS ITSELF ON QUIT. `autoInstallOnAppQuit` is off too;
 *     abandoning a download must not leave an installer primed to run the next
 *     time the app closes.
 *   - THE DOWNLOAD IS A DIFF, NOT THE APP. electron-updater reads the
 *     `.blockmap` published beside the installer and fetches only the blocks
 *     that changed. The Electron runtime is ~350 MB of the install and is
 *     byte-identical between releases, so a code-only update moves a few MB.
 *     THIS IS WHY `publish` IS CONFIGURED IN package.json — without it
 *     electron-builder writes neither `latest.yml` nor the blockmap, and this
 *     whole path fails at the first request. See docs/RELEASING.md.
 *   - IT IS VERIFIED BEFORE IT RUNS. electron-updater checks the downloaded
 *     bytes against the sha512 in `latest.yml`, which is generated at build
 *     time and served from the same release. A truncated or substituted file
 *     never reaches the installer.
 *
 * UNPACKAGED BUILDS REFUSE RATHER THAN TRY. `app.getVersion()` is Electron's
 * own version under `npm run dev`, so a developer is offered nothing to install
 * and this says so instead of throwing an internal error at them.
 */
export async function install(): Promise<string | null> {
  if (!app.isPackaged) {
    return 'This is a development build, so there is nothing to install into. Updates work in the packaged app.'
  }

  /**
   * IMPORTED HERE, NOT AT THE TOP, for two reasons that both bite silently.
   *
   * electron-updater is CommonJS whose exports are defined with getters, so
   * Node's ESM loader cannot see a named `autoUpdater` binding — a static
   * `import { autoUpdater }` throws at parse time, which the test suite catches
   * because it loads these modules directly. The default import is the whole
   * module object and destructures fine.
   *
   * And it reaches for `electron` as it initialises, so importing it at module
   * scope would drag the updater into every test that touches main/ipc.ts.
   * Nothing here runs until someone presses the button, so nothing needs to be
   * loaded until then either.
   */
  const { autoUpdater } = (await import('electron-updater')).default

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // Progress is the whole reason the dialog stays up. Registered per call and
  // removed after, because a listener that outlives its dialog pushes into a
  // component that is no longer mounted.
  const onProgress = (p: {
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EV.updateProgress, p)
    }
  }
  autoUpdater.on('download-progress', onProgress)

  try {
    const found = await autoUpdater.checkForUpdates()
    if (!found?.updateInfo) {
      return 'The update could not be found on the release page. Try the download page instead.'
    }
    await autoUpdater.downloadUpdate()
    /**
     * SILENT, AND RELAUNCH. The person already agreed in the dialog; making
     * them click through an installer wizard is asking the same question twice.
     * The second argument is what turns "the app vanished" into "the app came
     * back on the new version", which is the behaviour being asked for.
     *
     * This does not return — the app quits inside it.
     */
    autoUpdater.quitAndInstall(true, true)
    return null
  } catch (e) {
    // Offline, rate-limited, a release with no `latest.yml`, a checksum that
    // did not match. All of them mean the same thing to the person in front of
    // it: this did not work, the download page still does.
    //
    // THE MESSAGE IS TRIMMED, and that is not tidying. electron-updater's
    // errors carry the failing URL, the HTTP status and a re-quoted request
    // block across several lines — 250-odd characters of which the first
    // sentence is the only part anyone can act on. Rendered whole it turns the
    // panel into a stack trace at the exact moment someone needs to be told,
    // briefly, what to do next.
    return `The update could not be installed: ${first(e)}`
  } finally {
    autoUpdater.removeListener('download-progress', onProgress)
  }
}

export function register(handle: Handle): void {
  handle(CH.updateCheck, () => check())
  handle(CH.updateReleases, (current: string) => releases(current))
  handle(CH.updateChanges, (base: string, head: string) => changes(base, head))
  handle(CH.updateInstall, () => install())
}
