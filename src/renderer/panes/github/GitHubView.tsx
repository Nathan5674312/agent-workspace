/**
 * The GitHub surface: what agents are pushing, per repo.
 *
 * Everything here arrives over `window.api.github`; the token never reaches the
 * renderer. The repo view polls every 60 s while this surface is mounted AND
 * the window is visible, and stops otherwise. Logic lives in shared/github.ts.
 */
import { useCallback, useEffect, useState } from 'react'
import type { GitHubSignIn, GitHubStatus } from '../../../shared/ipc.js'
import { isAgentBranch, type Commit, type FileChange, type PullRequest, type Repo, type RepoActivity } from '../../../shared/github.js'
import './github.css'

const POLL_MS = 60_000

const message = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const ago = (at: number | null): string => {
  if (at === null) return '—'
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function GitHubView() {
  const [status, setStatus] = useState<GitHubStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.github.status().then(setStatus, (e) => setError(message(e)))
  }, [])

  if (!status) return <div className="gh-view gh-note">{error ?? 'Loading…'}</div>
  if (!status.clientIdSet) return <Setup onDone={setStatus} />
  if (!status.signedIn) return <SignIn onDone={setStatus} />
  return <Signed status={status} onSignedOut={setStatus} />
}

function Setup({ onDone }: { onDone: (s: GitHubStatus) => void }) {
  const [id, setId] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="gh-view gh-setup">
      <h2 className="gh-title">Connect GitHub</h2>
      <p className="gh-note">Fate signs in through your browser with a GitHub OAuth App you own. One-time setup:</p>
      <ol className="gh-steps">
        <li>
          Open <strong>github.com/settings/developers</strong> and choose <strong>New OAuth App</strong>. Any
          name; homepage and callback URL can both be <code>http://localhost</code>.
        </li>
        <li>
          Tick <strong>Enable Device Flow</strong>, then register the app.
        </li>
        <li>Copy its <strong>Client ID</strong> (not a secret) and paste it here.</li>
      </ol>
      <form
        className="gh-row"
        onSubmit={(e) => {
          e.preventDefault()
          window.api.github.setClientId(id).then(onDone, (err) => setError(message(err)))
        }}
      >
        <input
          className="gh-input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="Client ID"
          aria-label="GitHub OAuth App Client ID"
          spellCheck={false}
        />
        <button className="gh-btn" type="submit" disabled={id.trim() === ''}>
          Save
        </button>
      </form>
      {error && <p className="gh-error">{error}</p>}
    </div>
  )
}

function SignIn({ onDone }: { onDone: (s: GitHubStatus) => void }) {
  const [code, setCode] = useState<GitHubSignIn | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setError(null)
    try {
      setCode(await window.api.github.signIn())
      onDone(await window.api.github.finishSignIn())
    } catch (e) {
      setError(message(e))
      setCode(null)
    }
  }

  return (
    <div className="gh-view gh-setup">
      <h2 className="gh-title">Sign in to GitHub</h2>
      {code ? (
        <>
          <p className="gh-note">Your browser opened {code.verificationUri}. Enter this code there:</p>
          <p className="gh-code" aria-label="Device code">
            {code.userCode}
          </p>
          <p className="gh-note">Waiting for GitHub…</p>
        </>
      ) : (
        <p className="gh-note">
          Opens your browser. Asks for scope <code>repo</code>, GitHub's only scope that can see private repos. It
          grants write access too; Fate only reads.
        </p>
      )}
      <div className="gh-row">
        {!code && (
          <button className="gh-btn" onClick={() => void start()}>
            Sign in with GitHub
          </button>
        )}
        <button
          className="gh-btn gh-btn--quiet"
          onClick={() => {
            // Sign-out also cancels a pending flow; clearing the client id lets it be re-entered.
            void window.api.github.signOut()
            void window.api.github.setClientId('').then(onDone)
          }}
        >
          Change Client ID
        </button>
      </div>
      {error && <p className="gh-error">{error}</p>}
    </div>
  )
}

function Signed({ status, onSignedOut }: { status: GitHubStatus; onSignedOut: (s: GitHubStatus) => void }) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Repo | null>(null)

  useEffect(() => {
    window.api.github.repos().then(setRepos, (e) => setError(message(e)))
  }, [])

  return (
    <div className="gh-view gh-signed">
      <div className="gh-header">
        <span className="gh-note">Signed in{status.login ? ` as ${status.login}` : ''}</span>
        <button
          className="gh-btn gh-btn--quiet"
          onClick={() => void window.api.github.signOut().then(onSignedOut)}
        >
          Sign out
        </button>
      </div>
      <div className="gh-columns">
        <ul className="gh-repos" aria-label="Repositories">
          {error && <li className="gh-error">{error}</li>}
          {!repos && !error && <li className="gh-note">Loading…</li>}
          {repos?.map((r) => (
            <li key={`${r.owner}/${r.name}`}>
              <button
                className={`gh-repo ${picked === r ? 'gh-repo--on' : ''}`}
                aria-pressed={picked === r}
                onClick={() => setPicked(r)}
              >
                <span className="gh-repo-name">
                  {r.name}
                  {r.private && <span className="gh-badge">private</span>}
                </span>
                <span className="gh-meta">pushed {ago(r.pushedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="gh-detail">
          {picked ? (
            <RepoDetail key={`${picked.owner}/${picked.name}`} repo={picked} />
          ) : (
            <p className="gh-note">Pick a repository.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function RepoDetail({ repo }: { repo: Repo }) {
  const [data, setData] = useState<RepoActivity | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)

  const load = useCallback(() => {
    window.api.github.activity(repo.owner, repo.name, repo.defaultBranch).then(
      (d) => {
        setData(d)
        setError(null)
        setAt(Date.now())
      },
      (e) => setError(message(e)),
    )
  }, [repo])

  useEffect(() => {
    load()
    let timer: ReturnType<typeof setInterval> | null = null
    const sync = () => {
      if (document.visibilityState === 'visible' && timer === null) {
        timer = setInterval(load, POLL_MS)
      } else if (document.visibilityState !== 'visible' && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      if (timer !== null) clearInterval(timer)
    }
  }, [load])

  return (
    <section className="gh-repo-detail">
      <div className="gh-header">
        <h2 className="gh-title">
          {repo.owner}/{repo.name}
          {data?.activeNow && <span className="gh-badge gh-badge--live">agent active now</span>}
        </h2>
        <span className="gh-meta">{at ? `updated ${ago(at)}` : 'loading…'}</span>
      </div>
      {error && <p className="gh-error">{error}</p>}
      {data && (
        <>
          <div className="gh-stats">
            <Stat n={data.pending} label="pending commits" strong />
            <Stat n={data.landed24h} label="landed, 24 h" />
            <Stat n={data.landed7d} label={`landed, 7 d on ${repo.defaultBranch}`} />
          </div>

          {data.runs.length > 0 && (
            <>
              <h3 className="gh-subtitle">Actions running</h3>
              <ul className="gh-list">
                {data.runs.map((r) => (
                  <li key={r.url} className="gh-item">
                    <button className="gh-link" onClick={() => void window.api.github.open(r.url)}>
                      {r.name}
                    </button>
                    <span className="gh-meta">
                      {r.branch} · started {ago(r.startedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="gh-subtitle">Pending — branches ahead of {repo.defaultBranch}</h3>
          {data.branches.length === 0 ? (
            <p className="gh-note">Nothing pending.</p>
          ) : (
            <ul className="gh-list">
              {data.branches.map((b) => (
                <li key={b.name} className="gh-item">
                  <span className="gh-item-main">
                    {b.name}
                    {b.agent && <span className="gh-badge">agent</span>}
                  </span>
                  <span className="gh-meta">
                    {b.ahead} ahead · {b.behind} behind · last commit {ago(b.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {data.skippedBranches > 0 && (
            <p className="gh-note">{data.skippedBranches} more branches not compared.</p>
          )}

          {data.pulls.length > 0 && (
            <>
              <h3 className="gh-subtitle">Open pull requests</h3>
              <ul className="gh-list">
                {data.pulls.map((p) => (
                  <PullRow key={p.number} repo={repo} pull={p} onMerged={load} />
                ))}
              </ul>
            </>
          )}

          <h3 className="gh-subtitle">Landed on {repo.defaultBranch}, last 7 days</h3>
          {data.landed.length === 0 ? (
            <p className="gh-note">No commits in the last 7 days.</p>
          ) : (
            <ul className="gh-list">
              {data.landed.map((c) => (
                <CommitRow key={c.sha} repo={repo} commit={c} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function Stat({ n, label, strong }: { n: number; label: string; strong?: boolean }) {
  return (
    <div className={`gh-stat ${strong ? 'gh-stat--strong' : ''}`}>
      <span className="gh-stat-n">{n}</span>
      <span className="gh-meta">{label}</span>
    </div>
  )
}

/**
 * One open pull request: what it changes, and a merge that needs two clicks.
 *
 * Merge stays disabled until the file list has loaded, so it cannot be merged
 * unseen, and it is pinned to the head commit this poll saw (mergePull). The
 * click is the user's own action, so there is no consent prompt; the second
 * click is the guard against a slip.
 */
function PullRow({ repo, pull, onMerged }: { repo: Repo; pull: PullRequest; onMerged: () => void }) {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)

  const toggle = () => {
    setOpen(!open)
    if (!open && files === null) {
      window.api.github
        .pullFiles(repo.owner, repo.name, pull.number)
        .then(setFiles, (e) => setError(message(e)))
    }
  }

  const merge = () => {
    if (!confirming) return setConfirming(true)
    setMerging(true)
    setError(null)
    window.api.github.merge(repo.owner, repo.name, pull.number, pull.head).then(onMerged, (e) => {
      setError(message(e))
      setMerging(false)
      setConfirming(false)
    })
  }

  return (
    <li className="gh-item gh-item--commit">
      <button className="gh-commit" aria-expanded={open} onClick={toggle}>
        <span className="gh-item-main">
          #{pull.number} {pull.title}
          {isAgentBranch(pull.branch) && <span className="gh-badge">agent</span>}
        </span>
        <span className="gh-meta">
          {pull.branch} · {pull.ahead === null ? 'fork' : `${pull.ahead} ahead`}
        </span>
      </button>
      {open && (
        <>
          <ul className="gh-files">
            {error && <li className="gh-error">{error}</li>}
            {!files && !error && <li className="gh-note">Loading…</li>}
            {files?.length === 0 && <li className="gh-note">No file changes.</li>}
            {files?.map((f) => (
              <li key={f.path} className="gh-file">
                <span className="gh-file-path">{f.path}</span>
                <span className="gh-add">+{f.added}</span>
                <span className="gh-del">−{f.removed}</span>
              </li>
            ))}
          </ul>
          <div className="gh-actions">
            <button className="gh-btn" disabled={merging || files === null} onClick={merge}>
              {merging ? 'Merging…' : confirming ? `Confirm: merge into ${repo.defaultBranch}` : 'Merge'}
            </button>
            {confirming && !merging && (
              <button className="gh-link" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            )}
            <button className="gh-link" onClick={() => void window.api.github.open(pull.url)}>
              Open on GitHub
            </button>
          </div>
        </>
      )}
    </li>
  )
}

function CommitRow({ repo, commit }: { repo: Repo; commit: Commit }) {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = () => {
    setOpen(!open)
    if (!open && files === null) {
      window.api.github
        .files(repo.owner, repo.name, commit.sha)
        .then(setFiles, (e) => setError(message(e)))
    }
  }

  return (
    <li className="gh-item gh-item--commit">
      <button className="gh-commit" aria-expanded={open} onClick={toggle}>
        <span className="gh-item-main">
          <code className="gh-sha">{commit.sha.slice(0, 7)}</code> {commit.subject}
          {commit.agent && <span className="gh-badge">agent</span>}
        </span>
        <span className="gh-meta">
          {commit.author} · {ago(commit.at)}
        </span>
      </button>
      {open && (
        <ul className="gh-files">
          {error && <li className="gh-error">{error}</li>}
          {!files && !error && <li className="gh-note">Loading…</li>}
          {files?.map((f) => (
            <li key={f.path} className="gh-file">
              <span className="gh-file-path">{f.path}</span>
              <span className="gh-add">+{f.added}</span>
              <span className="gh-del">−{f.removed}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
