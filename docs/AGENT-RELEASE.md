# Shipping an update — the procedure every agent follows

**Read this end to end before touching anything.** It is not a summary of
`RELEASING.md`; it is the binding version. `RELEASING.md` explains the update
channel and why it is built that way. This says what you do, in order, and what
you are not allowed to do.

## 0. The one fact everything else follows from

**A commit reaches nobody. A release reaches everybody.**

The app asks `api.github.com/.../releases/latest` and compares that tag to its
own version. It never looks at branches, never looks at commits, and never
polls. You can push a hundred commits to `main` and not one user will ever be
told. Cutting a release is the only act that reaches a person.

Two consequences you must hold on to:

- Merging is not shipping. If you merged and stopped, nothing happened.
- Publishing a release is irreversible in the way that matters: within seconds,
  every app that opens is told. You cannot un-tell them. So the release is the
  last step, never the exploratory one.

## 0b. Test locally. Then push. Never test by publishing.

**A release is not a test run.** Everything except the release itself can be
proved on this machine: `npm run dist` builds the real installer, and installing
it locally and launching it exercises the whole app exactly as a user would.
Verify there, and publish only once it works.

Publishing to find out whether something works has three costs, and the first
one is the one that matters:

- **It is not reversible.** `/releases/latest` answers with the new tag within
  seconds and every app that opens is told. There is no quiet retry.
- **It burns version numbers on nothing.** A user's update history should read
  as a record of the product, not of an agent's debugging.
- **It publishes unfinished work to whoever downloads in that window.**

The only thing that genuinely cannot be rehearsed locally is the feed answering
with a new tag. If you must prove that path end to end, do it once, on a change
that was going to ship anyway — never on a change invented to test with.

**What this means in practice:** a change that is still being tested stays on a
branch and stays local. A change that leaves testing goes through GitHub, and
goes through this document. Those are two different moments and they are not
allowed to be the same one.

## 1. What the user actually sees, and why it constrains your commits

When someone opens the app and a newer release exists, they get one panel:

```
Your device, your choice on what happens to your app.
─────────────────────────────────────────────────────
Version 1.0.2 is available
You are running 1.0.1.

  3 releases since yours: 1.0.3, 1.0.2, 1.0.1.        ← only if they skipped some

4 changes across 3 files — +375 −162 lines

WHAT CHANGED
  update: say how many releases were missed             ← YOUR COMMIT SUBJECTS
  release: a tag has to name the commit that was built
WHERE
  src/main/update.ts                        +88  −12    ← files and line counts
[ Get the update ]  [ Not now ]  [ Don't notify me about updates ]
```

**`WHAT CHANGED` is your commit subject lines, rendered verbatim to end users.**
Not the CHANGELOG, not the release notes — the first line of each commit between
their version and the new tag, straight from the GitHub compare API.

This is the rule most agents get wrong. A subject like `fix stuff`, `wip`,
`address review comments` or `update deps` is not a private note to the
repository. It is a sentence a stranger reads while deciding whether to install
software on their machine. Write every subject as though it will be read by
someone who has never seen this codebase, because it will be.

## 2. The commit-subject rubric

Every commit that will land in a release must have a subject that satisfies all
five:

1. **`area: what changed`** — lowercase area prefix, colon, then the change.
   Areas in use: `update`, `release`, `graph`, `canvas`, `editor`, `database`,
   `nav`, `agent`, `vault`, `settings`, `roadmap`, `docs`, `arch`.
2. **States the outcome, not the activity.** "a stopped hand is a stopped
   camera", not "fixed velocity bug". The reader wants to know what is now true.
3. **Complete without the diff.** No `see below`, no issue numbers standing in
   for meaning, no `part 2`.
4. **≤ 72 characters.** The panel trims at 120 and the list is one line per
   commit; past 72 it wraps and the list stops being scannable.
5. **No shame words.** `fix typo`, `oops`, `revert revert`. If it is not worth a
   sentence, squash it into the commit it repairs before it reaches `main`.

The body is where the reasoning goes and it is not shown to users, so it can be
as long as the change deserves. Say what was traded, what you measured, and what
surprised you.

## 3. The update-log rubric — `CHANGELOG.md`

The panel shows commit subjects. `CHANGELOG.md` is the human-curated companion
and it becomes the release notes on the GitHub page the user lands on after
pressing **Get the update**. Both must exist and they must not contradict.

Every version gets a section that satisfies all of these:

```markdown
## [1.0.2] — 2026-09-04

One or two sentences: what this release is FOR. Not a list — the reason.

### Added
- **Name of the thing** — what it does, and the one detail a user would
  otherwise discover the hard way.

### Changed
- **What changed** — and what it was before, because "improved X" tells a
  reader nothing they can act on.

### Fixed
- **The symptom the user reported**, then the cause in one clause. Symptom
  first: they search for what they saw, not for what it turned out to be.

### Known limitations
- Anything that is still broken or unbuilt AND that a user could hit. Stated
  here so it is not discovered.
```

Rules for the entries themselves:

- **Every claim is checkable.** Numbers where numbers exist: "1149 tests",
  "311 KB", "155 commits". No "significantly faster" without the measurement.
- **User-visible only.** A refactor with no behavioural change does not get a
  line. It is in the commit log; that is where it belongs.
- **Reversals go in `Fixed`, not silently.** If a previous release claimed
  something that turned out to be untrue, say so in this one.
- **Nothing is promised.** No "coming soon", no roadmap. The Roadmap tab is the
  place for intent; the changelog is the place for what happened.
- **`### Known limitations` is not optional** when one exists. Shipping a gap
  quietly is the thing this file exists to prevent.

Move everything out of `## [Unreleased]` into the new version and leave
`Nothing yet.` behind. Add the compare link at the bottom of the file.

## 4. Choosing the version number

`package.json` is the single source; the About panel and the artifact filenames
both read it.

- **Patch** (1.0.1 → 1.0.2) — fixes and internal work. Nothing a user has to
  learn.
- **Minor** (1.0.x → 1.1.0) — a new surface, a new setting, anything that
  changes what the app can do.
- **Major** — a vault-format change, or anything that makes an old version
  unable to read what a new one wrote.

When in doubt, patch. An unnecessary minor costs nothing; a major that was not
one is a promise you cannot take back.

## 5. The sequence

Run it in this order. Do not reorder it, and do not start step 7 until step 6
has passed.

```bash
# 1. Be on main, and be current.
git checkout main && git pull

# 2. Bump the version in package.json, and write the CHANGELOG section (§3).

# 3. Verify. All three, all clean.
npm run typecheck
npm test
npm run build

# 4. Commit the bump.
git add package.json CHANGELOG.md
git commit -m "release: 1.0.2"

# 5. Build the artifacts.
npm run dist          # -> dist/Fate Setup 1.0.2.exe, dist/Fate-1.0.2-win.zip

# 6. Preflight. This is the gate. It refuses a dirty tree, a dist/ that does
#    not match the version, and a tag that already exists at another commit.
node scripts/release-preflight.mjs

# 7. Push the commit FIRST, so the tag has somewhere to point.
git push origin main

# 8. Publish. --target is the sha the preflight printed, not "main".
gh release create v1.0.2 "dist/Fate Setup 1.0.2.exe" "dist/Fate-1.0.2-win.zip" \
  --target <sha from preflight> \
  --title "Fate 1.0.2" --notes-from-file <(sed -n '/## \[1.0.2\]/,/## \[1.0.1\]/p' CHANGELOG.md)

# 9. Verify from outside. Not the exit code — the feed.
curl -sS -H "user-agent: Fate-Desktop" \
  https://api.github.com/repos/Nathan5674312/agent-workspace/releases/latest \
  | python -c "import sys,json;j=json.load(sys.stdin);print(j['tag_name'],[a['name'] for a in j['assets']])"
```

Step 9 must print the new tag AND both assets. A release whose assets are
missing has already told every user to go to a page with nothing on it.

## 6. The rules that exist because they were broken

**The tag must name the commit that was built.** `v1.0.0` did not: it pointed at
`aef15d7` (2026-08-11) while the published binaries were built from `de80b34`
(2026-09-01), 155 commits later. Nobody was careless — the tag was made at the
version bump, `main` moved, the artifacts were built weeks later, and
`gh release create` silently reused the tag that already existed. It cost
nothing while nothing read tags. It stopped being free the moment the panel
started rendering `compare/<old tag>...<new tag>`: a wrong tag becomes a
changelog telling every user they are 155 commits behind code they already run.

Hence: **tag at build time, never before**, always `--target <sha>`, and never
reuse an existing tag for a new build — delete and recreate it at the built
commit, or bump the version.

**Never create a draft release early.** A draft made weeks before the build
pins the tag to whatever `main` was that day. Build first, then create.

**Attach the artifacts in the same command that publishes.** `/releases/latest`
starts answering with the new tag the instant it is published, so a release
published empty and filled in afterwards has a window where every user is sent
to an empty page.

**Never `git add -A`.** More than one agent works in these repositories.
Stage the paths you touched, by name.

**Never push to a branch another session is working.** Check `git worktree list`
and `git log` first. If a repo has no worktree of your own and someone else is
in it, that is a finding to report, not an obstacle to route around.

## 7. What you must never do

- Publish a release you have not built and verified on this machine.
- Publish in order to test something. See §0b — verify locally, then publish.
- Publish with `--target main`. `main` moves; a sha does not.
- Ship a version bump without a `CHANGELOG.md` section.
- Delete or force-push a tag that a published release points at, unless you are
  repairing exactly the fault in §6 and have said so out loud first.
- Write a commit subject you would not want a stranger to read while deciding
  whether to trust this software.
- Report a release as done on the strength of a command's exit code. Step 9, or
  it did not happen.

## 8. When something goes wrong mid-release

- **Preflight blocked you.** Good — that is the whole point. Fix what it named.
  Do not work around it.
- **You published and the artifacts failed to upload.** Upload them immediately
  with `gh release upload`; every minute is users hitting an empty page.
- **You published the wrong thing.** Do NOT delete the release. Ship the fix as
  the next patch version. A deleted release makes `/releases/latest` answer with
  an older tag, which offers everyone a downgrade they cannot refuse.
- **The changelog is wrong but the build is fine.** Edit the release notes on
  GitHub; they are not baked into the binary.
