/**
 * THE CONTRACT between main and renderer. Every pane depends on this file.
 *
 * Rules, non-negotiable:
 *  - The renderer has NO node integration and NO network access to the vault.
 *    Everything crosses this boundary. If a pane needs data, it goes here first.
 *  - Channel names are namespaced by pane so ownership is obvious.
 *  - Mutation is gated on WHO is acting, not on WHAT is touched. A
 *    user-originated call proceeds with no prompt: the person clicked or
 *    typed, so they ARE the consent, and asking them to approve saving the
 *    file they are typing is approval fatigue, not safety — it trains people
 *    to click through, which is worse than no prompt at all. An AGENT-
 *    originated call is gated: it goes through the agent corner and does not
 *    happen until a human answers. `Actor` below says which one it is, and
 *    src/main/consent.ts is where that decision is made.
 *  - This boundary separates the two for free, which is why the rule can be
 *    enforced rather than merely stated: everything arriving over IPC came
 *    from the renderer, and the renderer has no agent in it. An agent is
 *    main-process code calling src/main/vault.ts directly, so it can never
 *    reach a handler here and can never pose as a user by crossing the bridge.
 *  - Anything that touches the NETWORK is gated regardless of actor.
 */

// ---------------------------------------------------------------- vault (pane 2)

export type VaultNote = {
  /** Vault-relative, forward slashes. e.g. "Business/Claude Code Extension/_START HERE.md" */
  path: string
  title: string
  /**
   * The note's mtime in milliseconds (`fs.Stats.mtimeMs`), as read()
   * observed it. Required for the lost-update guard on save, which compares it
   * against a fresh stat — pass back exactly what read() gave you, unrounded.
   */
  mtime: number
}

export type VaultNoteBody = VaultNote & { text: string }

export type VaultTreeNode = {
  name: string
  path: string
  /**
   * `canvas` is a SEPARATE kind from `note`, not a note with a different
   * extension, and the distinction is load-bearing in two places.
   *
   * `buildIndex` collects `kind === 'note'` to decide what to READ, parse for
   * frontmatter and resolve wikilinks in. A `.canvas` file is JSON, so reading
   * it as a note would let every quoted string on a card resolve as a link.
   * Giving it its own kind means it skips the read by construction rather than
   * by a second extension check.
   *
   * It is still INDEXED, which is a different question and was conflated with
   * that one until now. A board is a node in the graph and a row in the
   * database, sharing the `text: false` path with images — see `scan()`. Being
   * excluded outright is what made the vault's pipelines the one kind of file
   * the graph could not draw.
   *
   * `file` is anything that is NOT text: an image, an archive, an executable.
   * These are listed and indexed as rows — a folder of photographs should show
   * its photographs rather than look empty, which is what happened when the
   * explorer admitted `.md` alone — but they are never read as text and never
   * opened in the editor, because a <textarea> round-trip through a PNG
   * corrupts it. The editor refuses them by KIND rather than by re-deriving the
   * extension, so there is one answer to "is this editable".
   */
  kind: 'folder' | 'note' | 'canvas' | 'file'
  children?: VaultTreeNode[]
}

/**
 * One pre-edit copy of a note, from `<vault>/.backups/`.
 *
 * There is no `text` here on purpose: a note with a long history would send its
 * whole past over the bridge to draw a list of dates. The body is fetched for
 * the one version being previewed, by `versionText(id)`.
 */
export type NoteVersion = {
  /**
   * The backup's path relative to `.backups/`, forward slashes. Opaque to the
   * renderer — the only valid thing to do with it is hand it back to
   * `versionText()`. Not a vault path and not openable as a note.
   */
  id: string
  /** When the copy was taken, ms since epoch. Comparable to `VaultNote.mtime`. */
  at: number
  /** Bytes on disk. Shown because a 0-byte version is worth seeing before restoring it. */
  size: number
}

/**
 * One completed move, as `<vault>/.trash/moves.jsonl` recorded it.
 *
 * Hold on to `id`: it is the only handle `undoMove()` accepts, and it is what
 * makes an agent's filing reversible after the app has been restarted. The
 * trash path the original went to is deliberately NOT here — the renderer has
 * no business naming a file inside `.trash/`, and the journal already knows.
 */
export type MoveRecord = {
  id: string
  /** Where the note was, vault-relative. Where `undoMove()` puts it back. */
  from: string
  /** Where it is now, vault-relative. */
  to: string
  /** When the move happened, ms since epoch. */
  at: number
}

// ------------------------------------------------------------------ terminal

/**
 * One live agent process, as the supervisor sees it.
 *
 * `pid` is the point of the whole record: it is what makes "each agent is its
 * own process" checkable by the user in Task Manager rather than a claim they
 * have to take on faith.
 */
export type AgentProcess = {
  sessionId: string
  pid: number | null
  startedAt: number
  status: 'starting' | 'running' | 'awaiting-permission'
  rss: number | null
  heapUsed: number | null
}

/** How an agent process ended. `crash` is the one worth surfacing loudly. */
export type AgentExit = {
  sessionId: string
  reason: 'done' | 'failed' | 'killed' | 'crash'
  code: number | null
  message: string
  at: number
}

/**
 * The outcome of a shell command.
 *
 * `denied` is separate from `ok` on purpose: a refused command and a failed one
 * are different events, and collapsing them would let the panel print "command
 * failed" at someone who declined it themselves.
 */
export type ShellResult = {
  ok: boolean
  denied: boolean
  code: number | null
  stdout: string
  stderr: string
}

/** One edge of the graph view. Derived from [[wikilinks]], never authoritative. */
/**
 * `kind` distinguishes an edge somebody WROTE from one the folder tree implies.
 *
 * `content` is a [[wikilink]], a markdown `[a](b)`, or a path mentioned in the
 * text — a real assertion by the author that two files are related.
 *
 * `structure` is derived from where the files SIT: each file to its folder's
 * index, each index to its parent's. It exists because most folders on a
 * machine are not vaults and contain no links at all — a folder of photographs
 * or of `hosts`/`lmhosts.sam` can never produce a content edge, and rendered
 * without these the graph is a field of unconnected dots. Measured before they
 * existed: `Pictures` 26 notes / 0 links, `System32\drivers\etc` 5 / 0,
 * `Documents` 2 / 0.
 *
 * Kept SEPARATE rather than folded in, because `orphan`, `depth`, `links` and
 * `backlinks` are all still counted from `content` alone. A note nobody links
 * to is still an orphan — the Orphans filter and the "How linked" grouping keep
 * meaning exactly what they meant — it is merely no longer stranded on screen.
 */
export type VaultLink = { from: string; to: string; kind?: 'content' | 'structure' }

export type VaultGraph = { nodes: string[]; links: VaultLink[] }

// ------------------------------------------------------------------- settings

/**
 * Appearance overrides.
 *
 * Every field's `'system'` means NO override: the renderer sets no attribute at
 * all, so the `@media (prefers-reduced-transparency: reduce)` /
 * `(prefers-reduced-motion: reduce)` blocks already in app.css keep running
 * untouched. That is the whole design — the OS preference is the default and
 * this is an escape hatch on top of it, never a replacement for it.
 *
 * CONTRAST HAS NO FIELD HERE, and its absence is the design rather than an
 * omission. `@media (prefers-contrast: more)` in app.css is untouched and still
 * does the whole job for anyone whose OS asks for it — appearance.test.mjs
 * asserts that media query is still present. What was removed is the in-app
 * duplicate of it, which was a second copy of the same hex values maintained by
 * hand in appearance.css and free to drift from the ratios docs/ACCESSIBILITY.md
 * commits to.
 */
export type Appearance = {
  /** `'reduced'` mirrors `@media (prefers-reduced-transparency: reduce)`. */
  transparency: 'system' | 'reduced'
  /** `'reduced'` mirrors `@media (prefers-reduced-motion: reduce)`. */
  motion: 'system' | 'reduced'
  /** False sets `--canvas-art: none`. */
  artwork: boolean
  /** Overrides `--canvas-art-opacity`. 0 to ARTWORK_OPACITY_MAX. */
  artworkOpacity: number
}

/**
 * The ceiling on the artwork slider, and it is not arbitrary: tokens.css says
 * the palette's contrast ratios were measured against a flat Ink ground, so
 * anything above ~0.20 lightens that ground and erodes every measured ratio in
 * the app. The slider stops here and main.ts clamps to it, because a value that
 * arrives from disk has not been through the slider.
 */
export const ARTWORK_OPACITY_MAX = 0.2

/** Matches tokens.css: artwork on at `--canvas-art-opacity: 0.16`. */
export const DEFAULT_APPEARANCE: Appearance = {
  transparency: 'system',
  motion: 'system',
  artwork: true,
  artworkOpacity: 0.16,
}

/**
 * The approvals policy, as it crosses the bridge.
 *
 * The REASONING for this shape — why there is no 'off', why an expired prompt is
 * a refusal and never an approval — lives with the gate that enforces it, in the
 * docblock above `ApprovalsPolicy` in src/main/consent.ts. Read that before
 * changing this. What matters here is only that nothing arriving over this
 * boundary is trusted: `setApprovalsPolicy()` normalises both fields, so an
 * unrecognised mode becomes 'manual' (still gated) rather than something that
 * asks less, and this type is a description of the wire, not a guarantee about it.
 */
export type Approvals = {
  /** 'strict' never grants or spends a session allowance — every op is asked. */
  mode: 'manual' | 'strict'
  /** How long an unanswered prompt may sit before it is DENIED. Undefined: forever. */
  timeoutMs?: number
}

/** What an install that has configured nothing gets: today's behaviour, exactly. */
export const DEFAULT_APPROVALS: Approvals = { mode: 'manual' }

/**
 * App settings: the vault folder, plus the appearance overrides.
 *
 * The renderer never sends a path across this boundary — `pickVaultDir()` opens
 * the OS folder picker in the MAIN process and returns the result. A settings
 * call that accepted an arbitrary renderer-supplied directory would be a way to
 * point the app's file reads anywhere on disk. `setAppearance()` carries no path
 * and nothing it accepts can name a file, which is why it may take an argument.
 */
export type AppSettings = {
  /** Absolute path of the vault root the running app is actually using. */
  vaultDir: string
  /**
   * A folder chosen for next launch, when it differs from `vaultDir`. Null when
   * there is nothing pending — a vault change applies on restart, never live.
   */
  pendingVaultDir: string | null
  /**
   * The startup vault-root mismatch warning from `vault.checkRoots()`, or null
   * when the roots agree or the question could not be answered. Read-only
   * diagnostic: it is recorded at boot, not recomputed per read.
   */
  rootMismatch: string | null
  /** Always present and always complete — main fills every field from defaults. */
  appearance: Appearance
  /**
   * Always present. Read back from the GATE, not from the settings file, so what
   * is shown is what is actually in force after normalisation — a hand-edited
   * `mode: "off"` reads back as 'manual', which is what it will behave as.
   */
  approvals: Approvals
}

// ------------------------------------------------------------- claude (pane 1)

export type SessionId = string

export type Session = {
  id: SessionId
  title: string
  /** Project scope this session is bound to (absolute path). */
  cwd: string
  status: 'idle' | 'running' | 'awaiting-permission' | 'error'
  updatedAt: number
}

export type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; content: string; isError?: boolean }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
  at: number
}

export type PermissionMode = 'ask' | 'accept-edits' | 'bypass'

// ---------------------------------------------------- agent corner

/**
 * WHO is asking for a mutation. Every mutating call in src/main/vault.ts takes
 * one, and none of them has a default.
 *
 * A default is the one thing this must never grow. `actor` forgotten at a call
 * site would quietly become `{ kind: 'user' }` — the gate would fail OPEN, and
 * it would do so invisibly, which is the precise failure this whole mechanism
 * exists to prevent. Missing or malformed is REFUSED instead; see consent.ts.
 *
 * This never crosses the bridge. There is no channel that accepts an Actor and
 * the renderer cannot construct one: src/main/ipc.ts supplies `{ kind: 'user' }`
 * itself, on the grounds that a call arriving over IPC came from the renderer
 * and the renderer has no agent in it. An agent runs in MAIN and calls vault.ts
 * directly, so it is the only caller that has to declare itself.
 */
export type Actor =
  | { kind: 'user' }
  | {
      kind: 'agent'
      /**
       * Which agent session is acting. Session-scoped allowances are keyed by
       * it, so it is also the thing that stops one session inheriting another
       * session's permission. Must be a non-empty string.
       */
      sessionId: string
      /**
       * Why this is happening, as a sentence a human can judge. Shown verbatim
       * in the consent prompt, and REQUIRED: an agent that cannot say why it is
       * moving a file does not get to move it. Empty or whitespace is refused.
       */
      reason: string
    }

/**
 * Everything the corner can show. `consent` items BLOCK until answered;
 * `artifact` and `notice` items are informational.
 */
export type CornerItem =
  | {
      kind: 'artifact'
      id: string
      /** e.g. "Skill created" */
      title: string
      /** Absolute path on disk. The corner is a VIEW of this, never the only copy. */
      file: string
      body: string
      /** Pulled out for the summary strip. */
      keyPoints: string[]
      at: number
    }
  | {
      kind: 'consent'
      id: string
      title: string
      /** Plain sentence: what is about to happen, to which device, over which network. */
      detail: string
      severity: 'info' | 'warn'
      /** Present when the action crosses the network. */
      network?: NetworkTrust
      at: number
    }
  | { kind: 'notice'; id: string; title: string; detail: string; at: number }

/**
 * A human's answer to one consent.
 *
 * `scope` is how "allow, and stop asking me for this run" is said. It is
 * OPTIONAL and its absence means 'once', so the renderer — which does not send
 * it, and which this change does not touch — keeps exactly its current
 * meaning. Only 'session' widens anything, and only for the one sessionId and
 * operation kind that was on screen when the human answered.
 *
 * Nothing here is written to disk. Allowances live in memory in
 * src/main/consent.ts and die with the process, so a restart always re-asks.
 */
export type ConsentDecision = { id: string; allow: boolean; scope?: 'once' | 'session' }

/**
 * Network trust. `trusted` is NOT the OS public/private flag — that is user-set and
 * frequently wrong. It means: this network's fingerprint is in our own trust store
 * because a human marked it trusted in-app.
 */
export type NetworkTrust = {
  ssid: string | null
  /** Stable-ish network identity: gateway MAC when we can read it, else SSID. */
  fingerprint: string | null
  trusted: boolean
  /** What the OS claims. Advisory only — never the basis for suppressing a prompt. */
  osProfile: 'public' | 'private' | 'domain' | 'unknown'
}

// ------------------------------------------------------------------- channels

/** invoke/handle — request/response. */
/**
 * One tool call an agent made, read out of the harness-written transcript.
 *
 * Re-exported from `shared/transcript.ts` so the renderer and preload get the
 * type without importing the parser, which is main-side work.
 */
import type { Activity } from './transcript.js'
export type { Activity }

export const CH = {
  vaultTree: 'vault:tree',
  vaultList: 'vault:list',
  vaultRead: 'vault:read',
  vaultSave: 'vault:save',
  vaultGraph: 'vault:graph',
  vaultBacklinks: 'vault:backlinks',
  vaultVersions: 'vault:versions',
  vaultVersionText: 'vault:version-text',
  vaultMkdir: 'vault:mkdir',
  vaultMove: 'vault:move',
  vaultUndoMove: 'vault:undo-move',

  claudeNewSession: 'claude:new-session',
  claudeSend: 'claude:send',
  claudeInterrupt: 'claude:interrupt',
  claudeHistory: 'claude:history',
  claudeSetPermissionMode: 'claude:set-permission-mode',

  cornerItems: 'corner:items',
  cornerDecide: 'corner:decide',
  cornerDismiss: 'corner:dismiss',
  agentActivity: 'agents:activity',
  networkTrust: 'network:trust',
  networkTrustCurrent: 'network:trust-current',

  settingsGet: 'settings:get',
  settingsPickVaultDir: 'settings:pick-vault-dir',
  settingsApplyVaultDir: 'settings:apply-vault-dir',
  settingsSetAppearance: 'settings:set-appearance',
  settingsSetApprovals: 'settings:set-approvals',

  terminalProcesses: 'terminal:processes',
  terminalExits: 'terminal:exits',
  terminalKill: 'terminal:kill',
  /**
   * THE ONLY CHANNEL IN THIS APP THAT REACHES THE OPERATING SYSTEM.
   *
   * Every call is gated by an explicit human approval showing the exact command
   * — see the reasoning at the top of src/main/terminal.ts for why this one is
   * gated on the ACT rather than on the actor, unlike everything in consent.ts.
   */
  terminalRun: 'terminal:run',
} as const

/** main -> renderer pushes. */
export const EV = {
  claudeMessage: 'claude:message',
  claudeSessionUpdate: 'claude:session-update',
  cornerPush: 'corner:push',
  cornerResolved: 'corner:resolved',
  agentActivity: 'agents:activity',
  networkChanged: 'network:changed',
} as const

/** The full surface exposed on `window.api`. Implemented in preload/index.ts. */
export type Api = {
  vault: {
    tree(): Promise<VaultTreeNode>
    list(): Promise<VaultNote[]>
    read(path: string): Promise<VaultNoteBody>
    save(path: string, text: string, mtime: number): Promise<VaultNote>
    graph(): Promise<VaultGraph>
    backlinks(path: string): Promise<string[]>
    /** Every pre-edit copy of this note in `.backups/`, newest first. Read-only. */
    versions(path: string): Promise<NoteVersion[]>
    /**
     * The body of one backup, by `NoteVersion.id`.
     *
     * Restoring it is NOT done here: pass the text to `save()` with the note's
     * current mtime, so the lost-update guard and SaveConflict apply exactly as
     * they do to a typed edit. There is deliberately no restore call.
     */
    versionText(id: string): Promise<string>
    /**
     * Create one folder in the vault. The only write here that is not a note.
     *
     * A folder name is unavoidably renderer-supplied, unlike settings'
     * `pickVaultDir()`, which takes no argument precisely so the renderer cannot
     * nominate a directory. So the containment check is in main and this
     * signature is the boundary it defends: it rejects `..`, an absolute path,
     * a drive letter, and any name the explorer would then hide.
     */
    mkdir(path: string): Promise<void>
    /**
     * Re-file one note, reversibly. The primitive an agent files with.
     *
     * Nothing is deleted: the copy lands at `to` and the ORIGINAL is moved into
     * `<vault>/.trash/`, which is HIDDEN, so it leaves the explorer, the
     * database and the graph without leaving the disk. `to` already existing is
     * refused rather than overwritten — a `MoveConflict`, which arrives as
     * itself over the bridge, the way SaveConflict does.
     *
     * Keep the returned `id`. It is the whole undo, and it survives a restart
     * because the journal is a file, not memory.
     */
    move(from: string, to: string): Promise<MoveRecord>
    /**
     * Put one move back: original returned to `from`, the copy at `to` trashed.
     *
     * Refused if `from` is occupied again, and refused a second time for the
     * same id. Still nothing is deleted.
     */
    undoMove(id: string): Promise<void>
  }
  corner: {
    items(): Promise<CornerItem[]>
    decide(d: ConsentDecision): Promise<void>
    dismiss(id: string): Promise<void>
    onPush(cb: (item: CornerItem) => void): () => void
    onResolved(cb: (id: string) => void): () => void
  }
  network: {
    current(): Promise<NetworkTrust>
    /** Marks the CURRENT network trusted/untrusted. Human action only. */
    trust(trusted: boolean): Promise<NetworkTrust>
    onChanged(cb: (t: NetworkTrust) => void): () => void
  }
  agents: {
    /**
     * What agents have done recently, oldest first.
     *
     * Read out of Claude Code's own transcripts, which the harness writes, so
     * this shows what an agent DID rather than what it reported doing. Empty
     * when nothing is running, and the surface showing it should not exist at
     * all in that case.
     */
    activity(): Promise<Activity[]>
    /** New activity as it happens. Returns its own unsubscribe. */
    onActivity(cb: (items: Activity[]) => void): () => void
  }
  terminal: {
    /** Live agent processes, one per running session. */
    processes(): Promise<AgentProcess[]>
    /** Recent exits, newest last. How a crash stays visible after the fact. */
    exits(): Promise<AgentExit[]>
    /** Terminate one agent process. False when there was nothing to kill. */
    kill(sessionId: string): Promise<boolean>
    /**
     * Run a shell command in the vault directory, after the user approves the
     * exact text. Never resolves to a run that was not approved — a refusal
     * comes back as `denied`, not as an error.
     */
    run(command: string): Promise<ShellResult>
  }
  settings: {
    get(): Promise<AppSettings>
    /**
     * Opens the OS folder picker and persists the choice. Returns the settings
     * as they now stand — unchanged if the picker was cancelled.
     */
    pickVaultDir(): Promise<AppSettings>
    /**
     * Switch to the pending vault folder NOW, and reload the window.
     *
     * Takes no argument for the same reason `pickVaultDir()` does not: the
     * renderer may never name a directory. This applies whatever was already
     * persisted by the picker, or does nothing if there is no pending change.
     *
     * The window reload is the point, not a side effect. A live swap would have
     * to invalidate the graph memo, the folder tree, the open edit buffer and
     * every path in the nav trail in one atomic step; throwing the whole
     * renderer away IS that step, and it cannot half-succeed.
     *
     * DESTROYS UNSAVED TEXT. The caller must check for a dirty buffer first —
     * <SettingsDialog> does, and this is the only reason that dialog now needs
     * to know about the buffer at all.
     */
    applyVaultDir(): Promise<AppSettings>
    /**
     * Persists the appearance overrides and returns the settings as they now
     * stand. Main validates and clamps, so what comes back may not equal what
     * went in — render the result, not the argument.
     */
    setAppearance(a: Appearance): Promise<AppSettings>
    /**
     * Persists the approvals policy and installs it in the gate immediately —
     * unlike the vault folder, there is nothing to rebuild and nothing unsaved to
     * lose. Main normalises, so the same rule applies as above: render the result.
     *
     * This tightens or loosens how often a human is asked. It can never remove
     * the gate; see src/main/consent.ts.
     */
    setApprovals(a: Approvals): Promise<AppSettings>
  }
}
