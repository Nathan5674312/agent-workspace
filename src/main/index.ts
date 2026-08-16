import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc.js'
import { checkRoots } from './vault.js'
import { applySettings, setRootMismatch } from './settings.js'

/**
 * Only http(s) may be handed to the OS. `new URL` is the parser, not a regex —
 * a regex on the raw string loses to `javascript:/*http://x*\/alert(1)` and to
 * whitespace/control characters that ShellExecute strips but a regex does not.
 */
export function isExternallyOpenable(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Non-negotiable. The renderer runs page-authored code; it gets no node,
      // no direct network to the vault, and no shared JS context with preload.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Never let the renderer navigate itself somewhere else, and open real links
  // in the real browser rather than in a chromeless window with our preload.
  //
  // The URL here is renderer-supplied and the renderer is untrusted, so it is
  // checked before it reaches the OS. shell.openExternal hands the string to
  // ShellExecute/xdg-open, which happily runs `file:///...exe`, `smb://host/x`
  // and any registered custom protocol — that is arbitrary program launch from
  // a page-authored string, i.e. straight out of the sandbox. Only http(s).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // `will-navigate` covers the top frame only. A subframe navigating itself
  // needs `will-frame-navigate`, which fires for every frame in the tree.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-frame-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(() => {
  // FIRST, before any handler or window can read the vault: a persisted
  // vaultDir has to be in place before the first tree() call, or the app boots
  // into the env default and only agrees with the setting after a second
  // restart. Synchronous by design — it is one small file read.
  applySettings()
  registerIpc()
  createWindow()
  // Diagnostic only, and deliberately not awaited: a slow or absent note server
  // must never hold up the window. Warns once at boot if the app's vault
  // directory and the server's root are not the same vault.
  // The .catch is not decoration. Node's default for an unhandled rejection is
  // to throw, so without it a diagnostic whose whole promise is that it "must
  // never hold up the window" could instead take the main process down.
  void checkRoots()
    .then((msg) => {
      // Kept so the settings modal can show the message the console already
      // got, instead of paying for a second full check every time it opens.
      //
      // vault.ts:224 says not to forward this string to the renderer without
      // scrub(), because it names VAULT_DIR and with it the OS username. That
      // reasoning does not survive this feature: the settings modal shows the
      // vault directory as its whole content, so the path is crossing the
      // bridge either way — and scrubbing it to `<path>` here would produce a
      // warning that names no directory, sitting directly under the directory
      // it is about. Nothing else may forward it.
      setRootMismatch(msg)
      if (msg) console.warn(msg)
    })
    .catch(() => {})
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
