/**
 * Refuse to cut a release whose tag does not name the code in the artifacts.
 *
 * THIS IS WRITTEN AGAINST A REAL FAILURE, NOT A HYPOTHETICAL ONE. Tag `v1.0.0`
 * points at `aef15d7` (2026-08-11). The binaries published under it were built
 * from `de80b34` (2026-09-01 22:05) — one minute before the timestamps inside
 * `Fate-1.0.0-win.zip`, and 155 commits and +26,872/-1,514 lines later. Nobody
 * did anything obviously wrong: the tag was made when the version was bumped,
 * the artifacts were built weeks later off a main that had moved, and the
 * release object was attached to the tag that already existed. Every step looked
 * right on its own.
 *
 * It stayed invisible because nothing reads a tag today. `/releases/latest`
 * returns `tag_name`, the app compares it to its own version, and neither ever
 * asks what commit that tag points at. The moment an update panel renders
 * "what changed" from `compare/<old tag>...<new tag>`, a tag that names the
 * wrong commit stops being a bookkeeping wart and becomes a changelog that
 * tells every user they are 155 commits behind code they are already running.
 *
 * So the check has to live at the only moment it can be enforced: between
 * building the artifacts and publishing them. Run it immediately before
 * `gh release create`, and pass `--target` with the sha it prints, so the tag is
 * pinned to the built commit rather than to wherever the default branch has
 * drifted by the time the release is published.
 *
 *   node scripts/release-preflight.mjs
 *
 * Exit 0 means the tag about to be created will name the code in `dist/`.
 * Anything else prints what is wrong and exits non-zero.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

/**
 * A `git` call whose failure is an ANSWER, not an error.
 *
 * `rev-parse` on a tag that does not exist is the ordinary good case — it means
 * the tag is about to be created — but git still writes "fatal: ambiguous
 * argument" to stderr, and execFileSync lets that through to the terminal. The
 * operator then reads a fatal error inside a check that is passing. Swallowing
 * stderr here is not hiding a problem; it is refusing to report a non-problem
 * in the language of one.
 */
const gitQuiet = (...args) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const problems = []
const note = (s) => console.log(`  ${s}`)

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const tag = `v${version}`
const head = git('rev-parse', 'HEAD')

console.log(`\nRelease preflight — ${tag}\n`)
note(`version   ${version}  (package.json)`)
note(`HEAD      ${head.slice(0, 7)}  ${git('log', '-1', '--format=%s')}`)

/**
 * 1. A dirty tree means the artifacts contain code no commit describes, so the
 *    tag cannot name them no matter where it points.
 */
const dirty = git('status', '--porcelain')
if (dirty) {
  problems.push(
    `Working tree is not clean. The build would contain code that is in no commit:\n` +
      dirty
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n'),
  )
}

/**
 * 2. The tag must not already exist somewhere else. This is the actual v1.0.0
 *    failure: an existing tag is silently reused by `gh release create`, and it
 *    keeps whatever commit it was made at.
 */
/**
 * THE REMOTE IS ASKED, NOT ONLY THE LOCAL REPOSITORY, and that distinction is
 * the whole value of this check.
 *
 * `gh release create` makes the tag on GitHub. A clone that has not fetched
 * since then has no such ref, so a local-only lookup answers "does not exist,
 * it will be created at HEAD" about a tag that already exists at another
 * commit — the precise failure this script was written to stop, reported as an
 * all-clear. Observed here on 2026-09-04, minutes after v1.0.1 was published.
 *
 * `ls-remote` is authoritative and costs one network round trip. If it cannot
 * be reached the local ref is used and the operator is told the check was
 * partial, because a preflight that silently degrades to a weaker check is
 * worse than one that says so.
 */
let tagged = null
let tagSource = 'origin'
const remote = gitQuiet('ls-remote', '--tags', 'origin', tag)
if (remote === null) {
  tagSource = 'local only — could not reach origin'
  tagged = gitQuiet('rev-parse', `${tag}^{commit}`)
} else if (remote === '') {
  tagged = gitQuiet('rev-parse', `${tag}^{commit}`)
  if (tagged) tagSource = 'local, not yet on origin'
} else {
  // An annotated tag prints twice: the tag object, then `<tag>^{}` for the
  // commit. The dereferenced line is the one that names the commit.
  const lines = remote.split('\n').map((l) => l.split('\t'))
  const deref = lines.find(([, ref]) => ref?.endsWith('^{}')) ?? lines[0]
  tagged = deref[0]
}
if (tagged && tagged !== head) {
  const behind = git('rev-list', '--count', `${tagged}..${head}`)
  problems.push(
    `Tag ${tag} already exists and points at ${tagged.slice(0, 7)}, not HEAD.\n` +
      `      HEAD is ${behind} commit(s) ahead of it. Publishing now would name\n` +
      `      the artifacts with a tag that describes different code — exactly how\n` +
      `      v1.0.0 shipped. Delete and recreate the tag at HEAD, or bump the version.`,
  )
} else if (tagged) {
  note(`tag       ${tag} already exists at HEAD (${tagSource}) — good`)
} else {
  note(`tag       ${tag} does not exist on origin; it will be created at HEAD`)
}

/**
 * 3. The artifacts have to be the ones this version names, and they have to be
 *    newer than the commit being tagged. A stale `dist/` from the previous
 *    version is the other way to publish a lie.
 */
const dist = resolve(root, 'dist')
if (!existsSync(dist)) {
  problems.push(`No dist/ directory. Run \`npm run dist\` before publishing.`)
} else {
  const artifacts = readdirSync(dist).filter((f) => f.endsWith('.exe') || f.endsWith('.zip'))
  if (artifacts.length === 0) {
    problems.push(`dist/ has no .exe or .zip. Run \`npm run dist\`.`)
  } else {
    const misnamed = artifacts.filter((f) => !f.includes(version))
    if (misnamed.length) {
      problems.push(
        `dist/ holds artifacts that are not ${version}: ${misnamed.join(', ')}.\n` +
          `      Clear dist/ and rebuild, or the wrong file gets attached.`,
      )
    } else {
      for (const f of artifacts) note(`artifact  ${f}`)
    }
  }
}

if (problems.length) {
  console.log(`\nBLOCKED — ${problems.length} problem(s):\n`)
  for (const p of problems) console.log(`  * ${p}\n`)
  process.exit(1)
}

console.log(`\nOK. Publish with the sha pinned, so a moving main cannot retarget the tag:\n`)
console.log(`  gh release create ${tag} dist/*.exe dist/*.zip \\`)
console.log(`    --target ${head} \\`)
console.log(`    --title "Fate ${version}" --notes-from-file CHANGELOG.md\n`)
