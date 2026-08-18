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
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CH,
  ARTWORK_OPACITY_MAX,
  DEFAULT_APPEARANCE,
  type Appearance,
  type AppSettings,
} from '../shared/ipc.js'
import { getVaultDir, setVaultDir } from './vault.js'
import type { Handle } from './ipc.js'

const settingsPath = join(app.getPath('userData'), 'settings.json')

/** Exactly what lives in settings.json. Absent keys mean "use the default". */
interface Stored {
  vaultDir?: string
  appearance?: Appearance
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

/**
 * Why the persisted vaultDir was refused at boot, or null if it was applied (or
 * there was none). Same CHANNEL as rootMismatch — one diagnostic line in the
 * modal — but a separate variable, because index.ts calls setRootMismatch()
 * from checkRoots()'s .then(), which lands AFTER applySettings() and would
 * otherwise overwrite this with the null that a healthy default root produces.
 *
 * It wins over rootMismatch when both are set: checkRoots() would be describing
 * the default directory, and the reason the app is looking at the default
 * directory is the more useful sentence.
 */
let vaultDirRefused: string | null = null

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
    const raw = parsed as Record<string, unknown>
    const out: Stored = {}
    const dir = raw.vaultDir
    if (typeof dir === 'string' && dir !== '') out.vaultDir = dir
    // Absent stays absent, so state() falls through to DEFAULT_APPEARANCE and
    // an untouched settings.json keeps no appearance key at all.
    if (raw.appearance !== undefined) out.appearance = sanitize(raw.appearance)
    return out
  } catch {
    // Missing file on first run, or corrupt. Both mean "no persisted setting".
    return {}
  }
}

/**
 * Coerce anything into a complete, in-range Appearance.
 *
 * ONE function for BOTH trust boundaries — the file on disk and the renderer's
 * argument — because they are the same problem: a value that never went through
 * the slider. A field that does not validate falls back to its default rather
 * than rejecting the whole object, so a hand-edited settings.json costs the user
 * the one bad field, not every appearance setting they had.
 */
function sanitize(v: unknown): Appearance {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback
  const opacity = o.artworkOpacity
  return {
    contrast: pick(o.contrast, ['system', 'more'] as const, DEFAULT_APPEARANCE.contrast),
    transparency: pick(
      o.transparency,
      ['system', 'reduced'] as const,
      DEFAULT_APPEARANCE.transparency,
    ),
    motion: pick(o.motion, ['system', 'reduced'] as const, DEFAULT_APPEARANCE.motion),
    artwork: typeof o.artwork === 'boolean' ? o.artwork : DEFAULT_APPEARANCE.artwork,
    // Number.isFinite rejects NaN and both infinities; JSON can carry neither,
    // but the renderer's argument can, and NaN would survive a bare clamp.
    artworkOpacity:
      typeof opacity === 'number' && Number.isFinite(opacity)
        ? Math.min(Math.max(opacity, 0), ARTWORK_OPACITY_MAX)
        : DEFAULT_APPEARANCE.artworkOpacity,
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
  vaultDirRefused = null
  const dir = current.vaultDir
  if (!dir) return

  // load() proves the value is a non-empty string. It cannot prove the folder
  // still exists — the user may have deleted it, renamed it, or unplugged the
  // drive it was on since the last run, and that is far likelier than the
  // corrupt JSON this file already defends against. Applying it anyway boots
  // the app pointed at nothing, with no visible reason.
  if (isDirectory(dir)) {
    setVaultDir(dir)
    return
  }
  // Left in settings.json, not deleted: the drive may come back, and dropping
  // it would silently discard a choice the user made. The default is used for
  // this run, and the modal says so with the path, so it can be re-picked.
  vaultDirRefused = `Saved vault folder is missing: ${dir} — using the default instead. Choose the folder again to switch back.`
}

/** Non-throwing: statSync raises on a bad path or a denied one, and neither is a
 *  reason for the whole app to fail to boot. Both mean "cannot use this". */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function state(): AppSettings {
  const active = getVaultDir()
  const stored = current.vaultDir ?? null
  // After applySettings() these agree, so nothing is pending at boot. They
  // diverge only between a pick and the next restart — or when the stored
  // folder was refused, and then nothing is pending either: promising "restart
  // to open it" under a warning that it does not exist is a lie the user would
  // act on.
  return {
    vaultDir: active,
    pendingVaultDir:
      stored !== null && stored !== active && vaultDirRefused === null ? stored : null,
    rootMismatch: vaultDirRefused ?? rootMismatch,
    appearance: current.appearance ?? DEFAULT_APPEARANCE,
  }
}

/**
 * Persist the appearance overrides. Unlike the vault folder, these apply LIVE —
 * they are CSS custom properties and attributes, so nothing has to be rebuilt to
 * honour them and there is no unsaved state to lose.
 */
function setAppearance(a: Appearance): AppSettings {
  current = { ...current, appearance: sanitize(a) }
  save(current)
  return state()
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
  // The picker only returns a folder that exists, so this IS the re-pick the
  // refusal message asks for. Clearing it here is what lets pendingVaultDir
  // come back and the warning go away.
  vaultDirRefused = null
  save(current)
  // Deliberately no setVaultDir() here. See the file header.
  return state()
}

export function register(handle: Handle): void {
  handle(CH.settingsGet, () => state())
  handle(CH.settingsPickVaultDir, () => pickVaultDir())
  handle(CH.settingsSetAppearance, (a: Appearance) => setAppearance(a))
}
