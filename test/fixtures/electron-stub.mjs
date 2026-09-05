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
  /**
   * Windows taskbar identity. `src/main/index.ts` sets it at module scope,
   * before `whenReady`, because the id is read when the first window is made —
   * so importing that module for its pure exports calls straight through here.
   */
  setAppUserModelId() {},
  /**
   * False under `node --test`, which is also the honest answer: this is not a
   * packaged app. It matters because index.ts strips the default menu only when
   * packaged, so the stub returning false is what keeps that branch unexercised
   * rather than accidentally asserting a menu call that never happens in dev.
   */
  isPackaged: false,
}

export const shell = { openExternal: async () => {} }

/**
 * The default application menu is removed in packaged builds. Nothing under
 * `node --test` is packaged, so this exists to satisfy the import rather than
 * to be called — but it records the call so a future test can assert it.
 */
export const Menu = {
  calls: [],
  setApplicationMenu(m) {
    Menu.calls.push(m)
  },
}

/** No renderer exists under `node --test`, so there is no window to push to. */
export const BrowserWindow = {
  getAllWindows: () => [],
  getFocusedWindow: () => null,
}

/**
 * There is no OS folder picker under `node --test`. "Cancelled" is the only
 * honest stand-in: it is a real outcome of showOpenDialog, and it is the one
 * that must leave settings.json untouched.
 */
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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

/**
 * `nativeImage` exists so src/main/windowIcon.ts can be imported — settings.ts
 * pulls it in, so without this EVERY suite that touches settings dies at import
 * with "does not provide an export named 'nativeImage'".
 *
 * `isEmpty: () => true` is the load-bearing part: windowIcon treats an empty
 * image as "do not set an icon and leave the previous one", so under test the
 * icon path runs all its guards and then does nothing, which is the correct
 * behaviour when there is no window and no compositor to show one.
 */
export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true }),
}

export const contextBridge = { exposeInMainWorld() {} }
export const ipcRenderer = { invoke() {}, on() {}, removeListener() {} }

/**
 * Agent turns run in their own OS processes (src/main/supervisor.ts), which
 * imports this. Only the shape matters here: no suite under `node --test` may
 * spawn a real child, so `fork` throwing is the honest stand-in — a test that
 * reaches it has escaped its own boundary and should say so loudly rather than
 * silently talk to a fake.
 *
 * The isolation guarantee itself cannot be proved here at all; it needs real
 * processes, and it is verified by an Electron probe against a child that
 * crashes on purpose (see `_setHostEntryForTest`).
 */
export const utilityProcess = {
  fork() {
    throw new Error('utilityProcess.fork is not available under node --test')
  },
}

export default {
  app,
  shell,
  Menu,
  dialog,
  BrowserWindow,
  nativeImage,
  ipcMain,
  contextBridge,
  ipcRenderer,
  utilityProcess,
}
