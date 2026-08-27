/**
 * Block-level references: Obsidian's `^block-id`, read and written.
 *
 * THE SYNTAX IS NOT A CHOICE. This folder is a live Obsidian vault and Obsidian
 * is the other program reading these files every day. Invent `{#id}` or
 * Logseq's `id:: <uuid>` and every note grows a line Obsidian renders as
 * literal visible text — the app becomes the only reader that understands its
 * own vault, which is the failure the whole local-first posture exists to
 * avoid. So: ` ^id` at the end of a line, `[[Note#^id]]` to point at it, legal
 * characters latin letters, numbers and dashes.
 *
 * Obsidian's documented limits come with it rather than being discovered:
 * it does not resolve links into quotes, callouts or tables, and `^id` shows as
 * visible text in GitHub or Pandoc. Inheriting a documented limitation is
 * cheaper than inventing an undocumented one.
 *
 * Pure and framework-free — no Electron, no React, no filesystem — because both
 * processes and the test suite need the same answer about what a block id is.
 *
 * ponytail: a `^id` inside a fenced code block is read as a block id, because
 * nothing here tracks fence state. Track it when a note actually gets bitten;
 * the cost today is one extra entry in a map nobody looks up.
 */

/**
 * A block id at the end of a line, in both of Obsidian's forms: appended to a
 * paragraph (` ^id`) and alone on its own line (`^id`), which is how a table or
 * a list gets one. ONE regex covers both because the alternation is "start of
 * line or whitespace" — and it must be that rather than `\^`, or `x^2^abc`
 * would hand back an id nobody wrote.
 */
const BLOCK_ID = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/

/** `## Heading`, with ATX closing hashes tolerated: `## Heading ##`. */
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/

/** Headings are compared the way a human reads them, not byte for byte. */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Every block id in this note, mapped to the 0-based line it marks.
 *
 * FIRST WINS on a duplicate, matching Obsidian. That is a bug wearing a
 * behaviour's clothes, which is why `ensureBlockId` refuses to CREATE one —
 * this side has to keep reading files Obsidian and a human have already
 * written, and refusing to read a real file is worse than resolving it the same
 * way the other reader does.
 */
export function blockIds(text: string): Map<string, number> {
  const ids = new Map<string, number>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCK_ID.exec(lines[i])
    if (m && !ids.has(m[1])) ids.set(m[1], i)
  }
  return ids
}

/**
 * The 0-based line a `[[Note#fragment]]` points at, or null.
 *
 * ONE function for both fragment kinds on purpose: `#^id` and `#Heading` are
 * the same question — "where in this note" — and every caller wants the line,
 * not a taxonomy. `^` is the whole discriminator, exactly as in the file.
 */
export function anchorLine(text: string, fragment: string): number | null {
  const frag = fragment.trim()
  if (!frag) return null
  if (frag.startsWith('^')) return blockIds(text).get(frag.slice(1)) ?? null

  // `[[Note#Chapter#Section]]` names a path down the outline. The deepest
  // segment is the line to land on, so matching only that resolves the nested
  // form without carrying an outline around. It resolves a little more than
  // Obsidian does (which checks the whole path); erring toward landing the user
  // somewhere real beats refusing a link that names a heading the note has.
  const want = norm(frag.split('#').pop() ?? '')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i])
    if (m && norm(m[2]) === want) return i
  }
  return null
}

/** The character offsets of one line, for a textarea selection. */
export function lineRange(text: string, line: number): { start: number; end: number } {
  const lines = text.split('\n')
  if (line < 0 || line >= lines.length) return { start: 0, end: 0 }
  let start = 0
  for (let i = 0; i < line; i++) start += lines[i].length + 1
  return { start, end: start + lines[line].length }
}

/** The 0-based line a caret offset sits on. */
export function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split('\n').length - 1
}

/**
 * Why this line cannot be given a block id, or null if it can.
 *
 * Obsidian does not resolve a reference into a quote, a callout or a table, so
 * writing an id there would put a link on the clipboard that the other reader
 * of these files cannot follow. Refusing is the honest answer; emitting it and
 * letting the user discover it in Obsidian is not.
 */
export function blockIdRefusal(line: string): string | null {
  const t = line.trim()
  if (!t) return 'An empty line cannot carry a block reference.'
  if (t.startsWith('>')) return 'Obsidian cannot link into a quote or callout.'
  if (t.startsWith('|')) return 'Obsidian cannot link into a table.'
  if (t.startsWith('```') || t.startsWith('~~~')) {
    return 'A code fence cannot carry a block reference.'
  }
  if (HEADING.test(line)) return 'Link a heading as [[Note#Heading]] — no id needed.'
  return null
}

export type BlockIdResult =
  | { ok: true; text: string; id: string }
  | { ok: false; refusal: string }

/**
 * The id for `line`, creating one if it has none.
 *
 * IDEMPOTENT, and that is the point: pressing the button twice on the same
 * paragraph hands back the same id and the same text, so it cannot mark a note
 * dirty for nothing or leave two ids on one line.
 *
 * Ids are six characters of `[a-z0-9]`, which is what Obsidian generates and
 * what people recognise. Hand-written ids (`^decision-3`) are READ as well —
 * `BLOCK_ID` accepts the full legal character set — they are simply not what
 * this generates.
 *
 * ONE RULE OBSIDIAN DOES NOT ENFORCE: the id is checked against every id
 * already in the file. Obsidian permits two identical ids and then silently
 * resolves to the first; refusing the collision at the point of writing removes
 * a whole class of wrong-target bug before it exists.
 */
export function ensureBlockId(text: string, line: number): BlockIdResult {
  const lines = text.split('\n')
  if (line < 0 || line >= lines.length) {
    return { ok: false, refusal: 'There is no line here to reference.' }
  }
  const existing = BLOCK_ID.exec(lines[line])
  if (existing) return { ok: true, text, id: existing[1] }

  const refusal = blockIdRefusal(lines[line])
  if (refusal) return { ok: false, refusal }

  const taken = blockIds(text)
  let id = ''
  // `toString(36)` drops leading zeros, so a small draw is short; loop rather
  // than pad, because padding biases the alphabet toward one character.
  while (id.length !== 6 || taken.has(id)) id = Math.random().toString(36).slice(2, 8)

  lines[line] = `${lines[line].replace(/[ \t]+$/, '')} ^${id}`
  return { ok: true, text: lines.join('\n'), id }
}
