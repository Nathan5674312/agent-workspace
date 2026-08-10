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
}

/** No renderer exists under `node --test`, so there is no window to push to. */
export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
}

export const ipcMain = {
  handle() {},
}

export const contextBridge = { exposeInMainWorld() {} }
export const ipcRenderer = { invoke() {}, on() {}, removeListener() {} }

export default { app, BrowserWindow, ipcMain, contextBridge, ipcRenderer }
