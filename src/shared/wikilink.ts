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

/**
 * `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`.
 *
 * The target class excludes newlines as well as `]`, `|` and `#`: without that
 * an unclosed `[[` swallows the rest of the file looking for its terminator and
 * matches across paragraphs.
 */
export const WIKILINK = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g

/** Wikilink targets in order of first appearance, trimmed, deduplicated. */
export function parseWikilinks(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // A fresh regex per call: the module-level one carries `lastIndex` between
  // calls, so sharing it across callers makes results depend on call order.
  for (const m of text.matchAll(new RegExp(WIKILINK.source, 'g'))) {
    const name = m[1].trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}
