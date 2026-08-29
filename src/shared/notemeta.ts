/**
 * The note metadata the database view needs, on top of the minimal `VaultNote`
 * every other consumer uses.
 *
 * WHY THIS IS NOT IN ipc.ts, where it naturally belongs: `VaultNote` is the
 * contract the explorer, the editor and the graph all read, and widening it
 * there is the right change. It is not made here only because `src/shared/ipc.ts`
 * currently carries another agent's uncommitted work, and touching that file
 * means either colliding with it or sweeping it into an unrelated commit. Fold
 * this back into `VaultNote` once that work lands.
 *
 * No new IPC channel exists for this. `vault:list` ALREADY carries these fields
 * -- `server.py`'s /notes has returned `folder`, `type` and `orphan` all along
 * and `vault.ts` was discarding them on the way through. The wire format did not
 * change; only what we admit is on it.
 */
import type { VaultNote } from './ipc.js'

export type VaultNoteMeta = VaultNote & {
  /**
   * Full containing folder, `(root)` for top-level notes. Straight from the
   * server. This is NOT the grouping axis -- see `areaOf`.
   */
  folder: string
  /** `type:` frontmatter, `''` when absent. 190 of 258 notes have none. */
  type: string
  /** `status:` frontmatter, `''` when absent. */
  status: string
  /** `updated:` frontmatter as written, `''` when absent. Never parsed to a Date. */
  updated: string
  /**
   * `tags:` frontmatter, split. `[]` when absent.
   *
   * The one multi-valued property here, which is why grouping needs
   * `groupValues` rather than a single `field()` lookup: a note with three tags
   * belongs in three buckets, exactly as a Notion multi-select does.
   */
  tags: string[]
  /** Hops from `reachRoot`. `null` means unreachable. */
  depth: number | null
  /** R6: not reachable from `reachRoot` within 2 hops. Notion has no equivalent. */
  orphan: boolean
  /**
   * The note `depth` and `orphan` were measured FROM, or null when nothing in
   * the vault links to anything.
   *
   * Carried per row because it is what stops the Orphans control lying. It used
   * to be the constant `Home.md`, and when no such note existed at the vault
   * root the BFS visited nothing and marked the entire vault orphaned — 1419 of
   * 1419 on this machine — while the UI still said "not reachable from Home",
   * naming a note that was not there. A count is only meaningful next to what
   * it counted from.
   */
  reachRoot: string | null
  /**
   * Outbound [[wikilinks]] that resolve to a note in the vault.
   *
   * This IS the relation column, and it is the only shape of one this vault
   * has data for: a scan found a [[link]] inside a frontmatter VALUE — the
   * Notion-style typed relation — in exactly 1 note of 280, against 653
   * resolved body edges. So the relation is the wikilink, and `buildIndex`
   * already resolved every one of them for the graph.
   *
   * Deduped by resolved target, so this is the endpoint count the graph draws
   * from, not a mention count.
   */
  links: number
  /** Inbound resolved [[wikilinks]]. The other half of the same edge set. */
  backlinks: number
}

/** Sentinel for "this note has no value for the field being grouped on". */
export const NONE = '—'

/**
 * The "Area" property, and the one real judgement call in this file.
 *
 * The obvious move is to group by `folder`, and it does not work: the vault has
 * **99 distinct folders**, which is a list, not an axis. The first path segment
 * gives ~10 -- Business, System, Projects, Transcripts, (root) -- which is what
 * a person actually means when they say where a note lives, and it is the
 * honest translation of Obsidian's folder into Notion's Area property.
 */
export function areaOf(n: { folder: string }): string {
  if (!n.folder || n.folder === '(root)') return '(root)'
  const cut = n.folder.indexOf('/')
  return cut === -1 ? n.folder : n.folder.slice(0, cut)
}

/**
 * Status → one of four tones.
 *
 * Status is the column people scan, and it was the flattest thing on screen:
 * ACTIVE, PARKED and blocked-on-domain-access rendered identically, so the
 * column carried no information until you read every cell. Apple's feedback
 * taxonomy is status / completion / warning / error, and that is what these are.
 *
 * Keyed off the FIRST word, not the whole string, because this vault's statuses
 * are freeform prose — 12 distinct values including a full sentence ("FIXED on
 * disk 2026-08-10 — live server still runs the old code until restart"). A
 * lookup table of exact values would miss every one of them, and would rot the
 * first time someone typed a new status. The first word is what the author
 * chose to lead with, so it is the part carrying the state.
 *
 * Unknown words get the neutral tone rather than a guess. A wrong colour is
 * worse than no colour: it asserts something about the note that nobody wrote.
 */
const TONE_WORDS: Record<string, 'live' | 'stop' | 'soon'> = {
  active: 'live', live: 'live', running: 'live', shipped: 'live',
  done: 'live', fixed: 'live', complete: 'live', catalogued: 'live',
  blocked: 'stop', failed: 'stop', broken: 'stop', stale: 'stop', abandoned: 'stop',
  plan: 'soon', spec: 'soon', brief: 'soon', idea: 'soon',
  draft: 'soon', proposed: 'soon', parked: 'soon', paused: 'soon',
}

export function statusTone(status: string): 'live' | 'stop' | 'soon' | 'none' {
  // Split on anything that is not a letter, so this survives "PARKED — not
  // started", "blocked-on-domain-access" and "north-star" alike.
  const first = status.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0]
  return (first && TONE_WORDS[first]) || 'none'
}

/**
 * A bare inline list off one frontmatter line: `[a, b]`, `a, b`, or `"a", "b"`.
 *
 * Not a YAML sequence reader. `parseFrontmatter` below is flat `key: value` by
 * design, so a multi-line `- item` block never reaches here in the first place;
 * this handles the one-line form the writer actually emits.
 */
export function parseList(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/**
 * Type → one of four families, so the Type column carries information at a
 * glance instead of 40-odd freeform strings all rendered identically.
 *
 * Same first-word keying as `statusTone`, for the same reason: these values are
 * freeform and hyphenated (`master-index`, `design-system`), so an exact-value
 * table would miss most of them and rot on the next new type.
 *
 * WHY FAMILIES ARE NOT COLOUR-CODED: the palette is monochrome by decision
 * (`tokens.css` §meaning, and note `07 - Design - Color` §4b) — the accent is
 * luminance, not a hue. Four coloured chips would quietly reverse that. The
 * family is carried by an ICON plus a luminance step instead, which is also
 * what keeps it legible for colour-blind users and at a glance in a dense table.
 *
 * Unknown types get `none` and render exactly as they do today. A guessed
 * family is the same failure `statusTone` avoids: asserting something about the
 * note that nobody wrote.
 */
export type TypeFamily = 'structure' | 'work' | 'reference' | 'routine' | 'none'

const FAMILY_WORDS: Record<string, TypeFamily> = {
  index: 'structure', master: 'structure', moc: 'structure',
  map: 'structure', hub: 'structure', canvas: 'structure',

  project: 'work', spec: 'work', plan: 'work', brief: 'work',
  roadmap: 'work', task: 'work', feature: 'work', decision: 'work',

  reference: 'reference', research: 'reference', landscape: 'reference',
  doc: 'reference', design: 'reference', note: 'reference', audit: 'reference',

  daily: 'routine', journal: 'routine', log: 'routine', playbook: 'routine',
  template: 'routine', meeting: 'routine', retro: 'routine', transcript: 'routine',
}

export function typeFamily(type: string): TypeFamily {
  const first = type.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0]
  return (first && FAMILY_WORDS[first]) || 'none'
}

/**
 * `2026-08-15` → `2026-08`, for grouping by month.
 *
 * A string slice, deliberately NOT `new Date(updated)`. `updated` is
 * frontmatter written by hand and is documented as never parsed to a Date:
 * `new Date('2026-8-1')` and `new Date('August 2026')` both "work" and both
 * shift under the local timezone, which would file a note into the wrong month
 * with no way to tell from the UI. Anything that is not ISO-shaped groups as
 * unset, which is honest.
 */
/**
 * `updated` -> a real calendar day, or null when it is not one.
 *
 * The calendar view needs an actual day, which `monthOf` deliberately avoids
 * providing — so this is the one place that turns hand-written frontmatter into
 * numbers, and it is strict on purpose.
 *
 * NEVER `new Date(updated)`. That accepts `2026-8-1` and `August 2026`, and
 * parses a bare `YYYY-MM-DD` as UTC midnight, which in any negative-offset
 * timezone renders as the PREVIOUS day — a note filed on the 1st appearing on
 * the 31st, silently, only for some users. Here the digits are read directly and
 * `Date.UTC` is used solely for the arithmetic that needs a calendar (weekday,
 * month length), where both sides are UTC and no shift is possible.
 *
 * The round-trip rejects days that do not exist: `2026-02-30` parses as three
 * plausible numbers and is not a date.
 */
export function parseYmd(updated: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(updated.trim())
  if (!match) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null
  }
  return { y, m, d }
}

export function monthOf(updated: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(updated)
  return m ? `${m[1]}-${m[2]}` : ''
}

/**
 * One captured item waiting in Inbox/, as the agent left it.
 *
 * These are PROPOSALS, not filed notes: the capture path writes where it thinks
 * the note should go and stops, so a human can agree or correct. That is the
 * whole reason the folder exists, and nothing in this app rendered it until
 * now — ten items have been sitting there since 2026-08-06.
 */
export type InboxItem = {
  path: string
  /** `proposed_title`, or the filename when the capture had no heading to copy. */
  title: string
  /** Where the agent wants it to go. `''` when it did not venture a guess. */
  folder: string
  /** The runner-up folders, in rank order. */
  alternatives: string[]
  type: string
  captured: string
  /** The note itself, frontmatter stripped. */
  body: string
}

/**
 * A deliberately small frontmatter reader, matching the one that WROTE these
 * files (`bench/writer.py` parse_fm): flat `key: value`, quotes stripped. Not a
 * YAML parser, because a YAML parser would be a dependency and a lie — nothing
 * writes nested frontmatter here, and pretending to support it would invite it.
 *
 * A note with no frontmatter, or an unterminated block, yields `{}` rather than
 * throwing. One of the ten inbox items on disk has no frontmatter at all
 * ("george flowberry broke"), and an index that throws on the scruffiest file
 * in the vault is useless precisely when it matters.
 *
 * Shared with `src/main/vault.ts`, which builds the database and graph views
 * off the same frontmatter. Two readers that disagree about what `type:` means
 * would put a note in one view and not the other.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}

  const fm: Record<string, string> = {}
  for (const line of text.slice(3, end).split('\n')) {
    if (!line.includes(':') || /^[\s\-#]/.test(line)) continue
    const cut = line.indexOf(':')
    fm[line.slice(0, cut).trim()] = unquote(line.slice(cut + 1).trim())
  }
  return fm
}

/**
 * Strip the quotes off a double-quoted scalar, and UNESCAPE what is inside.
 *
 * This used to be `.replace(/^"|"$/g, '')`, which strips but does not unescape,
 * so `title: "My \"Thing\""` read back as `My \"Thing\"` — with the backslashes
 * still in it. Latent for as long as nothing wrote these files, and no longer
 * latent now that `setFrontmatter` does: the writer has to quote a value that
 * would otherwise parse as YAML, and a writer whose output this could not read
 * back is a table showing one thing while the file says another.
 *
 * `JSON.parse` is the whole implementation because a YAML double-quoted scalar
 * and a JSON string agree on the escapes that occur in practice. Anything it
 * refuses falls back to the old bare strip, so the scruffiest hand-written line
 * in the vault still yields a string rather than throwing.
 */
function unquote(v: string): string {
  if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v)
      if (typeof parsed === 'string') return parsed
    } catch {
      /* not JSON-shaped — fall through to the bare strip below */
    }
  }
  return v.replace(/^"|"$/g, '')
}

/**
 * WRITE one frontmatter key back into a note, leaving everything else byte for
 * byte as it was.
 *
 * This is the inverse of `parseFrontmatter` and it MUST agree with it about
 * what a key line is, or a value the table wrote would not be a value the table
 * reads back. Same rule, stated once here and once there: a line that contains
 * a `:` and does not start with whitespace, `-` or `#`. That excludes list
 * items, comments, and the indented continuation of a block scalar — none of
 * which this may touch.
 *
 * An empty `value` DELETES the key rather than writing a blank one. `status:`
 * with nothing after it parses back as `''`, which every reader in this app
 * already treats as absent, so the line would be litter that means nothing.
 * Clearing a property in the table is how a key gets removed.
 *
 * Not a YAML library, and deliberately not. The file is never re-emitted, so a
 * note whose frontmatter this cannot fully model still round-trips untouched
 * apart from the single line being changed. A real serialiser would rewrite
 * comments, key order, quoting style and block scalars across 200-odd notes it
 * was never asked to touch, and the diff would be unreadable.
 *
 * ponytail: single scalar keys only. `tags:` is a list and stays read-only —
 * both the inline `[a, b]` form and a `- ` block exist in this vault, and
 * picking one to write would silently rewrite the other. Tags get their own
 * editor when they need one.
 */
export function setFrontmatter(text: string, key: string, value: string): string {
  // A newline inside a scalar ends the line and turns the rest of the value
  // into a second, bogus key. Every caller is a single-line input, so this is a
  // guard against paste, not a feature.
  const v = value.replace(/[\r\n]+/g, ' ').trim()
  const isKey = (line: string) =>
    line.includes(':') &&
    !/^[\s\-#]/.test(line) &&
    line.slice(0, line.indexOf(':')).trim() === key

  if (!text.startsWith('---')) {
    // Nothing to clear, and no reason to grow a block onto a note just to say a
    // property is absent — which is what it already is.
    if (!v) return text
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    return `---${eol}${key}: ${scalar(v)}${eol}---${eol}${eol}${text}`
  }
  const end = text.indexOf('\n---', 3)
  // An opening `---` with no closing one is not frontmatter — it is a
  // horizontal rule, or a block someone is halfway through typing. Writing into
  // it would invent a boundary the file does not have.
  if (end === -1) return text

  const block = text.slice(3, end)
  const rest = text.slice(end)
  // Line endings are matched, not normalised: a CRLF file stays CRLF, and a
  // mixed one is not "corrected" on the lines this was not asked to touch.
  const cr = block.includes('\r\n') || rest.startsWith('\r\n') ? '\r' : ''
  const lines = block.split('\n')

  const at = lines.findIndex(isKey)
  if (at !== -1) {
    if (!v) lines.splice(at, 1)
    else lines[at] = `${key}: ${scalar(v)}${cr}`
  } else {
    if (!v) return text
    // Appended at the END of the block, not the top. These notes open with
    // `title` and `type`, which is the order a reader expects to find them in,
    // and inserting above that would reshuffle every note the table touches.
    lines.push(`${key}: ${scalar(v)}${cr}`)
  }
  return `---${lines.join('\n')}${rest}`
}

/**
 * Quote only when a bare scalar would parse back as something else.
 *
 * Bare wherever possible, because these notes are read by a human in Obsidian:
 * `status: active` is what the other 200 notes say, and quoting it for safety
 * would make the one note the table touched look machine-written.
 * `JSON.stringify` is the double-quoted YAML form for ordinary text, and it is
 * exactly what `parseFrontmatter` strips back off.
 *
 * THE DENYLIST WAS INCOMPLETE, and this app's own reader could never have shown
 * it: `parseFrontmatter` takes every line as a string, so a value a REAL YAML
 * parser mangles still round-trips perfectly here. Measured 2026-08-29 by
 * feeding this function's output to js-yaml, and four of the misses did not
 * mis-read one value — they made the WHOLE BLOCK fail to load, which in
 * Obsidian is a note showing no properties at all:
 *
 *   `- item` `? maybe` `-`  block-sequence and complex-key indicators. Only
 *                           indicators when followed by a space or the end of
 *                           the line, so `-item` stays bare and correct.
 *   `ends:`                 a trailing colon. `:\s` never matched end-of-line,
 *                           and `a:b` mid-value is legal and still goes bare.
 *   `#tag`                  the `: ` supplies the space that starts a comment,
 *                           so the value read back as null.
 *   `true` `null` `~` …     plain-resolved to a boolean or null instead of the
 *                           string that was typed. The YAML 1.1 set, not 1.2's:
 *                           js-yaml 4 reads `no` as a string, PyYAML reads it
 *                           as False, and this vault is read by both.
 *
 * Numbers and dates are deliberately NOT in that last group. `updated:
 * 2026-08-27` becoming a date and `42` becoming a number is what a human typing
 * the same line gets, it is the convention in these notes, and quoting them
 * would be the machine-written look this function exists to avoid.
 */
function scalar(v: string): string {
  return /^[>|&*!%@`'"[{#]|^[-?](?:\s|$)|:(?:\s|$)|\s#|^(?:true|false|yes|no|on|off|null|~)$/i.test(v)
    ? JSON.stringify(v)
    : v
}

/** The body after the frontmatter block, or the whole text when there is none. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text.trim()
  const end = text.indexOf('\n---', 3)
  return end === -1 ? text.trim() : text.slice(end + 4).trim()
}

/** Read one inbox capture. */
export function parseProposal(path: string, text: string): InboxItem {
  const stem = path.split('/').pop()!.replace(/\.md$/i, '')
  const fm = parseFrontmatter(text)

  return {
    path,
    title: fm.proposed_title || stem,
    folder: fm.proposed_folder || '',
    // `alternatives: [System, Business]` — a bare inline list, not JSON, so it
    // is split rather than parsed.
    alternatives: parseList(fm.alternatives || ''),
    type: fm.proposed_type || '',
    captured: fm.captured || '',
    body: stripFrontmatter(text),
  }
}

/**
 * Normalise one row off the wire.
 *
 * Every field is defended even though the server sends all of them, because the
 * note server is a SEPARATE process on a version this app does not control. An
 * older server (or one mid-restart) simply omits `status` and `updated`, and the
 * table must render a blank cell rather than throw on `undefined.toLowerCase()`.
 */
export function toMeta(raw: unknown): VaultNoteMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const path = str(o.path)
  if (!path) return null
  return {
    path,
    title: str(o.title) || path.split('/').pop()!.replace(/\.md$/i, ''),
    mtime: typeof o.mtime === 'number' ? o.mtime : 0,
    folder: str(o.folder) || '(root)',
    type: str(o.type),
    status: str(o.status),
    updated: str(o.updated),
    // Accepts both shapes on the wire: a real array from this app's own main
    // process, and the raw `[a, b]` string an older server would send.
    tags: Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string' && t !== '')
      : parseList(str(o.tags)),
    depth: typeof o.depth === 'number' ? o.depth : null,
    orphan: o.orphan === true,
    // A server too old to send these is not a broken row — it is a row with no
    // relations to show, which renders as the same em-dash an unlinked note
    // gets. Same posture as `status` and `updated` above.
    links: typeof o.links === 'number' ? o.links : 0,
    backlinks: typeof o.backlinks === 'number' ? o.backlinks : 0,
    // Absent is null, not a guessed 'Home.md'. Inventing a root here would put
    // the exact wrong claim back into the UI that this field exists to remove.
    reachRoot: typeof o.reachRoot === 'string' && o.reachRoot ? o.reachRoot : null,
  }
}
