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
  /** Hops from Home. `null` means unreachable. */
  depth: number | null
  /** R6: not reachable from Home within 2 hops. Notion has no equivalent. */
  orphan: boolean
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
    fm[line.slice(0, cut).trim()] = line.slice(cut + 1).trim().replace(/^"|"$/g, '')
  }
  return fm
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
    alternatives: (fm.alternatives || '')
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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
    depth: typeof o.depth === 'number' ? o.depth : null,
    orphan: o.orphan === true,
  }
}
