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
      { label: 'Clean modern UI (Notion-level polish)', status: 'partial', note: 'No inert controls remain. Audited across every .tsx in src/renderer on 2026-08-18: 66 wired, 0 disabled, 4 read-only textareas that are read-only by design. The nine listed in docs/buttons/ were built; the ribbon icons were never inert once SidebarPlaceholder landed, and two of them (terminal, daily notes) are now real panels. Still partial for the honest reason: five ribbon icons show a panel naming an unbuilt feature rather than the feature.' },
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
      {
        label: 'Tags that form without anyone maintaining them',
        status: 'partial',
        surface: 'Database tab',
        note: 'Measured against the author\'s own vault on 2026-08-21, which is the whole argument for this entry: of 1999 notes, `tags:` appears on 131, `area:` on 96, `title:` on 96, `type:` on 90, `updated:` on 70 and `status:` on 56. Six conventions tried, every one stalled around 5%. Hand-maintained metadata does not survive contact with use, so a nicer tag input fails the same way. Inline #hashtags are worse than useless here without excluding code blocks first — the top matches in this vault are #endif, #include, #FFFFFF and #F59E0B, which are preprocessor directives and hex colours. TWO MECHANISMS, and conflating them is the trap. DERIVED facets are computed from what is already true — folder, link neighbourhood the graph already builds, date, filename series — cost nothing, need no model, are never wrong and never need approving, and have 100% coverage by construction. INFERRED tags are semantic, need an agent, can be wrong, and belong in the Inbox as proposals a human confirms. Ship the derived ones as a fact of the data; make the inferred ones a pipeline. THE DERIVED HALF IS BUILT — `shared/facets.ts`, pure and tested, deriving folder (every ancestor, so a filter sits at any depth), date (from the FILENAME only, never mtime, which a checkout or a sync rewrites), shape (orphan and hub only, hub being the top tenth of this vault rather than a fixed count that would be wrong at either end), and about (the folder a note\'s neighbours live in when it is a different branch of the tree). Run over the real vault: 463 of 465 notes carry at least one facet against 131 with a hand-written tag, and every facet explains itself in words. Running it there also caught a defect no unit test would have — half the `about` facets were of the form "this note in Fate/Barbershop is about Fate", which is true and is exactly what the folder facet already said; ancestors and descendants are now suppressed. Still partial: nothing in the UI consumes facets yet, so they are computed and unread, and the inferred half does not exist.',
      },
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
    title: 'Pipelines / canvas',
    // The third of three lenses, and the group exists to say so. Graph answers
    // "what is connected to what", Database answers "what shares attributes",
    // and both hand back FACTS. Canvas is the only one that hands back WORK,
    // which is why it is the only one that needs somewhere to remember how far
    // it has got. It was filed under "nice to haves" until 2026-08-21, which
    // was a straightforward misreading of what it is for.
    subtitle: 'procedure, where graph is association and database is classification',
    features: [
      {
        label: 'Whiteboard / canvas view',
        status: 'partial',
        surface: 'ribbon:canvas',
        note: 'Boards are stored as JSON Canvas (jsoncanvas.org), the same `.canvas` format Obsidian reads and writes, so a board made here opens there and back. Watched working in a run-through on 2026-08-21: create and open boards, make cards, draw edges, select singly and together, Alt+drag to duplicate, drag a note out of the tree to make a file card, pan, zoom to cursor, and framing. All four fidelity gaps against Obsidian are closed — arrowheads, hand-routed edge sides, edge labels and colours all render as the file describes them. Saves through the same guarded write the editor uses, and fields the view does not render are preserved rather than dropped. Still partial: no delete, no resize, no making a group, and media cards remain blocked by the renderer CSP.',
      },
      {
        label: 'Boards an agent can run',
        status: 'partial',
        surface: 'ribbon:canvas',
        note: 'A board is already a program, so nothing is added to it to make one: an arrow is order, a labelled box is a phase, a file card is material, an edge label is a condition. compile() in shared/pipeline.ts turns a board into an ordered plan without writing one byte back to the .canvas file; brief.ts writes that plan out in a form that explains itself to a reader with no prior knowledge and no SDK; run.ts is the queue, tracking what is done, what is waiting on a person, and what can be worked on now, so a run survives the person who started it going out for the day. All three are pure and framework-free — no Electron, no React, no filesystem — so they outlive the current host. The gap is the last mile: nothing writes a brief or a run to disk yet, and no agent has executed one end to end.',
      },
      {
        label: 'Pipelines an agent can find without being told',
        status: 'partial',
        surface: 'ribbon:canvas',
        note: 'The index is a board, not a new file format: `Home.canvas` at the vault root carries a file card per pipeline, and compile() already returns every file card\'s path, so discovery costs no new code and adds no second thing to keep in sync. Proved on 2026-08-21 against a Home board holding two pipeline cards and a four-step maintenance chain — both came back from one compile, the branch conditions intact, the board unchanged on disk. That board is also a pipeline in its own right, whose job is keeping the others honest from the inbox. Still partial for two honest reasons: no Home.canvas ships yet, so there is nothing to find until someone draws one, and `.canvas` files are not graph nodes (list() and graph() index .md only, measured the same day), so a note linking to a board reaches the note but the board is not in the graph.',
      },
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
      { label: 'Agents that read, write, and act on the vault', status: 'planned', surface: 'ribbon:terminal', note: 'All five claude:* channels are implemented, and each turn runs in its own OS process so one crashing cannot take the app or the other sessions down. Still planned because the agent can only READ: the tool list is hard-coded to Read/Glob/Grep in claude.ts, so it cannot yet write or act on the vault.' },
      { label: 'Contextual retrieval, not just keyword search', status: 'planned', surface: 'ribbon:search' },
      { label: 'Autonomous organization and curation', status: 'planned', surface: 'Inbox tab', note: 'The Inbox already shows agent-proposed filing; nothing acts on it.' },
    ],
  },
  {
    title: 'Bookmarks',
    features: [
      {
        label: 'Bookmark notes, shared with Obsidian',
        status: 'built',
        surface: 'ribbon:bookmarks',
        note: 'Stored in the .obsidian/bookmarks.json that Obsidian itself uses rather than a second list, so a bookmark made in either program shows in both. Writes re-read the file and save under its mtime, so a concurrent Obsidian write raises a conflict instead of dropping what it added. Saved searches and graph bookmarks are preserved and shown, but only files open from here. The honest gap: a RUNNING Obsidian rewrites that file from memory, so a bookmark added while it is open can be overwritten by it.',
      },
    ],
  },
  {
    title: 'Daily practice',
    features: [
      {
        label: 'Daily notes with a month calendar',
        status: 'built',
        surface: 'ribbon:calendar',
        note: 'Reads Daily/YYYY-MM-DD.md off the vault tree rather than a configured format, marks the days that have notes, and creates a missing day from Daily/_Template.md following the instruction that template itself carries. Dates are local, so a note written late in the evening is not filed as yesterday. Not built: a template picker, or any format other than the one this vault uses.',
      },
    ],
  },
  {
    title: 'Nice to haves',
    features: [
      {
        label: 'Customisation — users building things nobody shipped',
        status: 'planned',
        surface: 'ribbon:canvas',
        note: 'The competitor evidence is people turning Notion into things it was never sold as, an RPG that awards XP for finished work being the example that prompted this. What that person actually used was properties, formulas, and a gallery view — no code. The answer here is NOT a JS plugin API: the renderer runs default-src \'none\', a plugin sandbox would be a real security regression rather than a config change, and a third-party plugin ecosystem is also the biggest supply-chain risk Obsidian carries. THE CANVAS IS ALREADY THE CUSTOMISATION SURFACE. It is a file, so an agent can rewrite it; it is spatial and colour-capable, so it can look like anything; and it renders without executing anyone\'s code. An RPG dashboard here is a board an agent updates — XP is a card whose text gets rewritten, the quest log is a group, inventory is file cards. That needs no new API and no new attack surface. Two things genuinely block it. Media cards are refused by the renderer CSP (see docs/canvas-backlog.md item 17), and a dashboard with no art is a spreadsheet. And nothing triggers a pipeline on a schedule or an event, so every update has to be asked for by hand, which is exactly the maintenance burden that killed tags.',
      },
      { label: 'API / plugin ecosystem', status: 'planned', surface: 'ribbon:plugins', note: 'Kept on the list because it is what people ask for, but the entry above is the position: the agent is the plugin system and the canvas is the render target. Building a JS plugin host would be choosing Obsidian\'s supply-chain risk on purpose.' },
      { label: 'Web clipper', status: 'planned' },
      { label: 'Version history', status: 'partial', surface: 'Versions tab', note: 'The Versions tab lists every pre-edit copy in .backups/ for the open note, newest first, previews one, and restores it THROUGH save() so the lost-update guard and the backup-before-overwrite still apply. Both on-disk layouts are listed — the new mirrored one and the retired note server\'s flat one. The gap is that it has not been watched running yet: verified by test/versions.test.mjs against the real data layer, not by a human opening the tab. No pruning either — the history is still unbounded.' },
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
