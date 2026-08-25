/**
 * TAGS THAT NOBODY HAS TO MAINTAIN, BECAUSE NOBODY WROTE THEM.
 *
 * The argument for this file is a measurement rather than a preference. Counted
 * across the author's own vault: of 1999 notes, `tags:` appears on 131, `area:`
 * on 96, `title:` on 96, `type:` on 90, `updated:` on 70, `status:` on 56. Six
 * conventions attempted and every one stalled around 5%. That is not a
 * discipline problem to be fixed with a better tag input — it is what happens to
 * every scheme that asks a person to describe a note at the moment they are busy
 * writing it. A seventh convention would land at 5% too.
 *
 * So these are DERIVED. They are computed from things that are already true and
 * could not have been forgotten: where the file sits, what its name says, what
 * links to it. That buys four properties nothing hand-written has.
 *
 *   Complete.       100% coverage by construction. Every note has a folder.
 *   Never wrong.    Nothing is guessed, so nothing needs reviewing or approving.
 *   Never stale.    Computed on read. Move a note and its facets moved with it.
 *   Free.           No model, no network, no API bill, works offline.
 *
 * NOTHING HERE IS EVER WRITTEN TO DISK, and that is the design rather than an
 * omission. The moment a derived value is stored it can disagree with what it
 * was derived from, and then it needs invalidating, and then it is just
 * hand-maintained metadata with extra steps.
 *
 * WHAT THIS IS NOT. It is not the semantic half. "This note is about anxiety"
 * cannot be read off a path and needs a model, can be wrong, and belongs in the
 * Inbox as a proposal a human confirms. Conflating the two is the trap: it
 * produces a system that is either useless (only structural) or untrustworthy
 * (guesses presented as facts). These are facts. The guesses live elsewhere.
 *
 * Every facet carries `why`. A person seeing `about: Roadmap` on a note filed
 * somewhere else is owed an explanation, and a facet that cannot justify itself
 * is indistinguishable from one that was made up.
 *
 * Pure, and framework-free, so `node --test` runs it directly.
 */

export type FacetKind =
  /** An ancestor folder. Emitted at every depth, so you can filter at any level. */
  | 'folder'
  /** A date the FILENAME states. Never a filesystem timestamp — see below. */
  | 'date'
  /** Position in the link graph, but only when it is worth saying. */
  | 'shape'
  /** Where this note's neighbours live, when that disagrees with where it lives. */
  | 'about'

export type Facet = {
  kind: FacetKind
  value: string
  /** Why this was derived, in words, for a person who did not expect it. */
  why: string
}

/** What this module needs to know about the link graph. */
export type Neighbourhood = {
  /** Paths this note links to or is linked from, deduplicated. */
  neighbours: string[]
  /** Every note's neighbour count, used to decide what counts as a hub HERE. */
  degrees: number[]
}

/** `Fate/Roadmap/07 - Agents.md` -> `['Fate', 'Fate/Roadmap']`. */
function ancestors(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

const folderName = (p: string): string => p.split('/').pop() ?? p

/**
 * A date stated by the filename, or null.
 *
 * FILENAME ONLY, never `mtime`. A filesystem timestamp says when the bytes were
 * last touched, which a git checkout, a sync client, a backup restore or this
 * app's own save all rewrite. Presenting that as "when this note is about" would
 * be confidently wrong for whole folders at a time, and wrong in a way nobody
 * would think to check. A date in a filename was typed by someone who meant it.
 *
 * Both shapes in use here are handled: `2026-08-19.md` from the daily notes, and
 * `20260816-001623-765928.md` from the inbox capture. The month and day are
 * range-checked so that `12345678-notes.md` does not become a date, and the
 * separator is required on the compact form so a bare number cannot match.
 */
export function dateFromName(path: string): string | null {
  const name = folderName(path).replace(/\.[^.]+$/, '')
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\b|_)/.exec(name) ?? /^(\d{4})(\d{2})(\d{2})[-_.]/.exec(name)
  if (!m) return null
  const [, y, mo, d] = m
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${y}-${mo}-${d}`
}

/**
 * The threshold above which a note counts as a hub, for THIS vault.
 *
 * Relative — the top tenth by neighbour count — not a fixed number, because a
 * constant that is right for a 200-note vault labels half a 12 000-note vault a
 * hub and none of a brand-new one. A floor of 3 sits underneath it so that in a
 * near-empty vault the single note with two links is not crowned.
 *
 * Exported because it is the one judgement call in this file and a test should
 * be able to pin it.
 */
export function hubThreshold(degrees: number[]): number {
  if (degrees.length === 0) return Infinity
  const sorted = [...degrees].sort((a, b) => a - b)
  const cut = sorted[Math.floor(sorted.length * 0.9)] ?? 0
  return Math.max(3, cut)
}

/**
 * Every facet of one note.
 *
 * Deliberately silent about the ordinary. There is no `leaf` or `connected`
 * facet, because a label carried by four notes in five carries no information
 * and makes the ones that matter harder to see. Only `orphan` and `hub` are
 * emitted, and only when true.
 */
export function facets(
  path: string,
  hood: Neighbourhood,
  hubAt: number = hubThreshold(hood.degrees),
): Facet[] {
  const out: Facet[] = []

  for (const dir of ancestors(path)) {
    out.push({
      kind: 'folder',
      value: dir,
      why: `The note is filed under ${dir}/. Every ancestor is listed, so a filter can sit at any depth.`,
    })
  }

  const date = dateFromName(path)
  if (date) {
    out.push({
      kind: 'date',
      value: date,
      why: `The filename states ${date}. Read from the name, never from the file's timestamp, which a checkout or a sync rewrites.`,
    })
  }

  const degree = hood.neighbours.length
  if (degree === 0) {
    out.push({
      kind: 'shape',
      value: 'orphan',
      why: 'Nothing links to this note and it links to nothing. It is only reachable by remembering it exists.',
    })
  } else {
    const cut = hubAt
    if (degree >= cut) {
      out.push({
        kind: 'shape',
        value: 'hub',
        why: `${degree} notes connect to this one, putting it in the most-linked tenth of this vault (${cut}+). Hubs are where a reader arriving cold should start.`,
      })
    }
  }

  const about = dominantFolder(path, hood.neighbours)
  if (about) {
    out.push({
      kind: 'about',
      value: about.folder,
      why: `${about.count} of ${about.of} linked notes live in ${about.folder}/, which is not where this note is filed. It is filed by where it sits and this is what it is connected to.`,
    })
  }

  return out
}

/**
 * The folder most of this note's neighbours live in, when it is not its own.
 *
 * This is the one facet that says something the file path does not, and it is
 * still not a guess: it is a count. A note sitting in `Inbox/` whose every link
 * goes to `Fate/Roadmap/` is about the roadmap, and no model was needed to work
 * that out.
 *
 * Guarded twice, because a weak version of this would be noise. A strict
 * MAJORITY is required, not a plurality — three folders with two notes each says
 * nothing. And at least three neighbours, because two out of two is a
 * coincidence that will fire constantly on a sparse vault.
 */
function dominantFolder(
  path: string,
  neighbours: string[],
): { folder: string; count: number; of: number } | null {
  if (neighbours.length < 3) return null
  const own = ancestors(path).at(-1) ?? ''

  const tally = new Map<string, number>()
  for (const n of neighbours) {
    const dir = ancestors(n).at(-1)
    if (!dir) continue
    tally.set(dir, (tally.get(dir) ?? 0) + 1)
  }

  let best: { folder: string; count: number } | null = null
  for (const [folder, count] of tally) {
    if (!best || count > best.count) best = { folder, count }
  }
  if (!best) return null
  if (best.count * 2 <= neighbours.length) return null

  // Nothing is learned from a note being connected to its own branch of the
  // tree. Caught by running this over the real vault, where half the `about`
  // facets produced were of the form "this note in Fate/Inner Circle Barbershop
  // is about Fate" — true, and precisely what the folder facets already said.
  // The facet earns its place only when the neighbours are somewhere ELSE:
  // `Fate/Roy Lee/01 - Principles` being about `Transcripts/Roy Lee` is worth
  // knowing, because nothing in the path says the playbook came from those
  // transcripts.
  if (best.folder === own) return null
  if (own === `${best.folder}` || own.startsWith(`${best.folder}/`)) return null
  if (best.folder.startsWith(`${own}/`)) return null

  return { ...best, of: neighbours.length }
}

/** Facets as `kind:value` strings, for matching against a filter. */
export function facetKeys(f: Facet[]): string[] {
  return f.map((x) => `${x.kind}:${x.value}`)
}

/**
 * Every note's neighbourhood, built once from the whole graph.
 *
 * `facets()` defaults `hubAt` to `hubThreshold(hood.degrees)`, which sorts the
 * entire degree array. That is fine for one note and quadratic-with-a-log for a
 * whole vault — 465 notes means 465 sorts of a 465-element array to produce one
 * number that is identical every time. Callers rendering a table want the
 * threshold computed once, so this returns it alongside the map.
 *
 * Links are taken as `{from, to}` rather than as the app's `VaultLink` so this
 * module stays free of the IPC contract; it needs two strings and nothing else.
 *
 * Edges naming a path that is not in `paths` are counted for the end that IS
 * known. A link out of the vault still says something about the note that made
 * it, and dropping it would understate that note's degree.
 */
export function neighbourhoods(
  paths: string[],
  links: { from: string; to: string }[],
): { hoods: Map<string, Neighbourhood>; hubAt: number } {
  const adjacency = new Map<string, Set<string>>(paths.map((p) => [p, new Set<string>()]))
  for (const l of links) {
    adjacency.get(l.from)?.add(l.to)
    adjacency.get(l.to)?.add(l.from)
  }
  // Undirected and deduplicated: a note linking to another three times is one
  // neighbour, which is the same rule the graph view draws by.
  const degrees = paths.map((p) => adjacency.get(p)?.size ?? 0)
  const hubAt = hubThreshold(degrees)
  const hoods = new Map<string, Neighbourhood>(
    paths.map((p) => [p, { neighbours: [...(adjacency.get(p) ?? [])], degrees }]),
  )
  return { hoods, hubAt }
}
