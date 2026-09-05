import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV, type Api, type Activity } from '../shared/ipc.js'

/**
 * The ONLY bridge between renderer and main. Nothing else crosses.
 *
 * Every listener returns its own unsubscribe. Renderer components must call it
 * on unmount — without that, remounting a pane stacks duplicate handlers and
 * the same consent prompt renders N times.
 */
function on<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void,
): () => void {
  const handler = (_e: unknown, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: Api = {
  vault: {
    tree: () => ipcRenderer.invoke(CH.vaultTree),
    search: (query: string) => ipcRenderer.invoke(CH.vaultSearch, query),
    list: () => ipcRenderer.invoke(CH.vaultList),
    read: (path) => ipcRenderer.invoke(CH.vaultRead, path),
    save: (path, text, mtime) =>
      ipcRenderer.invoke(CH.vaultSave, path, text, mtime),
    graph: () => ipcRenderer.invoke(CH.vaultGraph),
    backlinks: (path) => ipcRenderer.invoke(CH.vaultBacklinks, path),
    versions: (path) => ipcRenderer.invoke(CH.vaultVersions, path),
    versionText: (id) => ipcRenderer.invoke(CH.vaultVersionText, id),
    mkdir: (path) => ipcRenderer.invoke(CH.vaultMkdir, path),
    move: (from, to) => ipcRenderer.invoke(CH.vaultMove, from, to),
    undoMove: (id) => ipcRenderer.invoke(CH.vaultUndoMove, id),
  },
  agents: {
    activity: () => ipcRenderer.invoke(CH.agentActivity),
    onActivity: (cb) => on<[Activity[]]>(EV.agentActivity, cb),
  },
  terminal: {
    processes: () => ipcRenderer.invoke(CH.terminalProcesses),
    exits: () => ipcRenderer.invoke(CH.terminalExits),
    kill: (sessionId) => ipcRenderer.invoke(CH.terminalKill, sessionId),
    run: (command) => ipcRenderer.invoke(CH.terminalRun, command),
  },
  corner: {
    items: () => ipcRenderer.invoke(CH.cornerItems),
    decide: (d) => ipcRenderer.invoke(CH.cornerDecide, d),
    dismiss: (id) => ipcRenderer.invoke(CH.cornerDismiss, id),
    onPush: (cb) => on(EV.cornerPush, cb),
    onResolved: (cb) => on(EV.cornerResolved, cb),
  },
  network: {
    current: () => ipcRenderer.invoke(CH.networkTrustCurrent),
    trust: (trusted) => ipcRenderer.invoke(CH.networkTrust, trusted),
    onChanged: (cb) => on(EV.networkChanged, cb),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    // No argument on purpose: the picker runs in main, so the renderer cannot
    // nominate a directory for the app to read from.
    pickVaultDir: () => ipcRenderer.invoke(CH.settingsPickVaultDir),
    // Also no argument: it applies the folder the picker already persisted, so
    // the renderer still never names a directory. It reloads the window, which
    // is why the dialog gates it on there being no unsaved text.
    applyVaultDir: () => ipcRenderer.invoke(CH.settingsApplyVaultDir),
    // Takes an argument where pickVaultDir cannot: nothing in Appearance can
    // name a file, so it is not a way to point the app's reads anywhere.
    setAppearance: (a) => ipcRenderer.invoke(CH.settingsSetAppearance, a),
    // Same reasoning as setAppearance: it names no file. It also cannot weaken
    // the gate past 'manual' — main normalises, and there is no mode that turns
    // it off — so the worst a compromised renderer achieves here is asking the
    // human MORE often.
    setApprovals: (a) => ipcRenderer.invoke(CH.settingsSetApprovals, a),
    setNotifyUpdates: (on: boolean) => ipcRenderer.invoke(CH.settingsSetNotifyUpdates, on),
  },
  update: {
    // No argument, and nothing to give one: the feed URL is a constant in
    // shared/update.ts, so the renderer cannot point the app's one outbound
    // request at a host of its choosing.
    check: () => ipcRenderer.invoke(CH.updateCheck),
    // These two DO come from the renderer, so main validates them with the same
    // `isVersion` the feed's own tag goes through before either reaches a URL.
    // The host is still a constant; only the two version numbers cross.
    changes: (base: string, head: string) => ipcRenderer.invoke(CH.updateChanges, base, head),
    releases: (current: string) => ipcRenderer.invoke(CH.updateReleases, current),
  },
}

contextBridge.exposeInMainWorld('api', api)
