/**
 * Note templates, as THIS vault already practises them.
 *
 * `Templates/` exists in the vault with five templates in it and predates the
 * app; nothing here is an invention. Lives in `shared/` for the reason
 * `daily.ts` gives one file over: a `.tsx` module cannot be imported by the
 * `node --test` suite, because type stripping does not handle JSX.
 *
 * TEMPLATES ARE COPIED VERBATIM, and that is the whole transform. It is worth
 * stating because the daily-note path next door does something different and
 * the two look like they should share code. `Daily/_Template.md` is a document
 * ABOUT a template — a heading, an instruction to copy the part below, a `---`,
 * then the thing to copy — so `noteFromTemplate` splits on the first `---` and
 * keeps the tail. A file in `Templates/` IS the template, frontmatter included,
 * and that same split would eat its opening `---` and leave `title:` sitting in
 * the body as prose. Different conventions, so different code.
 *
 * The `<angle bracket>` placeholders these files carry are left alone. They are
 * the author's own "fill this in" marker for a human reader, and an app that
 * guessed at them would be writing content nobody asked for into a new note.
 */
import type { VaultTreeNode } from './ipc.js'

/** The folder templates live in, beside `DAILY_DIR` in `daily.ts`. */
export const TEMPLATE_DIR = 'Templates'

/** One template offered to the user. */
export type Template = {
  /** Display name, no extension: `Project`, `Decision Log`. */
  name: string
  /** Vault-relative path to read. */
  path: string
}

/**
 * The templates in `Templates/`, in the order the tree already sorted them.
 *
 * TWO RULES, both read off the vault rather than chosen:
 *
 *  1. DIRECT CHILDREN ONLY. The folder is flat today. A nested folder would be
 *     a grouping, and there is nothing to group five files into.
 *  2. `_`-PREFIXED FILES ARE NOT TEMPLATES. `Templates/_Index.md` is a document
 *     about the folder, and offering it would create a note that is an index of
 *     templates. Same shape rule that keeps `Daily/_Template.md` out of the
 *     calendar, rather than a list of exceptions by name.
 *
 * Returns empty for a vault with no `Templates/` at all, which is the case the
 * caller renders nothing for — an empty menu is a control that admits nothing.
 *
 * ponytail: matched at the ROOT only, like `DAILY_DIR`. If a vault ever wants
 * per-folder templates, that is a different feature with a different UI, not a
 * looser match here.
 */
export function listTemplates(root: VaultTreeNode | null): Template[] {
  const dir = (root?.children ?? []).find(
    (n) => n.kind === 'folder' && n.path === TEMPLATE_DIR,
  )
  return (dir?.children ?? [])
    .filter((n) => n.kind === 'note' && !n.name.startsWith('_'))
    .map((n) => ({ name: n.name.replace(/\.md$/i, ''), path: n.path }))
}
