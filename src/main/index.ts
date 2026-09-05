import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc.js'
import * as activity from './activity.js'
import { checkRoots } from './vault.js'
import { applySettings, setRootMismatch } from './settings.js'
import { killAll } from './supervisor.js'

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
    /**
     * NO OS TITLE BAR. The app's own chrome runs to the top edge, and Windows
     * draws minimise / maximise / close over it.
     *
     * `hidden` rather than `frame: false`, deliberately: frameless would mean
     * building those three buttons by hand, and hand-built window controls are
     * where apps lose snap layouts (hover maximise), the correct hit targets at
     * the screen corner, and every accessibility affordance the OS provides for
     * free. This keeps the real controls and removes only the bar.
     *
     * The colours are placeholders for the first frame. They cannot be right
     * here — the palette lives in CSS and there are seven of them, one of which
     * (parchment, #f4ede1) is LIGHT, so a fixed dark strip would be visibly
     * wrong in it. The renderer sends the computed values the moment it has
     * applied a theme; see `windowSetOverlay`.
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#160c08',
      symbolColor: '#f0cba5',
      // Matches `.vault-tab-bar`'s height, so the buttons sit on the same row
      // as the tabs rather than floating above them.
      height: 40,
    },
    /**
     * The menu bar is HIDDEN in every build, and REMOVED in packaged ones.
     *
     * Two mechanisms because they answer two different needs. `Menu.
     * setApplicationMenu(null)` below deletes it outright, which is right for a
     * user and wrong for a developer — it takes Ctrl+R and the devtools
     * accelerator with it. This hides the strip while leaving the menu alive,
     * so the dev build stops advertising `File / Edit / View / Window / Help`
     * above a window designed to look like anything but Electron, and Alt still
     * reveals it if it is ever wanted.
     */
    autoHideMenuBar: true,
    // Unpackaged only. A packaged Windows build takes its window icon from the
    // exe's own resource, which electron-builder writes from build/icon.ico, and
    // build/ is not in the `files` allowlist so this path does not exist inside
    // the asar. Without it `npm run dev` shows the default Electron atom, which
    // is the icon a developer actually looks at all day.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
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

/**
 * THE APP'S IDENTITY TO WINDOWS, and without it the taskbar shows Electron's.
 *
 * Windows groups taskbar buttons and picks their icon by AppUserModelID, not by
 * the window's own icon. Electron defaults that ID to `electron.app.<name>` when
 * unpackaged, so the window title bar showed the Fate mark — `createWindow`
 * already sets `icon` for exactly that — while the TASKBAR sat there showing the
 * Electron atom all day. Two different mechanisms, one of them unset.
 *
 * The literal matches `build.appId` in package.json, because a packaged NSIS
 * install registers its shortcut under that id and a mismatch would split one
 * app into two taskbar buttons.
 *
 * Set before `whenReady`, since the id is read when the first window is created.
 */
app.setAppUserModelId('com.divineconstruc.fate')

/**
 * NO DEFAULT MENU.
 *
 * `File / Edit / View / Window / Help` is Electron's stock menu, not this app's
 * — nothing in `src/` creates it, and every entry on it is a framework default.
 * It is the most recognisable tell that an app is Electron, and it sits above a
 * window whose whole design is trying to say otherwise.
 *
 * Nothing is lost that the app offers elsewhere: there is no File command this
 * app has, Edit's clipboard roles are handled natively by Chromium inside text
 * fields on Windows, and Help is a dialog reached from the sidebar. The one
 * real cost is the accelerators the menu carried — reload and devtools — which
 * is why this is packaged-only. A developer keeps Ctrl+R; a user gets a window
 * that does not announce its framework.
 */
if (app.isPackaged) Menu.setApplicationMenu(null)

void app.whenReady().then(() => {
  // FIRST, before any handler or window can read the vault: a persisted
  // vaultDir has to be in place before the first tree() call, or the app boots
  // into the env default and only agrees with the setting after a second
  // restart. Synchronous by design — it is one small file read.
  applySettings()
  registerIpc()
  // Tail agent transcripts. Started here rather than on first window so a
  // window opening mid-run sees what is happening now instead of a blank
  // surface until the next tool call.
  activity.start()
  createWindow()
  // Diagnostic only, and deliberately not awaited: it scans the vault, and a
  // slow or unreachable disk must never hold up the window. Warns once at boot
  // if the vault root is missing, unreadable, or holds no notes. (It used to
  // compare the app's root against the note server's; there is one root now.)
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

/**
 * Take every agent process down with the app.
 *
 * Agent turns run in their own OS processes (src/main/supervisor.ts) precisely
 * so one dying cannot kill the app — but that independence cuts both ways: a
 * child has no way to notice its parent going away, because `parentPort` emits
 * no `close`. Without this, quitting mid-run leaves a Node process holding an
 * SDK subprocess, invisible in the UI the user just shut, until it finishes on
 * its own or is killed from Task Manager.
 *
 * `will-quit` rather than `window-all-closed`: on macOS the app outlives its
 * windows, and a session should survive the window being closed and reopened.
 */
app.on('will-quit', () => {
  killAll()
})
