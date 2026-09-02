/**
 * "Is there a newer version than the one I am running?"
 *
 * THE GAP THIS CLOSES: 1.0.0 shipped as a zip and an installer with no way to
 * tell anyone that 1.0.1 exists. A user who installed it would never find out,
 * which makes every fix after release unreachable to the people who need it.
 *
 * WHAT THIS IS NOT. It does not download, it does not install, and it does not
 * run on a timer. It answers a question a person asked by clicking, and the
 * answer is a version number and a link they can choose to follow. Silent
 * background updating of a local-first notes app is a different product
 * decision with its own consent question, and it is not made here.
 *
 * WHY A STATIC FILE AND NOT THE GITHUB API. The obvious feed is
 * api.github.com/repos/<owner>/<repo>/releases/latest, and it returns 404 to an
 * anonymous caller because the repository is private — measured, not assumed.
 * The only fix would be shipping a token inside the app, which is a credential
 * handed to everyone who downloads it. A JSON file on the site the app already
 * belongs to costs nothing, needs no auth, and is repointable by editing one
 * constant.
 *
 * Everything here is pure. The one function that touches the network lives in
 * src/main/update.ts and calls into this to decide what the bytes meant.
 */

/**
 * Where the answer comes from. One constant, deliberately: repointing the feed
 * at a GitHub release, an S3 object or a different domain is an edit here and
 * nowhere else.
 *
 * The file it names is small and hand-written:
 *
 *   { "version": "1.0.1", "url": "https://www.divineconstruc.com/download" }
 *
 * `url` is optional and falls back to DOWNLOAD_PAGE.
 */
export const UPDATE_FEED = 'https://www.divineconstruc.com/updates/fate.json'

/** Where a person is sent when there IS something newer. */
export const DOWNLOAD_PAGE = 'https://www.divineconstruc.com/'

/**
 * A version this module is willing to compare.
 *
 * Deliberately narrow. Anything else is `unknown` rather than guessed at,
 * because the failure mode of a loose parser here is telling someone they are
 * out of date when they are not.
 */
const VERSION = /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$/

export type UpdateCheck =
  /** Nothing newer. `version` is what is running. */
  | { state: 'current'; version: string }
  /** Something newer exists. `url` is a page, never an installer. */
  | { state: 'available'; version: string; latest: string; url: string }
  /**
   * The question could not be answered. Offline, feed missing, feed malformed.
   * `reason` is shown to the person, so it says what happened rather than
   * naming an exception class.
   */
  | { state: 'unknown'; version: string; reason: string }

/** Strip one leading `v`, the way a git tag carries it and a version does not. */
export function normalise(raw: string): string {
  return raw.trim().replace(/^[vV]/, '')
}

export function isVersion(raw: string): boolean {
  return VERSION.test(normalise(raw))
}

/**
 * Semver-ish ordering: -1, 0 or 1, by the same rule npm uses for the parts this
 * app actually ships.
 *
 * Missing components count as zero, so `1.0` and `1.0.0` are the same version
 * rather than one being older — electron-builder writes two-part versions in
 * some feeds and a user should not be told to upgrade to what they have.
 *
 * A PRERELEASE SUFFIX SORTS BEFORE THE RELEASE IT PRECEDES: `1.0.0-beta.2` is
 * older than `1.0.0`. Getting this backwards would offer everyone on a stable
 * build a downgrade to a beta, which is the one outcome an update prompt must
 * never produce.
 */
export function compareVersions(a: string, b: string): number {
  const [aMain = '', aPre = ''] = normalise(a).split('-', 2)
  const [bMain = '', bPre = ''] = normalise(b).split('-', 2)

  const an = aMain.split('.').map(Number)
  const bn = bMain.split('.').map(Number)
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }

  if (aPre === bPre) return 0
  // Exactly one has a prerelease suffix: the one that does is older.
  if (aPre === '') return 1
  if (bPre === '') return -1
  return aPre < bPre ? -1 : 1
}

/**
 * What the feed said, or null if it did not say anything usable.
 *
 * Takes the already-parsed value rather than the text, so the JSON.parse and
 * its failure belong to the caller. Everything is checked: this is data pulled
 * off the public internet and the renderer will render it.
 */
export function parseFeed(raw: unknown): { version: string; url: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const version = typeof rec.version === 'string' ? normalise(rec.version) : ''
  if (!isVersion(version)) return null

  // A feed-supplied URL reaches shell.openExternal, so it is held to the same
  // rule as everything else that does: http(s) only, parsed rather than matched.
  let url = DOWNLOAD_PAGE
  if (typeof rec.url === 'string') {
    try {
      const { protocol } = new URL(rec.url)
      if (protocol === 'http:' || protocol === 'https:') url = rec.url
    } catch {
      /* keep the default */
    }
  }
  return { version, url }
}

/** The whole decision, given the running version and whatever the feed held. */
export function decide(current: string, feed: unknown): UpdateCheck {
  const version = normalise(current)
  const parsed = parseFeed(feed)
  if (!parsed) {
    return { state: 'unknown', version, reason: 'The update feed could not be read.' }
  }
  if (!isVersion(version)) {
    return { state: 'unknown', version, reason: 'This build has no readable version number.' }
  }
  return compareVersions(parsed.version, version) > 0
    ? { state: 'available', version, latest: parsed.version, url: parsed.url }
    : { state: 'current', version }
}
