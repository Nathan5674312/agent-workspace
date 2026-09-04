/**
 * THE ONLY OUTBOUND REQUEST THIS APP MAKES ON ITS OWN BEHALF.
 *
 * The agent panel talks to Anthropic through the SDK, and that is the user
 * asking it to. Everything else in this app is local. This file is the one
 * exception and it is kept deliberately small and deliberately manual:
 *
 *   - It runs ONLY when a person clicks "Check for updates". No timer, no
 *     check on launch, no telemetry. A local-first notes app that phones home
 *     on boot is a different promise than the one the README makes.
 *   - It sends nothing. A GET for a static JSON file, no query string, no
 *     identifier, no version header. The server learns an IP fetched a public
 *     file, which is what any download would tell it anyway.
 *   - It downloads nothing executable. The answer is a version string and a
 *     page URL; installing is the person opening that page.
 *
 * All the judgement lives in src/shared/update.ts, which is pure and tested.
 * This file is transport and nothing else.
 */
import { app } from 'electron'
import { get } from 'node:https'
import { UPDATE_FEED, decide, isVersion, type UpdateCheck } from '../shared/update.js'
import { compareUrl, parseCompare, type Changelog } from '../shared/changelog.js'
import { CH } from '../shared/ipc.js'
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

export function register(handle: Handle): void {
  handle(CH.updateCheck, () => check())
  handle(CH.updateChanges, (base: string, head: string) => changes(base, head))
}
