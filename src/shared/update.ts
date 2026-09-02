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
 * WHERE THE ANSWER COMES FROM, and why that changed. This first pointed at a
 * static JSON file on the product site, because the GitHub releases API returns
 * 404 to an anonymous caller for a PRIVATE repository and the only way past
 * that is a token shipped inside the app — a credential handed to everyone who
 * downloads it. The repository went public on 2026-09-01, so the releases API
 * is now readable by anyone and is the better feed: it is written by the act of
 * publishing a release, so it cannot be forgotten the way a hand-edited file
 * can.
 *
 * Both shapes are still understood — see parseFeed. That is not
 * future-proofing for its own sake; it is what makes UPDATE_FEED a single line
 * to repoint if the repository ever goes private again.
 *
 * Everything here is pure. The one function that touches the network lives in
 * src/main/update.ts and calls into this to decide what the bytes meant.
 */

/**
 * Where the answer comes from. One constant, deliberately: repointing the feed
 * at a static file, an S3 object or a different repository is an edit here and
 * nowhere else.
 *
 * GitHub's own endpoint. It answers with the newest NON-draft, NON-prerelease
 * release, so cutting a release is what publishes the version — there is no
 * second file to remember to update, which is the failure mode a hand-written
 * feed has.
 *
 * Anonymous, which is the whole reason it is usable: no token, and therefore no
 * credential inside a shipped app. It is rate-limited to 60 requests an hour per
 * IP, which is irrelevant to a check that only fires when someone clicks a
 * button.
 */
export const UPDATE_FEED =
  'https://api.github.com/repos/Nathan5674312/agent-workspace/releases/latest'

/** Where a person is sent when there IS something newer. */
export const DOWNLOAD_PAGE =
  'https://github.com/Nathan5674312/agent-workspace/releases/latest'

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
 * TWO SHAPES, one function. A GitHub release object names its version
 * `tag_name` and its page `html_url`; a hand-written feed file names them
 * `version` and `url`. Understanding both is what makes UPDATE_FEED a single
 * line to repoint — if the repository goes private again, a static file on the
 * product site takes over with no other change.
 *
 * Takes the already-parsed value rather than the text, so the JSON.parse and
 * its failure belong to the caller. Everything is checked: this is data pulled
 * off the public internet and the renderer will render it.
 */
export function parseFeed(raw: unknown): { version: string; url: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>

  /**
   * A draft or a prerelease is never an update. /releases/latest already
   * excludes both, so this is belt and braces — but the cost of being wrong is
   * offering every user an unfinished build, and the check is two lines.
   */
  if (rec.draft === true || rec.prerelease === true) return null

  const rawVersion =
    typeof rec.version === 'string'
      ? rec.version
      : typeof rec.tag_name === 'string'
        ? rec.tag_name
        : ''
  const version = normalise(rawVersion)
  if (!isVersion(version)) return null

  // A feed-supplied URL reaches shell.openExternal, so it is held to the same
  // rule as everything else that does: http(s) only, parsed rather than matched.
  let url = DOWNLOAD_PAGE
  const rawUrl =
    typeof rec.url === 'string'
      ? rec.url
      : typeof rec.html_url === 'string'
        ? rec.html_url
        : ''
  if (rawUrl !== '') {
    try {
      const { protocol } = new URL(rawUrl)
      if (protocol === 'http:' || protocol === 'https:') url = rawUrl
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
