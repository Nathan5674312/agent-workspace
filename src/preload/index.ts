import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV, type Api } from '../shared/ipc.js'

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
    list: () => ipcRenderer.invoke(CH.vaultList),
    read: (path) => ipcRenderer.invoke(CH.vaultRead, path),
    save: (path, text, mtime) =>
      ipcRenderer.invoke(CH.vaultSave, path, text, mtime),
    graph: () => ipcRenderer.invoke(CH.vaultGraph),
    backlinks: (path) => ipcRenderer.invoke(CH.vaultBacklinks, path),
  },
  claude: {
    sessions: () => ipcRenderer.invoke(CH.claudeSessions),
    newSession: (cwd) => ipcRenderer.invoke(CH.claudeNewSession, cwd),
    send: (id, text) => ipcRenderer.invoke(CH.claudeSend, id, text),
    interrupt: (id) => ipcRenderer.invoke(CH.claudeInterrupt, id),
    history: (id) => ipcRenderer.invoke(CH.claudeHistory, id),
    stats: (range) => ipcRenderer.invoke(CH.claudeStats, range),
    setPermissionMode: (id, mode) =>
      ipcRenderer.invoke(CH.claudeSetPermissionMode, id, mode),
    onMessage: (cb) => on(EV.claudeMessage, cb),
    onSessionUpdate: (cb) => on(EV.claudeSessionUpdate, cb),
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
}

contextBridge.exposeInMainWorld('api', api)
