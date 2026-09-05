/**
 * What an update contains, shown before anyone agrees to it.
 *
 * THIS IS THE ONE SCREEN IN THE APP THAT APPEARS UNASKED-FOR, and everything
 * about it answers for that. It is the visible half of a promise the rest of
 * the app makes quietly: the machine is the user's, so a change to what runs on
 * it is theirs to accept, refuse, or stop being asked about — three answers,
 * all equally reachable, none of them buried.
 *
 * So the three buttons carry the same weight. No primary styling on "Get the
 * update", nothing that makes refusing look like the mistake, and no default
 * that fires if someone presses Enter without reading. A dialog that shouts one
 * answer is asking a question it has already decided.
 *
 * ESCAPE AND THE BACKDROP MEAN "NOT NOW", NEVER "NEVER". Dismissing must not be
 * able to silently switch off future notifications: turning them off is a
 * decision, and a decision needs a button pressed on purpose.
 *
 * The changelog is here for the same reason the buttons are level. "A new
 * version is available" asks someone to consent to something they cannot see; a
 * file list with line counts is the smallest honest description of what would
 * change, and it comes from the repository rather than from anything we wrote
 * about ourselves.
 *
 * Same <dialog> + showModal() as SettingsDialog — see the note there. The
 * renderer has no node integration, so the top layer and the focus trap are the
 * platform's job, not ours.
 */
import { useEffect, useRef } from 'react'
import type { Changelog } from '../../../shared/changelog.js'
import type { UpdateProgress } from '../../../shared/update.js'

type Props = {
  /** The version running now. */
  current: string
  /** The version on offer. */
  latest: string
  /** The release page. Never an installer — installing stays the person's act. */
  url: string
  /**
   * What changed, or null when it could not be described: offline, rate
   * limited, comparison too large, a tag naming no commit. The offer still
   * stands in that case and the dialog says so, because failing to show a
   * changelog must never quietly withdraw the update.
   */
  changes: Changelog | null
  /**
   * Every version newer than the one running, newest first. One entry is an
   * ordinary update; more than one means releases were missed, and saying so is
   * the difference between "a small update" and "three releases of changes",
   * which the changelog alone cannot convey.
   */
  versions: string[]
  /** Still fetching the comparison. Distinct from `changes === null`. */
  loading: boolean
  /** Download running. The dialog stays up and the three answers go away. */
  installing: boolean
  /** How far the download has got, or null before the first block lands. */
  progress: UpdateProgress | null
  /**
   * Why the install failed, or null. Shown WITH the release page still on
   * offer: a failed download must leave a person better off than not trying,
   * and the manual route is what it falls back to.
   */
  error: string | null
  onGet: () => void
  onLater: () => void
  onNever: () => void
}

/**
 * "1 changes across 3 files" shipped in 1.0.1 and 1.0.2. It is a small thing
 * and it is the first sentence of a panel whose whole claim is that what it
 * lists can be trusted, which is a bad place to look careless.
 */
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`)

/** Bytes as MB, one decimal. The numbers here are megabytes or they are wrong. */
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** Enough to see the shape of a release without becoming a scrollable wall. */
const FILES_SHOWN = 12
const COMMITS_SHOWN = 8

export function UpdateDialog({
  current,
  latest,
  url,
  changes,
  versions,
  loading,
  installing,
  progress,
  error,
  onGet,
  onLater,
  onNever,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const downOnBackdrop = useRef(false)

  useEffect(() => {
    const el = dialogRef.current
    el?.showModal()
    return () => el?.close()
  }, [])

  // Biggest first: a release's character is in its largest files, and the list
  // is capped, so the twelve shown should be the twelve worth seeing.
  const files = changes
    ? [...changes.files].sort((a, b) => b.added + b.removed - (a.added + a.removed))
    : []
  const more = changes ? changes.commits.length - COMMITS_SHOWN : 0

  return (
    <dialog
      className="settings-overlay"
      ref={dialogRef}
      aria-labelledby="update-title"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onMouseUp={(e) => {
        if (installing) return
        if (downOnBackdrop.current && e.target === e.currentTarget) onLater()
      }}
      onCancel={(e) => {
        // Always prevented: Escape must never reach the platform's own close,
        // which would take the dialog away without telling anyone.
        e.preventDefault()
        // Mid-download there is nothing to dismiss TO. The bytes keep arriving
        // either way, and a hidden download that restarts the app unannounced
        // is the one outcome worse than no updater at all.
        if (!installing) onLater()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <div className="settings-dialog">
        {/* First line in the box, before the offer itself. It is the frame the
            rest is read in, so it cannot be a footnote under the buttons. */}
        <p className="update-sovereignty">Your device, your choice on what happens to your app.</p>

        <h2 className="settings-title" id="update-title">
          Version {latest} is available
        </h2>
        <p className="settings-hint">
          You are running {current}. Nothing has been downloaded, and nothing will be
          installed unless you choose it.
        </p>

        {/* Only when versions were actually MISSED. At one release ahead this
            says nothing the heading has not already said, and a line that
            restates the heading trains people to skip the line. */}
        {versions.length > 1 && (
          <p className="update-skipped">
            {versions.length} releases since yours: {versions.join(', ')}. Everything
            below covers all of them.
          </p>
        )}

        {loading ? (
          <p className="settings-hint">Reading what changed…</p>
        ) : changes ? (
          <div className="update-changes">
            <p className="update-totals">
              <strong>{changes.commits.length}</strong>
              {changes.truncated ? '+' : ''} {plural(changes.commits.length, 'change')} across{' '}
              <strong>{changes.files.length}</strong>
              {changes.truncated ? '+' : ''} {plural(changes.files.length, 'file')}{' — '}
              <span className="update-added">+{changes.added.toLocaleString()}</span>{' '}
              <span className="update-removed">−{changes.removed.toLocaleString()}</span> lines
            </p>

            <p className="update-label">What changed</p>
            <ul className="update-commits">
              {changes.commits.slice(0, COMMITS_SHOWN).map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
            {more > 0 && (
              <p className="settings-hint">
                …and {more} more
                {changes.truncated ? ', with the comparison too long to list in full' : ''}.
              </p>
            )}

            <p className="update-label">Where</p>
            <ul className="update-files">
              {files.slice(0, FILES_SHOWN).map((f) => (
                <li key={f.path}>
                  <span className="update-path">{f.path}</span>
                  <span className="update-added">+{f.added}</span>
                  <span className="update-removed">−{f.removed}</span>
                </li>
              ))}
            </ul>
            {files.length > FILES_SHOWN && (
              <p className="settings-hint">…and {files.length - FILES_SHOWN} more files.</p>
            )}
          </div>
        ) : (
          <p className="settings-hint">
            The list of changes could not be fetched, so this is the version number and
            nothing more. The update is still there if you want it.
          </p>
        )}

        {/* A FAILED INSTALL MUST NOT LEAVE SOMEONE WORSE OFF than never having
            pressed the button, so the error arrives with the manual route
            attached rather than as a dead end. */}
        {error && (
          <p className="update-error" role="alert">
            {error}{' '}
            <a href={url} target="_blank" rel="noreferrer noopener">
              Open the download page
            </a>
            .
          </p>
        )}

        {installing ? (
          /* The three answers are gone on purpose: the question has been
             answered and there is nothing to decide while bytes are moving. */
          <div className="update-progress">
            <progress value={progress ? progress.percent : undefined} max={100} />
            <p className="settings-hint">
              {progress
                ? `${Math.round(progress.percent)}% — ${mb(progress.transferred)} of ${mb(
                    progress.total,
                  )}. `
                : 'Working out what actually changed. '}
              Only the parts that differ from the version you have are downloaded, so
              this is far smaller than the whole app. Fate will close and reopen on
              {' '}
              {latest} when it finishes.
            </p>
          </div>
        ) : (
          <>
            <div className="settings-actions update-actions">
              {/* A BUTTON, NOT A LINK, and that is the whole fix. This used to
                  be an <a> to the release page: it worked exactly as written
                  and was still read as broken, because "it opened a browser at
                  a 100 MB installer" is not what "get the update" promises.
                  It now downloads, verifies and restarts. */}
              <button className="settings-close" onClick={onGet}>
                {error ? 'Try again' : 'Get the update'}
              </button>
              <button className="settings-close" onClick={onLater}>
                Not now
              </button>
              <button className="settings-close" onClick={onNever}>
                Don&apos;t notify me about updates
              </button>
            </div>

            <p className="settings-hint">
              Turning notifications off does not remove the check — Settings → About still
              has the button, whenever you want to ask.
            </p>
          </>
        )}
      </div>
    </dialog>
  )
}
