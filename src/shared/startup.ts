/**
 * Which note the app opens when it opens with none.
 *
 * FATE IS A NOTES APP. Launching to an empty canvas with "No note open" on it
 * is the wrong first screen for one: roughly 85% of the window was background
 * art and a sentence saying there was nothing there, on every cold start, in an
 * app whose entire subject is a folder full of notes you already have. Opening
 * the front door instead costs nothing and is what the category does.
 *
 * IT ONLY EVER OPENS A NOTE THAT ALREADY EXISTS. Nothing here creates a file,
 * and that is the line: an app that writes to your vault because you launched
 * it is a worse defect than the empty screen this replaces. Both candidates are
 * looked up in the tree that has already been read, so a vault with neither
 * simply keeps the empty state.
 *
 * Deliberately NOT "the last note you had open", which is the other obvious
 * rule and the one most notes apps use. That needs the renderer to hand main a
 * FILE PATH to persist, and this app's preload draws an explicit line there —
 * `pickVaultDir` takes no argument specifically so "the renderer cannot
 * nominate a directory for the app to read from", and `setAppearance` is
 * allowed an argument only because "nothing in Appearance can name a file".
 * Adding the first renderer-names-a-path write channel is a security decision,
 * not a convenience one, so this rule was chosen to need no new channel at all.
 */

/**
 * `.ts`, where the rest of this folder writes `.js`, and it is not a slip.
 *
 * Node's type stripping resolves a specifier literally: a shared module that
 * imports another one as `./daily.js` cannot be loaded by `node --test` at all,
 * which is why no test in this suite imports one that does. Every module here
 * with a runtime cross-import is untestable for that reason alone. `.ts` is
 * already allowed — tsconfig sets `allowImportingTsExtensions` — and vite
 * resolves it the same way, so this costs nothing and buys the tests in
 * test/startup-note.test.mjs.
 */
import { DAILY_DIR, dailyPath, todayLocal } from './daily.ts'
import type { VaultTreeNode } from './ipc.js'

/**
 * Root-level names treated as the vault's front door, in order of preference.
 *
 * Matched case-insensitively because a vault is a folder a person made by hand
 * and `home.md` is the same intent as `Home.md`. Both spellings are common
 * enough that picking one and ignoring the other would look like a bug.
 */
const HOME_NAMES = ['home.md', 'index.md', 'readme.md']

/** Immediate children of a folder node, or nothing. */
const childrenOf = (n: VaultTreeNode | null): VaultTreeNode[] => n?.children ?? []

/**
 * The note to open on a cold start, or null to leave the empty state up.
 *
 * @param tree  the vault root, as `vault.tree()` returns it.
 * @param now   injected so the daily-note branch is testable without waiting
 *              for tomorrow. Same reason `todayLocal` takes one.
 */
export function startupNote(
  tree: VaultTreeNode | null,
  now: Date = new Date(),
): string | null {
  if (!tree) return null

  /**
   * A home note at the ROOT only, never a nested one.
   *
   * `Fate/Roadmap/00 - INDEX.md` is an index of a section, not of the vault,
   * and a rule that searched the whole tree would open whichever one the walk
   * happened to reach first. Depth is what makes this predictable.
   */
  const root = childrenOf(tree)
  for (const want of HOME_NAMES) {
    const hit = root.find(
      (c) => c.kind === 'note' && c.name.toLowerCase() === want,
    )
    if (hit) return hit.path
  }

  /**
   * Failing that, TODAY'S daily note — but only if it is already written.
   *
   * A vault with a `Daily/` folder is one that keeps a journal, and the day's
   * page is the thing you open on a morning. Yesterday's is deliberately not a
   * fallback: opening a stale day reads as the app having lost your place,
   * where an empty editor at least tells the truth.
   */
  const daily = root.find((c) => c.kind === 'folder' && c.name === DAILY_DIR)
  if (daily) {
    const want = dailyPath(todayLocal(now))
    const hit = childrenOf(daily).find((c) => c.kind === 'note' && c.path === want)
    if (hit) return hit.path
  }

  return null
}
