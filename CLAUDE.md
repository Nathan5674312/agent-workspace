# CLAUDE.md — agent-workspace (Fate)

## Tooling discipline

Global rules live in `~/.claude/CLAUDE.md` and apply here in full: check the
skill list before starting, `ponytail` on any coding task, the Universal Vault
is read-only unless Nathan asked. This file holds only what is specific to this
repository.

## 0. Two agents work in this repo. Read the claims file first.

**There is more than one Claude session on this machine, and they have collided
three times in one day.** Before you edit anything:

```bash
cat "$(git rev-parse --git-common-dir)/agent-claims.md"
```

That file is the live record of who is touching what. It lives in the shared
`.git` directory because every worktree resolves `--git-common-dir` to the same
path — so all of them see one file, it is never committed, no branch switch can
hide it, and it outlives the session that wrote it.

**Append your own block before your first edit. Delete it when your branch is
merged or abandoned.** The file explains its own format.

Three rules it exists to enforce:

1. **One worktree per session.** Never `git checkout` in a worktree you did not
   create — `git worktree add` your own. A session had its branch swapped
   underneath it mid-task because of this.
2. **Never `git add -A`.** Stage explicit paths. One session swept another's
   uncommitted `motion.ts` into an unrelated commit this way, and the fix landed
   under a message that did not mention it.
3. **Claim before you edit.** Both sessions independently wrote
   `app.setAppUserModelId` an hour apart — same bug, same call, one copy thrown
   away at merge. A claim is information, not a lock; overlap is sometimes
   right, discovering it at merge never is.

## 1. Shipping

`docs/AGENT-RELEASE.md` is binding and covers this end to end. The short of it:
**a commit reaches nobody, a release reaches everybody**, and a release is not a
test run. Test locally, then push.

## 2. Before you push anything

```bash
npm test          # node --test, no framework, currently 1100+ assertions
npx tsc --noEmit
npm run build     # electron-vite; catches what tsc alone does not
```

The suite is the safety net for a codebase whose renderer is barely covered —
**10 of 74 test files touch `src/renderer` at all.** Pure logic lives in
`src/shared/` precisely so `node --test` can reach it; a `.tsx` module cannot be
imported by the suite, because type stripping does not handle JSX. If you write
logic worth testing, it goes in `shared/`.

One gotcha that costs an hour if you meet it cold: a shared module that imports
another as `./x.js` **cannot be loaded by `node --test`**. Node's type stripping
resolves specifiers literally. Use `./x.ts` when the module needs to be
testable — `allowImportingTsExtensions` is already on, and vite resolves it the
same way.

## 3. Verifying UI changes

CSS and component HMR **does not reliably reach the Electron renderer here**.
`curl http://localhost:5173/app.css` can show the corrected file while the
window keeps painting the old one. Kill electron and re-run `npm run dev`
before believing a visual change, or you will verify three times against a
stale window.
