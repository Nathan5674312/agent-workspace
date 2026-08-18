/**
 * THE CONTRACT between main and renderer. Every pane depends on this file.
 *
 * Rules, non-negotiable:
 *  - The renderer has NO node integration and NO network access to the vault.
 *    Everything crosses this boundary. If a pane needs data, it goes here first.
 *  - Channel names are namespaced by pane so ownership is obvious.
 *  - Anything that mutates the vault or touches the network is a `consent:` gated
 *    call — it goes through the agent corner before it happens.
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
  kind: 'folder' | 'note'
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

/** One edge of the graph view. Derived from [[wikilinks]], never authoritative. */
export type VaultLink = { from: string; to: string }

export type VaultGraph = { nodes: string[]; links: VaultLink[] }

// ------------------------------------------------------------------- settings

/**
 * Appearance overrides.
 *
 * Every field's `'system'` means NO override: the renderer sets no attribute at
 * all, so the `@media (prefers-contrast: more)` / `(prefers-reduced-*)` blocks
 * already in app.css keep running untouched. That is the whole design — the OS
 * preference is the default and this is an escape hatch on top of it, never a
 * replacement for it.
 */
export type Appearance = {
  /** `'more'` mirrors `@media (prefers-contrast: more)`. */
  contrast: 'system' | 'more'
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
  contrast: 'system',
  transparency: 'system',
  motion: 'system',
  artwork: true,
  artworkOpacity: 0.16,
}

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

export type ConsentDecision = { id: string; allow: boolean }

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

  claudeNewSession: 'claude:new-session',
  claudeSend: 'claude:send',
  claudeInterrupt: 'claude:interrupt',
  claudeHistory: 'claude:history',
  claudeSetPermissionMode: 'claude:set-permission-mode',

  cornerItems: 'corner:items',
  cornerDecide: 'corner:decide',
  cornerDismiss: 'corner:dismiss',
  networkTrust: 'network:trust',
  networkTrustCurrent: 'network:trust-current',

  settingsGet: 'settings:get',
  settingsPickVaultDir: 'settings:pick-vault-dir',
  settingsSetAppearance: 'settings:set-appearance',
} as const

/** main -> renderer pushes. */
export const EV = {
  claudeMessage: 'claude:message',
  claudeSessionUpdate: 'claude:session-update',
  cornerPush: 'corner:push',
  cornerResolved: 'corner:resolved',
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
  settings: {
    get(): Promise<AppSettings>
    /**
     * Opens the OS folder picker and persists the choice. Returns the settings
     * as they now stand — unchanged if the picker was cancelled.
     */
    pickVaultDir(): Promise<AppSettings>
    /**
     * Persists the appearance overrides and returns the settings as they now
     * stand. Main validates and clamps, so what comes back may not equal what
     * went in — render the result, not the argument.
     */
    setAppearance(a: Appearance): Promise<AppSettings>
  }
}
