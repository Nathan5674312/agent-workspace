/**
 * ONE definition of what a wikilink is, imported by both processes.
 *
 * There were two: `WIKILINK` in src/main/vault.ts, which built the graph, and
 * `parseWikilinks` in the vault pane's helpers, which built the editor's Links
 * list. They did not agree. The main-process one had no closing `]]`, so any
 * stray `[[` in prose — a note documenting the syntax, a truncated paste —
 * produced a graph edge the editor never showed and the note did not have.
 *
 * A parser the user can see the output of in two places has to be one parser.
 */

// Type-only: this file stays runtime-dependency-free, which is what lets both
// processes and the test suite import it directly.
import type { VaultTreeNode } from './ipc.js'

/**
 * `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`, `[[Target#^block-id]]`,
 * and the same-note forms `[[#heading]]` / `[[#^block-id]]`.
 *
 * THREE GROUPS, NOT ONE DISCARDED SUFFIX. This used to be
 * `(?:[#|][^\]\n]*)?` — one optional group matching everything after the first
 * `#` or `|` and throwing it away. That is why block references written in
 * Obsidian already resolved here, coarsely, to the whole note: the app parsed
 * the address it then refused to use. Capturing the parts is what turns
 * `[[Note#^a1b2c3]]` from "somewhere in Note" into a line.
 *
 * The target class excludes newlines as well as `]`, `|` and `#`: without that
 * an unclosed `[[` swallows the rest of the file looking for its terminator and
 * matches across paragraphs. The other two classes exclude `\n` for the same
 * reason and must keep doing so.
 *
 * The target may now be EMPTY, which is Obsidian's `[[#Heading]]` — a link into
 * the note it is written in. `parseWikilinks` drops those, so no graph edge is
 * gained or lost by the change; a note has never linked to itself.
 */
export const WIKILINK = /\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g

/** One parsed `[[…]]`, with the address kept rather than discarded. */
export type WikilinkRef = {
  /** The note. EMPTY means "this note" — `[[#Heading]]`, `[[#^id]]`. */
  target: string
  /** Everything after `#`, verbatim: `Heading`, `H1#H2`, or `^block-id`. */
  fragment: string | null
  alias: string | null
}

/**
 * Every wikilink in order of first appearance, deduplicated on target AND
 * fragment — two references to different blocks of one note are two links, and
 * collapsing them to the note is exactly the loss this feature exists to undo.
 */
export function parseWikilinkRefs(text: string): WikilinkRef[] {
  const out: WikilinkRef[] = []
  const seen = new Set<string>()
  // A fresh regex per call: the module-level one carries `lastIndex` between
  // calls, so sharing it across callers makes results depend on call order.
  for (const m of text.matchAll(new RegExp(WIKILINK.source, 'g'))) {
    const target = m[1].trim()
    const fragment = m[2]?.trim() || null
    // `[[]]` and `[[   ]]` address nothing at all.
    if (!target && !fragment) continue
    const key = `${target}\u0000${fragment ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ target, fragment, alias: m[3]?.trim() || null })
  }
  return out
}

/**
 * The form two wikilink targets are compared in.
 *
 * Lifted out of the vault pane's `helpers.ts`, which had it as a private `norm`
 * and still uses it — it is imported back there rather than copied, for the
 * reason at the top of this file. `[[Business/Launch]]`, `[[business/launch]]`
 * and `[[Business/Launch.md]]` are one address, and two functions that disagreed
 * about that would mean a link the editor resolves and the graph does not.
 */
export function normTarget(s: string): string {
  return s.trim().toLowerCase().split('\\').join('/').replace(/\.md$/i, '')
}

/**
 * Wikilink key -> vault-relative path.
 *
 * Basenames AND full paths, because Obsidian accepts both and the main
 * process's graph index already indexed both — so `[[Business/Playbooks/Launch]]`
 * drew an edge in the graph while clicking the same link in the editor resolved
 * to null and silently did nothing. Basenames are added for every note before
 * any path, so on a collision THE SHORT FORM WINS, matching the graph.
 *
 * That first-wins rule is why `linkTextFor` below exists: it is correct for
 * reading, where you follow the link somebody wrote, and it is a trap for
 * writing, where a short link next to a duplicate stem addresses a note you did
 * not mean.
 *
 * Moved here from the vault pane's `helpers.ts`, which re-exports it. It is a
 * wikilink concern, and once something writes links it has to be one the writer
 * can reach without copying the normalisation.
 */
export function indexNotesByName(node: VaultTreeNode | null): Map<string, string> {
  const index = new Map<string, string>()
  const notes: VaultTreeNode[] = []
  const walk = (n: VaultTreeNode | null): void => {
    if (!n) return
    if (n.kind === 'note') notes.push(n)
    for (const child of n.children ?? []) walk(child)
  }
  walk(node)

  const add = (key: string, path: string) => {
    const k = normTarget(key)
    if (k && !index.has(k)) index.set(k, path)
  }
  for (const n of notes) add(n.name, n.path)
  for (const n of notes) add(n.path, n.path)
  return index
}

/** Resolve a wikilink target to a vault path. Case-insensitive, like the indexer. */
export function resolveWikilink(name: string, index: Map<string, string>): string | null {
  return index.get(normTarget(name)) ?? null
}

/**
 * Wikilink targets in order of first appearance, trimmed, deduplicated.
 *
 * Unchanged output, and it must stay unchanged: this is what the graph builder
 * counts edges with. Fragment-only links are not targets and are skipped.
 */
export function parseWikilinks(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const { target } of parseWikilinkRefs(text)) {
    if (target && !seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
  }
  return out
}

// --------------------------------------------------------------- WRITING one
//
// Everything above reads. Everything below writes, and the two halves have
// different stakes: a reader that is wrong shows a wrong graph, and a writer
// that is wrong edits prose somebody wrote. Measurements behind every rule here
// are in `docs/graph-connections.md`, taken against the real vault 2026-08-27.

/**
 * The headings a "related notes" section goes by in this vault.
 *
 * Six spellings, because the vault has them and a writer that only knew one
 * would append a second section to a note that already had one. Matched
 * case-insensitively at any heading depth.
 */
const RELATED_HEADING = /^#{1,6}\s+(related|see also|links|linked|references|connections)\b/i

/** Any ATX heading — where a section stops. */
const ANY_HEADING = /^#{1,6}\s/

/** A list item, in any of the three bullet spellings Markdown allows. */
const BULLET = /^(\s*)([-*+])\s/

/**
 * What a section created from scratch is called, and how its first line looks.
 *
 * SETTLED 2026-08-27, having been two open constants until then. They matter
 * more than their size suggests: 1742 of 1900 notes have no such section, so
 * this is the common path, not the fallback. When a note HAS a section its own
 * shape wins and neither of these is consulted.
 *
 * `## Related`, and the raw vault-wide count argues the other way — `## Links`
 * 39 to 28. It loses on WHERE those live. Broken down by area:
 *
 *     Fate/          ## Related 28   ## Links 23
 *     Transcripts/   ## Related  0   ## Links 13
 *     Templates/     ## Related  0   ## Links  3
 *
 * `## Links` leads only because two areas use it exclusively, and neither is
 * where notes get written and linked: Fate/ holds 847 of the vault's links
 * across 81 linked notes, and there `## Related` is ahead. The tiebreak is that
 * "Links" is already taken three times over in this app — the database has
 * Links and Backlinks columns counting outbound and inbound wikilinks, and the
 * graph footer says "N notes, M links". A section named after a number the app
 * displays elsewhere, meaning something else, is a collision worth avoiding.
 *
 * A BULLET, and here the data does not decide it: inside Fate/ sections it is
 * 32 bullet lines to 33 `·` ones. Near-perfect split, so it comes down to which
 * is safer to WRITE, and that is not close:
 *
 *   - Appending a bullet is a line insert. Appending to a `·` line is a string
 *     edit inside a line the user wrote. This function runs against notes
 *     nobody has open, so the failure modes are not equal — a stray line is
 *     obvious and deletable, a mangled sentence is neither.
 *   - `·` lines do not wrap or scale. The longest in this vault is already 9
 *     links (`Fate/SMB Agent Agency - GTM.md`), and a writer that appends only
 *     makes them longer.
 *
 * ponytail: two constants, not settings. If this ever ships to someone whose
 * vault says otherwise, derive them by counting that vault's own headings at
 * write time rather than growing a preferences screen for it.
 */
export const NEW_HEADING = '## Related'
const NEW_BULLET = '- '

/** Where the body starts: after the frontmatter block, or at 0. */
function bodyStart(text: string): number {
  if (!text.startsWith('---')) return 0
  const end = text.indexOf('\n---', 3)
  if (end === -1) return 0
  const close = text.indexOf('\n', end + 1)
  return close === -1 ? text.length : close + 1
}

/**
 * The wikilink text for a note, in the SHORTEST spelling that resolves back to
 * that same note.
 *
 * The graph hands out a path; a wikilink addresses a name; and the name index
 * is FIRST-WINS on a collision. So `[[Launch]]` written next to two notes
 * called Launch.md is not a link to the one you meant, it is a link to whichever
 * one the tree walk reached first — silently, and looking perfectly correct.
 * 1336 of 1900 notes in this vault share a filename stem with another.
 *
 * `resolve` is passed in rather than imported so there is exactly one resolver:
 * the caller hands over the same `resolveWikilink(name, index)` the editor
 * follows links with, and the check is therefore literally "would clicking this
 * link land on the note I am linking to". Nothing about the index is assumed
 * here, which is also what makes it testable against the real vault.
 *
 * Falls back to `[[full/path|Stem]]`, which is not an invention — the vault
 * already contains `[[System/Fable Backbone/Coding & Building|Coding & Building]]`.
 */
export function linkTextFor(path: string, resolve: (name: string) => string | null): string {
  const stem = path.split('/').pop()!.replace(/\.md$/i, '')
  /**
   * No filename in this vault contains these, but a filename is user input and
   * the day one does, a broken link is a worse answer than a refusal: `[[a|b]]`
   * built from a stem containing `|` parses as a different link entirely, and
   * one containing `]` does not parse at all.
   */
  if (/[[\]|#]/.test(path)) {
    throw new Error(`linkTextFor: path cannot be written as a wikilink: ${path}`)
  }
  return resolve(stem) === path ? `[[${stem}]]` : `[[${path}|${stem}]]`
}

/**
 * Add one wikilink to a note's related-notes section, creating the section when
 * there is none.
 *
 * `link` is a rendered wikilink — what `linkTextFor` returns. It is parsed
 * rather than trusted, because a caller that builds one by hand and gets it
 * slightly wrong would otherwise write an inert `[[Foo]` into a file.
 *
 * FOUR RULES, all measured:
 *
 *  1. AT THE END. Of the 78 notes in this vault with a related section, the
 *     section is the last heading in the file in 78. Not at the cursor, not
 *     after the first paragraph, and never in frontmatter — a wikilink appears
 *     in a frontmatter value in 4 notes of 1900, so that is not a convention,
 *     it is four accidents.
 *  2. MATCH THE NOTE. If a section exists, its own shape wins — bullets stay
 *     bullets, a `·` line grows another `·`. The house style is only used for a
 *     section that did not exist, which is the only case where there is nothing
 *     to match.
 *  3. NEVER TWICE. A note that already links to the target is returned
 *     unchanged, compared on `normTarget` so `[[Launch]]` and `[[launch.md]]`
 *     count as the same link. Dedup on the RESOLVED note is the caller's job —
 *     it is the one holding the index — and this is the cheap half that catches
 *     the common case.
 *  4. DO NOT GROW THE FILE'S TAIL. No note in this vault ends with a blank
 *     line and 433 of 439 end with exactly one newline, so the tail is
 *     normalised before appending rather than assumed. Without that, every note
 *     this touched would gain a blank line.
 */
export function addWikilink(text: string, link: string): string {
  const refs = parseWikilinkRefs(link)
  if (refs.length !== 1 || !refs[0].target) {
    throw new Error(`addWikilink: not a single note wikilink: ${JSON.stringify(link)}`)
  }
  const start = bodyStart(text)
  const body = text.slice(start)

  // Rule 3. Only the BODY is searched: the four frontmatter links in this vault
  // are not connections, and treating one as a reason to skip would silently
  // refuse to write the link that would actually make the edge.
  const target = normTarget(refs[0].target)
  if (parseWikilinkRefs(body).some((r) => r.target && normTarget(r.target) === target)) {
    return text
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const cr = eol === '\r\n' ? '\r' : ''
  const lines = body.split('\n')

  // The LAST related heading, not the first. A note with two is malformed, but
  // the one a reader would append to is the one nearest the bottom.
  let head = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RELATED_HEADING.test(lines[i])) {
      head = i
      break
    }
  }

  // Rule 1: no section, so make one at the very end of the file.
  if (head === -1) {
    const trimmed = text.replace(/\s+$/, '')
    return `${trimmed}${eol}${eol}${NEW_HEADING}${eol}${eol}${NEW_BULLET}${link}${eol}`
  }

  // The section runs to the next heading, or to the end of the file.
  let stop = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) {
      stop = i
      break
    }
  }

  // Rule 2: the shape is whatever the section already does.
  const linkLines: number[] = []
  for (let i = head + 1; i < stop; i++) {
    if (new RegExp(WIKILINK.source).test(lines[i])) linkLines.push(i)
  }

  if (linkLines.length === 0) {
    // A section with a heading and no links yet. Insert after the heading and
    // the blank line that conventionally follows it, so the result reads the
    // way a hand-written one does.
    const at = head + 1 < stop && lines[head + 1].trim() === '' ? head + 2 : head + 1
    lines.splice(at, 0, `${NEW_BULLET}${link}${cr}`)
    return text.slice(0, start) + lines.join('\n')
  }

  const last = linkLines[linkLines.length - 1]
  const bulleted = linkLines.find((i) => BULLET.test(lines[i]))
  if (bulleted !== undefined) {
    // Copy the marker and indent off the line above rather than assuming `- `:
    // a section written with `*` stays written with `*`.
    const m = lines[bulleted].match(BULLET)!
    lines.splice(last + 1, 0, `${m[1]}${m[2]} ${link}${cr}`)
  } else if (lines[last].includes(' · ')) {
    /**
     * The inline form, and it is only used when the line ALREADY has a `·` in
     * it. Extending the line rather than starting a new one is the whole point
     * of that shape — `[[A]] · [[B]] · [[C]]` is one line by intent.
     *
     * The test is the separator, NOT "it is not a bullet". A line holding one
     * link is not evidence of a `·` list, and three in this vault are of the
     * form `[[motion-system]] — scroll layer, one-ticker rule, …`: appending
     * there would put the new link after somebody's sentence. Same trap a
     * table row would spring, which is why neither needs its own branch.
     */
    lines[last] = `${lines[last].replace(/\s+$/, '')} · ${link}${cr}`
  } else {
    // One link on a line, possibly with prose after it. Its own line below,
    // matching the bare shape, touching nothing that was already written.
    lines.splice(last + 1, 0, `${link}${cr}`)
  }
  return text.slice(0, start) + lines.join('\n')
}
