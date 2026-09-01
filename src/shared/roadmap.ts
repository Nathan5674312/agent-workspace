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
        status: 'built',
        note: 'THE PREVIOUS NOTE WAS FALSE. It said "saving still calls a local HTTP server"; there is no local HTTP server and there has not been since `a826753`. Measured 2026-08-26: nothing under `src/` calls fetch, axios, XHR, WebSocket, `http.request` or `createServer` — the grep is empty — and the only two runtime dependencies are the Claude agent SDK and an icon set. Saving is `writeFileSync` to a temp file then `renameSync` over the target, so a crash mid-write cannot truncate a note. The renderer could not reach the network even if something tried: `index.html` ships `connect-src \'none\'` under `default-src \'none\'`, which the browser enforces rather than the code promising. THE ONE HONEST CAVEAT, and it is not the app: `claude.ts` spawns the user\'s OWN installed CLI, which talks to whichever provider that user already pays for — their binary, their credential, their network call, on the same footing as the app opening a file they chose. Pull the plug and every local feature still works: read, edit, save, graph, database, canvas, versions, bookmarks, daily notes, block references.',
      },
      {
        label: 'Usable with zero agent support',
        status: 'planned',
        note: 'The honest state on 2026-08-26: the author could not set up this vault without agents driving the app for him. That is the whole entry. Everything this roadmap calls built is built for someone who already knows where it is — a first run hands you a window and no path from there to a working vault, so the setup an agent currently performs (choose a root, seed the structure a board and a database expect, explain what each pane is for) has no unassisted equivalent. Filed under table stakes rather than polish deliberately: an app that needs an agent to become usable has a floor of one AI subscription, and the local-first claim above is only true for people who can clear it. Moves to partial when a cold install reaches an editable note with no agent involved, and built when someone who has never seen the app does it unaided.',
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
        label: 'Databases with views (table, kanban, gallery)',
        status: 'built',
        surface: 'Database tab',
        note: 'Three views over one row set: table with filter, sort and group-by over frontmatter; board and gallery as groupings of the same rows. Kanban is the board, renamed. THERE WERE FOUR — the calendar moved out to the Planner, where it merged with the daily notes it could never show. It was the one view that was not a re-rendering of the same groups: it needed `updated` as a real day, and the useful gesture on an empty day is to WRITE that day, which is authoring rather than querying. Undated notes came with it as a deliberate omission: the calendar used to list everything it could not place, because a database view must account for every row it was handed, and most of this vault has no usable date. The planner is not accounting for rows, and the table still shows every note. ~~Not built: editing a value from a cell, which would need the lost-update guard from the save path somewhere a cell cannot show it.~~ BUILT 2026-08-27, and the reason it was not is worth keeping because it was half wrong. The guard is real and is untouched; "somewhere a cell cannot show it" was the mistake, since VersionsView already reports a SaveConflict inline without opening the conflict dialog, which is about the edit buffer and has nothing to offer a cell. Type and Status are now editable and write `type:`/`status:` into the note\'s own Markdown through the same `save()` as the editor, so a property edit keeps a pre-edit copy in `.backups/` and runs the same lost-update check. Clicking a cell opens a text field with a <datalist> of the values already in use — a datalist rather than a select because `status` is a convention in these notes and not an enum, so a picker offering only existing values could never write the first note of a new status. ENTER COMMITS AND ONLY ENTER: `review-s2-vault-pane` hard-fails on `onBlur=` anywhere in this pane and that guard was left alone, so which cell is open is state on the table instead — opening one closes another, which is what stops two inputs being open across 258 rows. REFUSES rather than merging when the row is the note open in the editor with unsaved edits, because both texts are legitimate and nothing can know which was meant; the cell shows why, naming the note. WATCHED RUNNING 2026-08-27 over CDP with real mouse and key input against a throwaway scratch vault, checking the FILE and not just the table: `status: draft` became `status: shipped` with the rest of Alpha.md byte-identical; a `type:` key the note did not have was appended to the end of its block rather than the top, where `title` belongs; a note with NO frontmatter at all grew a block with its `# Gamma` heading and body intact below; clearing a value deleted the whole `type:` line rather than leaving a blank one; Escape wrote nothing; each write left exactly one copy in `.backups/`; and with Alpha open and dirty in the editor the same edit was refused with the file unchanged (md5 identical either side) and the cell marked. The conflict path itself is narrow by design — the mtime handed to save() is from a read moments earlier, not the row the table drew, because the table can be minutes stale and using its stamp would raise a conflict on nearly every edit and teach the user to ignore the one that mattered. Still not editable, each for a reason: Area is derived from the folder so moving the note IS the edit, Links and Backlinks are the body\'s wikilinks, Updated is a stamp, and Tags is a list that `setFrontmatter` will not write because this vault contains both list spellings and picking one would rewrite the other.',
      },
      { label: 'Multi-hop lookup and rollup columns', status: 'planned', surface: 'Database tab' },
      {
        label: 'Tags that form without anyone maintaining them',
        status: 'partial',
        surface: 'Database tab',
        note: 'Measured against the author\'s own vault on 2026-08-21, which is the whole argument for this entry: of 1999 notes, `tags:` appears on 131, `area:` on 96, `title:` on 96, `type:` on 90, `updated:` on 70 and `status:` on 56. Six conventions tried, every one stalled around 5%. Hand-maintained metadata does not survive contact with use, so a nicer tag input fails the same way. Inline #hashtags are worse than useless here without excluding code blocks first — the top matches in this vault are #endif, #include, #FFFFFF and #F59E0B, which are preprocessor directives and hex colours. TWO MECHANISMS, and conflating them is the trap. DERIVED facets are computed from what is already true — folder, link neighbourhood the graph already builds, date, filename series — cost nothing, need no model, are never wrong and never need approving, and have 100% coverage by construction. INFERRED tags are semantic, need an agent, can be wrong, and belong in the Inbox as proposals a human confirms. Ship the derived ones as a fact of the data; make the inferred ones a pipeline. THE DERIVED HALF IS BUILT — `shared/facets.ts`, pure and tested, deriving folder (every ancestor, so a filter sits at any depth), date (from the FILENAME only, never mtime, which a checkout or a sync rewrites), shape (orphan and hub only, hub being the top tenth of this vault rather than a fixed count that would be wrong at either end), and about (the folder a note\'s neighbours live in when it is a different branch of the tree). Run over the real vault: 463 of 465 notes carry at least one facet against 131 with a hand-written tag, and every facet explains itself in words. Running it there also caught a defect no unit test would have — half the `about` facets were of the form "this note in Fate/Barbershop is about Fate", which is true and is exactly what the folder facet already said; ancestors and descendants are now suppressed. They are now READ: the Database tab carries a Facets column and a Group-by → Facet, which is the only way to see a facet nobody typed. The threshold is hoisted out of the per-row path — facets() defaults it to hubThreshold(degrees), which sorts the whole array, so calling it per row was 465 sorts of a 465-element array for one unchanging number. The graph is optional there and its failure is not the table\'s: without it a note still has folder and date, so a graph that will not build costs the shape and about facets rather than the view. Watched working on 2026-08-23 against 481 rows — folder on 462, about on 27, shape on 23, date on 21 — with each cell\'s hover naming every facet and explaining it, because TAG_CAP is 2 and a truncated list that cannot say what it hid is a promise broken silently. Still partial for one honest reason: the inferred half does not exist. Nothing proposes a semantic tag, and that belongs in the Inbox as a proposal a human confirms rather than in this column.',
      },
      { label: 'Linked / relational databases', status: 'planned', surface: 'Database tab' },
      {
        label: 'Templates',
        status: 'built',
        surface: 'Explorer header',
        note: 'A chevron beside "+ Note" lists `Templates/` and creates a note seeded from the one picked. NOTHING WAS INVENTED: the folder predates the app and holds five templates, so this is wiring rather than a format. A SPLIT BUTTON, not a menu replacing "+ Note" — making the existing control a menu would cost every empty-note use a second click, and the empty note is the common case the button is named after. The chevron is absent, not disabled, in a vault with no `Templates/`: a trigger opening a panel with no rows is the same lie as a dead button. TEMPLATES ARE COPIED VERBATIM, which is the whole transform and is the one thing that looks like it should share code with `daily.ts` and must not. `Daily/_Template.md` is a document ABOUT a template — heading, instruction, `---`, then the thing to copy — so `noteFromTemplate` splits on the first `---` and keeps the tail; a file in `Templates/` IS the template, and that same split would eat its opening fence and leave `title:` in the body as prose. The `<angle bracket>` placeholders are left alone, being the author\'s own "fill this in" marker rather than something an app should guess at. Two rules read off the vault: direct children only, and `_`-prefixed files are not templates, which keeps `Templates/_Index.md` — a document about the folder — from creating a note that is an index of templates. Naming and the write door are shared with `handleNewNote` deliberately: `nextUntitledPath` and `save()` with mtime 0, so no second naming rule and no second place to keep the lost-update guard correct. The template body is fetched with `readNote` rather than carried in the tree, so a template deleted between the menu opening and a row being clicked fails on the READ, before anything is created. WATCHED RUNNING 2026-08-31 over CDP with real dispatched mouse input against a throwaway scratch vault, checking the FILE and not just the editor: the chevron sat flush against "+ Note", a real click opened the popover (an `element.click()` would not have — the popover is a platform activation behaviour), the menu listed Project and Research with `_Index` correctly absent, clicking Project closed the menu and opened a new note whose bytes were md5-identical to `Templates/Project.md`, and a second vault with no `Templates/` folder rendered "+ Note" with no chevron at all. 8 assertions in test/templates.test.mjs, the last of which runs against the real vault\'s own five templates and asserts every one opens with frontmatter — the fact that makes the verbatim rule necessary. NOT built: placeholder substitution, a template picker for the daily-note path, and per-folder templates. All three are additive.',
      },
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
      {
        label: 'Block-level references',
        status: 'built',
        surface: 'Editor tab',
        note: 'OBSIDIAN\'S SYNTAX, NOT A NEW ONE, and that is the whole decision — this folder is a live Obsidian vault, so `{#id}` or Logseq\'s `id:: <uuid>` would put a line in every note that the other daily reader of these files renders as visible junk. So: ` ^id` at the end of a line or alone on its own line, `[[Note#^id]]` to point at it, `[[Note#Heading]]` for the cheaper form, and latin letters, numbers and dashes as the legal characters. The parser was already HALF of this and nobody had noticed: `WIKILINK` matched `(?:[#|][^\\]\\n]*)?` and threw the capture away, so a block reference written in Obsidian already resolved here, coarsely, to the whole note. It now captures target, fragment and alias as three groups, and `parseWikilinks` still returns exactly what it returned before, because the graph counts edges with it. Resolution is `shared/blockref.ts`, pure and framework-free: `^` is the entire discriminator between a block id and a heading, `[[Note#A#B]]` lands on the deepest segment, and an address that matches nothing returns null rather than falling back to line 0 — the failure that would look identical to success. Reading happens against the text the pane already holds, so nothing was added to the main-process index. Writing is one button: "Copy block ref" marks the caret\'s line, puts `[[Note#^id]]` on the clipboard, and is idempotent, so pressing it twice on one paragraph cannot leave two ids. Two rules it does NOT inherit from Obsidian — a new id is checked against every id already in the file (Obsidian permits duplicates and silently resolves to the first), and a table, quote, callout or code-fence line is REFUSED rather than given an id Obsidian could not follow. The marker lands in the BUFFER, under the same Save button, mtime guard and backup as any typed edit; an id appearing in a file the user never saved would be the feature editing the vault behind them. Watched working on 2026-08-26 against a scratch vault: the Links list showing six links with their fragments (including a same-note `[[#Heading]]` rendered as "this note"), a block reference scrolling to and selecting the cited line, a heading reference selecting the heading, `#^nope` reporting "Nothing in this note is marked #^nope" instead of guessing, a quote line refused with "Obsidian cannot link into a quote or callout", and `^4ct30w` on disk after Save. 30 assertions in test/blockref.test.mjs. NOT built: drift detection (a hash of the cited line, to mark a reference "changed since you cited it") and block-typed graph edges. Both are additive and neither is load-bearing; the roadmap note ranks them after search.',
      },
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
        note: 'The index is a board, not a new file format: an index board at the vault root carries a file card per pipeline, and compile() already returns every file card\'s path, so discovery costs no new code and adds no second thing to keep in sync. `pipelines()` in shared/pipeline.ts is the whole mechanism — one filter over a compiled plan, pure, so a CLI agent, the app and the test get the same answer. It hands back Steps rather than paths, because the arrows around those cards mean what they always mean: an index that says "ingest, then publish, but only if anything landed" is an ordinary board and keeps meaning that. Not recursive on purpose; boardTree already owns the recursive form and its cycle guard. THE GRAPH GAP IS CLOSED. `.canvas` files were indexed by nothing, so a note saying [[Home.canvas]] resolved to no target and the one kind of file that describes how work gets done was the one kind the vault could not draw. Boards now join the index on the `text: false` path images already use — indexed, never READ, which keeps the reason they were excluded (parsing JSON for wikilinks would turn every quoted string on a card into an edge) while giving up the exclusion that was collateral. They register under the full filename, so [[Home.canvas]] finds the board and [[Home]] still means Home.md, which matters because pickRoot measures reachability from it. Measured against the author\'s own vault on 2026-08-24: 469 nodes against 467, Canvas.canvas and Home.canvas both present and both attached by a structural edge to Home.md, zero content edges out of either. Home.canvas compiles to 7 steps, runnable, 0 problems. THE TWO NAMES ARE NOW ONE. ROOT_BOARD in shared/canvas.ts said `Main.canvas` while the vault, this entry and the run-a-board skill all said `Home.canvas`, so the app headed the author\'s real index board "No Main.canvas yet" while an agent following the skill opened it and found the pipeline. Home wins on a 3-to-1 count and because it matches `Home.md`, which pickRoot and INDEX_NAMES already treat as the root of the other half of the vault. Still partial for the one reason no code can fix: nothing points at a pipeline yet. pipelines() returns [] on that vault because the index board holds a maintenance chain and no file cards. That is the honest "there are none yet" rather than a failure — but until somebody drags a board onto Home.canvas there is still nothing to find, and a mechanism proved against a fixture is not the same as a mechanism proved against a real index.',
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
      {
        label: 'Watch what agents are doing, live',
        status: 'partial',
        surface: 'Top-right activity panel',
        note: 'THE SOURCE IS THE POINT. The first design had agents announce themselves into a log, which was wrong for one reason: anything an agent writes about itself it can omit, so the display would show what an agent chose to admit. Claude Code already appends a transcript per session, and THE HARNESS WRITES IT, not the model — the guarantee is not honesty but completeness, since a model cannot call a tool without the call appearing. shared/transcript.ts parses those lines; main/activity.ts tails every Claude config directory on the machine (this one has two accounts, deliberately) from a saved byte offset, because one session here is 44 MB and re-reading it on a timer is not viable. Two privacy boundaries are enforced in the PARSER rather than trusted to the view: tool metadata only, never message text or thinking or tool results, because a transcript holds whole conversations; and a shell command reduced to program and subcommand, never its arguments, because those carry tokens and a status panel will eventually be on screen during a recording. That second rule was first written as "everything up to the first flag" and a real transcript disproved it within a minute — cd "C:/Users/.../scratchpad" put a filesystem layout on screen, because a quoted path is not a flag. The panel is top-right and ambient, deliberately NOT the bottom-right consent corner, whose founding rule is that silence is the default; an activity feed is constant by nature and merging the two would spend the consent surface silence on status updates. It renders nothing at all when no agent is running, so an ordinary notes user never meets the agent layer. GAP: it reports what an agent DID, not what it intends. Pipeline steps can say what is next because run.ts knows; freeform reading cannot, and guessing would be presenting a prediction as a fact. WHERE, as well as what: each card carries a mini map — shared/agentTrail.ts — showing the vault graph framed on the notes the agent is using, with the walked links lit and flowing and the surrounding notes dim around them. It is the graph ZOOMED, not a diagram assembled from the visited notes; the first version laid them on an ellipse of their own and looked nothing like the graph view, so this one brings a hop of neighbourhood and runs the same kind of force layout. It will not draw an edge the vault does not have: a move between two unlinked notes is real, so it is shown as a dotted jump rather than as a connection that does not exist. The open and close behaviour Nathan asked for turned out to be ONE rule — the trail is built only from activity inside a 60s window, so an agent that never came here has nothing to draw and an agent that left and kept working ages out of it, with no "was it ever open" flag to fall out of sync. Watched working on 2026-08-24: two lit notes with the travelled edge dashed between them, four of six context notes inside the frame, and the rest cropped by the camera.',
      },
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
        label: 'Planner — daily notes and the calendar, one page',
        status: 'built',
        surface: 'ribbon:calendar',
        note: 'ONE PAGE, TWO FEATURES, and they are deliberately not merged. The calendar is the view that used to be the database’s fourth mode, moved here unchanged: every note placed on the day its `updated:` claims, `parseYmd` refusing anything that is not an ISO day rather than guessing, the notes it cannot place listed under the grid rather than dropped — most of this vault has no usable date — and a jump to a month that has something in it. The daily notes stay in the sidebar, where they were: Daily/YYYY-MM-DD.md read off the vault tree, days that have notes marked, a missing day created from Daily/_Template.md following the instruction that template itself carries, dates local so an evening note is not filed as yesterday. THEY WERE MERGED ONCE AND IT WAS WRONG: rendering each day’s daily note inside that day’s calendar cell made a view over the whole vault into a writing surface for one folder, and put a create-this-day button on every empty day in the vault’s history. They read dates out of different places and answer different questions; they share a screen — the icon opens the calendar in the main area and leaves the notes in the sidebar — because that is where you look for either. The database is down to three views and honest about it: table, board and gallery genuinely are the same rows three ways, which a calendar over `updated:` never was. Not built: a template picker, any filename format other than this vault’s, week or day zoom levels, and any link between the sidebar picker’s month and the calendar’s.',
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
      { label: 'Version history', status: 'partial', surface: 'Versions tab', note: 'The Versions tab lists every pre-edit copy in .backups/ for the open note, newest first, previews one, and restores it THROUGH save() so the lost-update guard and the backup-before-overwrite still apply. Both on-disk layouts are listed — the new mirrored one and the retired note server\'s flat one. WATCHED RUNNING 2026-08-26, against the author\'s real vault, which closes most of the old "not watched yet" gap: the empty state on a note with no history reads "No earlier versions. One is kept every time this note is saved."; opening `Fate/Roadmap/00 - INDEX.md` retitles the panel and lists its one version as 8/19/2026 9:06:14 PM · 9390 bytes; selecting it previews the whole earlier text, visibly older (frontmatter `updated: 2026-08-17`, and a notes table that stops at row 02 because 03 onward did not exist yet); and the Restore control is present and says what it will do — "Saves this text over the note. The current text is backed up first." That also exercised the MIRRORED layout, since that backup lives at `.backups/Fate/Roadmap/`. THE FINDING THAT MATTERS MORE THAN THE UI: of 167 backups in that vault, 166 are `.canvas` and exactly ONE is a note. `backup()` runs inside `save()`, so a note edited in Obsidian never makes one — which means version history is effectively empty for anyone who edits their vault anywhere but here, and Home.md, the obvious note to test with, has no history at all. RESTORE IS NOW WATCHED TOO — 2026-08-27, in a throwaway scratch vault rather than a real one, so the single write path ran for real with nothing at risk. Source.md went 700 → 692 bytes and came out byte-identical to the version restored; the `^4ct30w` block id that existed only in the newer text was gone; and the promise on the button held, in that a fresh backup appeared holding the exact pre-restore 700 bytes (md5 7d9ed4cb…, the pre-restore file hash). Afterwards the panel listed both versions newest-first and a freshly opened editor showed the restored text. Still partial for one reason now: there is still no pruning, so the history is unbounded. NAVIGATION DEAD-END FOUND WHILE DOING IT AND NOW FIXED, and it was never specific to this feature. <MainCanvas> inferred "bring the editor forward" from the OPEN PATH CHANGING, so re-opening the note already open was not a path change and fired nothing: with the Versions panel up, double-clicking that note in the tree left you on the panel, and so did the back arrow. Opening a DIFFERENT note always worked, which is why it read as intermittent. The planner was the same. The switch now happens at the navigation instead — openNote and the two arrows in VaultPane.tsx — and the path-keyed effect is gone. WATCHED RUNNING 2026-08-27 over CDP with real mouse input (Input.dispatchMouseEvent; el.click() is useless here because the tree reads e.detail to tell one click from two), in a throwaway scratch vault under its own --user-data-dir. Same script on the pre-fix build: stuck on versions at step 3, stuck on the planner at step 7, stuck at the back arrow at step 9. On the fixed build all three land in the editor with the note text on screen. Deleting that effect fixed two more things it was causing: a tab parked on the Versions view was reset to the editor as soon as you switched to it (measured both ways — pre-fix vault-editor, post-fix vault-versions), and in split both canvases collapsed onto the editor because they see the same note. Minor: versions.ts:28 explains the displayed time as "the moment the backup was taken" because copyFileSync does not preserve times; measured on that file, mtime (8/19 21:06) and the filename stamp (8/22 06:08Z) are two days apart, so the label is really the note\'s own prior mtime. The panel\'s own wording — "the note as it was before one save" — matches what is shown; the comment does not.' },
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
