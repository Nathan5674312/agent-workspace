/**
 * App settings, persisted to settings.json in Electron's userData directory.
 *
 * ONE setting in v1: the vault folder. It is applied at BOOT only. A live swap
 * would have to invalidate the graph memo, the folder tree, the open edit
 * buffer and every path in the renderer's nav trail in one atomic step, and
 * getting any of those wrong loses unsaved text — so the modal says "applies on
 * restart" and the code does exactly that, nothing cleverer.
 *
 * MAIN PROCESS ONLY. The renderer never sends a directory across the bridge;
 * pickVaultDir() runs the OS picker here and returns the result.
 */
import { app, dialog, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { CH, type AppSettings } from '../shared/ipc.js'
import { getVaultDir, setVaultDir } from './vault.js'
import type { Handle } from './ipc.js'

const settingsPath = join(app.getPath('userData'), 'settings.json')

/** Exactly what lives in settings.json. Absent keys mean "use the default". */
interface Stored {
  vaultDir?: string
}

/** The last thing loaded from or written to disk. */
let current: Stored = {}

/**
 * The startup root-mismatch message from `vault.checkRoots()`.
 *
 * Recorded by index.ts at boot rather than recomputed on demand: checkRoots()
 * costs an HTTP round trip to the note server plus a handful of stats, and the
 * answer worth showing is the one the app actually booted with — not a fresh
 * one that may disagree with the warning already in the console.
 */
let rootMismatch: string | null = null

export function setRootMismatch(message: string | null): void {
  rootMismatch = message
}

/**
 * Read settings.json.
 *
 * The file is JSON we wrote, but it sits in a user-writable directory, so it is
 * parsed as untrusted input: anything that does not validate is dropped and the
 * result is defaults, never a throw. Same posture as network.ts's trust store —
 * a corrupt settings file must not stop the app from starting.
 */
function load(): Stored {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const dir = (parsed as Record<string, unknown>).vaultDir
    return typeof dir === 'string' && dir !== '' ? { vaultDir: dir } : {}
  } catch {
    // Missing file on first run, or corrupt. Both mean "no persisted setting".
    return {}
  }
}

/**
 * Temp file + rename, never a bare writeFileSync — writeFileSync truncates
 * before it writes, so a crash mid-write leaves a 0-byte file that load()
 * silently reads as "no setting", quietly sending the app back to the default
 * vault. rename is atomic on NTFS. Same defect class as network.ts:98.
 */
function save(s: Stored): void {
  const tmp = `${settingsPath}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
  renameSync(tmp, settingsPath)
}

/**
 * Load settings.json and apply it.
 *
 * MUST run before anything reads the vault, which is why index.ts calls it
 * first inside whenReady() — that ordering is the whole of "a persisted
 * vaultDir wins over the env default", since setVaultDir simply overwrites the
 * value vault.ts initialised from AGENT_WORKSPACE_VAULT_DIR.
 */
export function applySettings(): void {
  current = load()
  if (current.vaultDir) setVaultDir(current.vaultDir)
}

function state(): AppSettings {
  const active = getVaultDir()
  const stored = current.vaultDir ?? null
  // After applySettings() these agree, so nothing is pending at boot. They
  // diverge only between a pick and the next restart.
  return {
    vaultDir: active,
    pendingVaultDir: stored !== null && stored !== active ? stored : null,
    rootMismatch,
  }
}

async function pickVaultDir(): Promise<AppSettings> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    title: 'Choose vault folder',
    defaultPath: getVaultDir(),
    properties: ['openDirectory' as const],
    buttonLabel: 'Use this folder',
  }
  // Parented when we have a window, so the picker cannot open behind the app
  // with the renderer sitting on a promise nobody can see how to resolve.
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  const chosen = result.filePaths[0]
  if (result.canceled || !chosen) return state()

  current = { ...current, vaultDir: chosen }
  save(current)
  // Deliberately no setVaultDir() here. See the file header.
  return state()
}

export function register(handle: Handle): void {
  handle(CH.settingsGet, () => state())
  handle(CH.settingsPickVaultDir, () => pickVaultDir())
}
