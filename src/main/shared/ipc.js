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
// ------------------------------------------------------------------- channels
/** invoke/handle — request/response. */
export const CH = {
    vaultTree: 'vault:tree',
    vaultList: 'vault:list',
    vaultRead: 'vault:read',
    vaultSave: 'vault:save',
    vaultGraph: 'vault:graph',
    vaultBacklinks: 'vault:backlinks',
    claudeSessions: 'claude:sessions',
    claudeNewSession: 'claude:new-session',
    claudeSend: 'claude:send',
    claudeInterrupt: 'claude:interrupt',
    claudeHistory: 'claude:history',
    claudeStats: 'claude:stats',
    claudeSetPermissionMode: 'claude:set-permission-mode',
    cornerItems: 'corner:items',
    cornerDecide: 'corner:decide',
    cornerDismiss: 'corner:dismiss',
    networkTrust: 'network:trust',
    networkTrustCurrent: 'network:trust-current',
};
/** main -> renderer pushes. */
export const EV = {
    claudeMessage: 'claude:message',
    claudeSessionUpdate: 'claude:session-update',
    cornerPush: 'corner:push',
    cornerResolved: 'corner:resolved',
    networkChanged: 'network:changed',
};
