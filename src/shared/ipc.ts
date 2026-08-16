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
  /** Nanosecond mtime from the server. Required for the lost-update guard on save. */
  mtime: number
}

export type VaultNoteBody = VaultNote & { text: string }

export type VaultTreeNode = {
  name: string
  path: string
  kind: 'folder' | 'note'
  children?: VaultTreeNode[]
}

/** One edge of the graph view. Derived from [[wikilinks]], never authoritative. */
export type VaultLink = { from: string; to: string }

export type VaultGraph = { nodes: string[]; links: VaultLink[] }

// ------------------------------------------------------------------- settings

/**
 * App settings. ONE setting in v1: the vault folder.
 *
 * The renderer never sends a path across this boundary — `pickVaultDir()` opens
 * the OS folder picker in the MAIN process and returns the result. A settings
 * call that accepted an arbitrary renderer-supplied directory would be a way to
 * point the app's file reads anywhere on disk.
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
  }
}
