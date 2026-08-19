/**
 * The product roadmap, as data.
 *
 * This is the feature list the app is being built against, in the author's own
 * grouping and wording. It lives in `shared/` because two surfaces read it: the
 * Roadmap tab in the main canvas, and the left-ribbon placeholders, which name
 * the feature a given icon is a promise of. One list, so the two cannot drift.
 *
 * `status` is the honest state of the CODE, not a plan or an intention:
 *
 *   built    — works today, end to end, in the shipping app
 *   partial  — a real implementation exists with a named gap
 *   planned  — no implementation; the entry point may or may not exist yet
 *
 * The rule that keeps this useful: a feature moves to `built` when someone has
 * watched it work, and the `note` says what was verified. A roadmap that grades
 * itself optimistically is worse than no roadmap, because it is consulted
 * instead of the code.
 *
 * `surface` names where the feature lives in the UI, and is what lets a later
 * task be "fill in this panel" instead of "decide where this goes". `ribbon:*`
 * values are matched against LeftRibbon's view ids.
 */

export type FeatureStatus = 'built' | 'partial' | 'planned'

export type Feature = {
  /** The author's wording, kept verbatim. */
  label: string
  status: FeatureStatus
  /** Where it lives, or will. `ribbon:<id>` binds it to a left-ribbon icon. */
  surface?: string
  /** For `built`/`partial`: what was actually verified, or what the gap is. */
  note?: string
}

export type FeatureGroup = {
  title: string
  /** The author's own subtitle for the group, where they gave one. */
  subtitle?: string
  features: Feature[]
}

export const ROADMAP: FeatureGroup[] = [
  {
    title: 'Core demands',
    subtitle: 'table stakes',
    features: [
      {
        label: 'Local-first / self-hosted data ownership',
        status: 'built',
        note: 'Markdown files on disk are the only source of truth. Reads scan the vault directory directly; nothing is required to be running.',
      },
      {
        label: 'Cross-platform (Windows, Mac, Linux, mobile)',
        status: 'partial',
        note: 'Electron runs on all three desktops, but only Windows has been run. Mobile is not an Electron target at all.',
      },
      {
        label: 'Tree view left-side navigation',
        status: 'built',
        surface: 'ribbon:files',
        note: 'Folder tree follows Windows junctions and terminates on link cycles.',
      },
      { label: 'Clean modern UI (Notion-level polish)', status: 'partial', note: '16 controls are still inert; see docs/buttons/INDEX.md.' },
      {
        label: 'Offline access',
        status: 'partial',
        note: 'Reading the vault is fully offline. Saving still calls a local HTTP server.',
      },
      { label: 'Fast search', status: 'planned', surface: 'ribbon:search' },
      {
        label: 'Markdown support',
        status: 'partial',
        note: 'Notes are read, edited and saved as markdown. The editor is plain text: no rendered preview, no syntax highlighting.',
      },
      { label: 'Import from Notion, Obsidian, Evernote', status: 'planned', surface: 'Settings' },
    ],
  },
  {
    title: 'Database / structure',
    features: [
      {
        label: 'Databases with views (table, kanban, calendar, gallery)',
        status: 'built',
        surface: 'Database tab',
        note: 'All four views are built over one row set: table with filter, sort and group-by over frontmatter; board and gallery as groupings of the same rows; calendar placing them by `updated`. The calendar parses that date strictly and lists everything it cannot place rather than dropping it — most of this vault has no usable date. Kanban is the board, renamed. Not built: editing a value from a cell, which would need the lost-update guard from the save path somewhere a cell cannot show it.',
      },
      { label: 'Multi-hop lookup and rollup columns', status: 'planned', surface: 'Database tab' },
      { label: 'Linked / relational databases', status: 'planned', surface: 'Database tab' },
      { label: 'Templates', status: 'planned' },
      { label: 'Inline embeds (tables, media, code blocks)', status: 'planned', surface: 'Editor tab' },
    ],
  },
  {
    title: 'Knowledge graph',
    features: [
      {
        label: 'Graph view of connections between notes',
        status: 'built',
        surface: 'Graph tab',
        note: 'Force-directed, built from [[wikilinks]] off disk. 261 notes / 600 links on the live vault.',
      },
      {
        label: 'Backlinks and bidirectional linking',
        status: 'built',
        note: 'Backlinks are derived from the same graph and shown against the open note.',
      },
      { label: 'Block-level references', status: 'planned', note: 'Links resolve to whole notes; there is no block addressing.' },
    ],
  },
  {
    title: 'Collaboration',
    features: [
      { label: 'Real-time multiplayer editing', status: 'planned', note: 'Needs a server and a CRDT; the save path is currently last-write-wins behind an mtime guard.' },
      { label: 'Sharing / permissions', status: 'planned' },
      { label: 'Comments', status: 'planned', surface: 'Editor tab' },
    ],
  },
  {
    title: 'AI integration',
    subtitle: 'your edge',
    features: [
      { label: 'AI that actually knows your content', status: 'planned', surface: 'ribbon:terminal' },
      { label: 'Agents that read, write, and act on the vault', status: 'planned', surface: 'ribbon:terminal', note: 'Five claude:* IPC channels are declared and unimplemented.' },
      { label: 'Contextual retrieval, not just keyword search', status: 'planned', surface: 'ribbon:search' },
      { label: 'Autonomous organization and curation', status: 'planned', surface: 'Inbox tab', note: 'The Inbox already shows agent-proposed filing; nothing acts on it.' },
    ],
  },
  {
    title: 'Nice to haves',
    features: [
      { label: 'API / plugin ecosystem', status: 'planned', surface: 'ribbon:plugins' },
      { label: 'Web clipper', status: 'planned' },
      { label: 'Version history', status: 'partial', surface: 'Versions tab', note: 'The Versions tab lists every pre-edit copy in .backups/ for the open note, newest first, previews one, and restores it THROUGH save() so the lost-update guard and the backup-before-overwrite still apply. Both on-disk layouts are listed — the new mirrored one and the retired note server\'s flat one. The gap is that it has not been watched running yet: verified by test/versions.test.mjs against the real data layer, not by a human opening the tab. No pruning either — the history is still unbounded.' },
      { label: 'Whiteboard / canvas view', status: 'planned', surface: 'ribbon:canvas' },
      { label: 'Server / client homelab setup', status: 'planned' },
      {
        label: 'Open source or at least open format',
        status: 'built',
        note: 'The format is plain markdown with YAML frontmatter, readable by Obsidian today.',
      },
    ],
  },
]

/** Every feature, flattened. */
export const ALL_FEATURES: Feature[] = ROADMAP.flatMap((g) => g.features)

/** The feature a left-ribbon icon is a promise of, if any. */
export function featureForRibbon(id: string): Feature | undefined {
  return ALL_FEATURES.find((f) => f.surface === `ribbon:${id}`)
}

export function countByStatus(): Record<FeatureStatus, number> {
  const counts: Record<FeatureStatus, number> = { built: 0, partial: 0, planned: 0 }
  for (const f of ALL_FEATURES) counts[f.status]++
  return counts
}
