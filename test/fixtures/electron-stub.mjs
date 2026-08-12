/**
 * Stand-in for the `electron` module so the REAL src/main/*.ts can be imported
 * by `node --test` outside an Electron process.
 *
 * This mocks an external dependency. It is NOT a copy of any module under test:
 * the tests import the actual source files and exercise the actual handlers.
 *
 * `app.getPath` reads TEST_USER_DATA at call time, so each test can point the
 * module at its own scratch directory.
 */
import { tmpdir } from 'node:os'

export const app = {
  getPath(name) {
    if (name === 'userData') return process.env.TEST_USER_DATA || tmpdir()
    return tmpdir()
  },
  // src/main/index.ts runs `app.whenReady().then(...)` at module scope. A
  // promise that never settles lets the module be imported for its pure
  // exports (isExternallyOpenable) without creating a window.
  whenReady: () => new Promise(() => {}),
  on() {},
  quit() {},
}

export const shell = { openExternal: async () => {} }

/** No renderer exists under `node --test`, so there is no window to push to. */
export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
}

/**
 * Registered handlers are kept so a test can invoke the REAL wrapper that
 * src/main/ipc.ts installed — including its sender-frame check — with a
 * synthetic event. Recording is inert for suites that ignore it.
 */
export const registeredHandlers = new Map()

export const ipcMain = {
  handle(channel, fn) {
    registeredHandlers.set(channel, fn)
  },
}

export const contextBridge = { exposeInMainWorld() {} }
export const ipcRenderer = { invoke() {}, on() {}, removeListener() {} }

export default {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  contextBridge,
  ipcRenderer,
}
