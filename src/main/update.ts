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
import { UPDATE_FEED, decide, type UpdateCheck } from '../shared/update.js'
import { CH } from '../shared/ipc.js'
import type { Handle } from './ipc.js'

/** Past this, give up and say so. Long enough for a slow link, short enough
 *  that a person who clicked a button is not left watching a spinner. */
const TIMEOUT_MS = 6000

/** A version feed is a few hundred bytes. Anything beyond this is not one, and
 *  reading it into memory is how a hostile or misconfigured host wins. */
const MAX_BYTES = 64 * 1024

/**
 * Fetch the feed body, or null.
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
function fetchFeed(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string | null) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }

    const req = get(
      UPDATE_FEED,
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
          if (body.length > MAX_BYTES) {
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
  const body = await fetchFeed()
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

export function register(handle: Handle): void {
  handle(CH.updateCheck, () => check())
}
