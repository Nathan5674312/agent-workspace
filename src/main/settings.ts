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
import { basename, join } from 'node:path'
import {
  CH,
  ARTWORK_OPACITY_MAX,
  DEFAULT_APPEARANCE,
  DEFAULT_APPROVALS,
  type Appearance,
  type Approvals,
  type AppSettings,
} from '../shared/ipc.js'
import { THEME_IDS } from '../shared/themes.js'
import { checkRoots, getVaultDir, setVaultDir } from './vault.js'
import { getApprovalsPolicy, setApprovalsPolicy } from './consent.js'
import type { Handle } from './ipc.js'

const settingsPath = join(app.getPath('userData'), 'settings.json')

/** Exactly what lives in settings.json. Absent keys mean "use the default". */
interface Stored {
  vaultDir?: string
  appearance?: Appearance
  approvals?: Approvals
  /** Absent means true. Only an explicit refusal is written. */
  notifyUpdates?: boolean
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
    // Deliberately NOT validated here. There is exactly one normaliser for this
    // value and it lives in consent.ts, because the gate is what has to be right
    // about it — a second copy here could drift, and the drift would be a policy
    // that reads one way and enforces another. Anything object-shaped is handed
    // over and comes back normalised; anything else never reaches the gate.
    if (typeof raw.approvals === 'object' && raw.approvals !== null) {
      out.approvals = raw.approvals as Approvals
    }
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
    // An unknown theme becomes the founder's rather than being kept: a
    // `data-theme` this build has no block for would paint the default palette
    // anyway, so storing it would leave Settings showing a theme the app is not
    // in. Same posture as `mode` in the approvals policy — normalise to the
    // safe value, do not preserve the junk.
    theme: pick(o.theme, THEME_IDS, DEFAULT_APPEARANCE.theme),
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

  // Before the vault work below, and unconditionally: this must run even on the
  // early return, or an install with a persisted policy and no persisted
  // vaultDir boots with the policy on disk and 'manual' in the gate. Passing the
  // default explicitly rather than skipping the call also makes a REMOVED
  // approvals key reset the gate, which matters because this function is the
  // only thing that ever installs one.
  setApprovalsPolicy(current.approvals ?? DEFAULT_APPROVALS)

  const dir = current.vaultDir
  if (!dir) return

  // load() proves the value is a non-empty string. It cannot prove the folder
  // still exists — the user may have deleted it, renamed it, or unplugged the
  // drive it was on since the last run, and that is far likelier than the
  // corrupt JSON this file already defends against. Applying it anyway boots
  // the app pointed at nothing, with no visible reason.
  // Refused for the same reason the picker now refuses it, and checked here as
  // well because a value written before that guard existed is already on disk.
  // Left in settings.json rather than rewritten — same posture as a missing
  // folder: the app uses the default for this run and says why.
  if (basename(dir).startsWith('.')) {
    vaultDirRefused =
      `Saved vault folder ${dir} is a dot-folder, which holds app data and is ` +
      `hidden by the explorer — no note in it can ever be shown. Using the ` +
      `default instead. Choose the folder that CONTAINS your notes.`
    return
  }

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
    // From the GATE, not from `current` — see the note in load(). What the user
    // is shown is what is actually being enforced, including when the file said
    // something the gate refused to honour.
    approvals: getApprovalsPolicy(),
    // Absent is true: a fresh install is told about updates. Only "do not
    // notify me" writes the key, so the file records a decision and never a
    // default the user did not make.
    notifyUpdates: current.notifyUpdates !== false,
  }
}

/**
 * Persist the appearance overrides. Unlike the vault folder, these apply LIVE —
 * they are CSS custom properties and attributes, so nothing has to be rebuilt to
 * honour them and there is no unsaved state to lose.
 */
/**
 * Remember whether the launch check may run at all.
 *
 * This is the off switch for the ONE thing this app does on its own behalf, so
 * it is stored beside the vault path rather than held in the renderer: a
 * preference that forgets itself on restart is not a refusal, it is a nag with
 * extra steps.
 */
function setNotifyUpdates(on: boolean): AppSettings {
  current = { ...current, notifyUpdates: on }
  save(current)
  return state()
}

function setAppearance(a: Appearance): AppSettings {
  current = { ...current, appearance: sanitize(a) }
  save(current)
  return state()
}

/**
 * Install the approvals policy and persist it. Applies LIVE, like appearance and
 * unlike the vault folder: the gate reads the policy at each decision, so there
 * is nothing to rebuild and no unsaved state to lose.
 *
 * Order is install-then-read-then-save, not save-then-install. What goes to disk
 * is what the gate NORMALISED, so a junk duration or an unknown mode is repaired
 * on the way in and never round-trips back out as the thing the user asked for.
 */
function setApprovals(a: Approvals): AppSettings {
  setApprovalsPolicy(a)
  current = { ...current, approvals: getApprovalsPolicy() }
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

  /**
   * A dot-folder can never be a usable vault root, so it is refused at the
   * point of choice rather than accepted and puzzled over later.
   *
   * This is not hypothetical. The picker opens at the CURRENT vault folder, so
   * a user changing vaults starts one level inside their existing one and it is
   * easy to step into `.obsidian` and click Use this folder — which is exactly
   * what happened here, leaving `vaultDir` at `…\Desktop\.obsidian`, an empty
   * explorer and an empty graph with nothing obviously wrong.
   *
   * `HIDDEN` in vault.ts skips `.git`, `.obsidian` and `.trash` wherever they
   * appear in the tree, so rooting the vault AT one of them means every file in
   * it is hidden by the app's own rules. There is no configuration under which
   * this is what someone meant.
   */
  if (basename(chosen).startsWith('.')) {
    vaultDirRefused =
      `${chosen} cannot be a vault folder: names beginning with a dot are ` +
      `app data, and this one's contents are hidden by the explorer. Pick the ` +
      `folder that CONTAINS your notes.`
    return state()
  }

  current = { ...current, vaultDir: chosen }
  // The picker only returns a folder that exists, so this IS the re-pick the
  // refusal message asks for. Clearing it here is what lets pendingVaultDir
  // come back and the warning go away.
  vaultDirRefused = null
  save(current)
  // Deliberately no setVaultDir() here. See the file header.
  return state()
}

/**
 * Switch to the pending folder now, instead of at the next launch.
 *
 * The file header says vaultDir is applied at BOOT only, and the reason given
 * is sound: a live swap has to invalidate the graph memo, the folder tree, the
 * open edit buffer and every path in the nav trail together, and a partial one
 * loses unsaved text. What that reasoning missed is that "restart to apply" is
 * only honest if something in the app can actually restart. Nothing could — so
 * picking a folder changed the small print under the path and left the path
 * itself alone, which reads as the setting being broken.
 *
 * A window RELOAD is the atomic step the header wanted. The renderer is
 * destroyed and rebuilt, so the tree, the buffer and the trail are not
 * invalidated one by one; they cease to exist. Main only has to drop the index
 * memo, which `setVaultDir` already does.
 *
 * The unsaved-text risk is real and is handled where the knowledge is: the
 * dialog refuses to offer this while the buffer is dirty. Main does not know
 * about the buffer and should not learn.
 */
async function applyVaultDir(): Promise<AppSettings> {
  const stored = current.vaultDir
  if (!stored || stored === getVaultDir() || vaultDirRefused !== null) return state()
  if (!isDirectory(stored)) {
    // Deleted between the pick and the click. Same message and same posture as
    // the boot path, rather than switching to a folder that is not there.
    vaultDirRefused = `Saved vault folder is missing: ${stored} — using the default instead. Choose the folder again to switch back.`
    return state()
  }

  setVaultDir(stored) // also drops the index memo — see vault.ts
  // The old boot warning describes the old root, so it must not outlive it.
  // Recomputed here rather than left stale, which would leave "point at X
  // instead" advice sitting under the folder it was telling you to pick.
  rootMismatch = await checkRoots().catch(() => null)

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.reload()
  return state()
}

export function register(handle: Handle): void {
  handle(CH.settingsGet, () => state())
  handle(CH.settingsPickVaultDir, () => pickVaultDir())
  handle(CH.settingsApplyVaultDir, () => applyVaultDir())
  handle(CH.settingsSetAppearance, (a: Appearance) => setAppearance(a))
  handle(CH.settingsSetApprovals, (a: Approvals) => setApprovals(a))
  handle(CH.settingsSetNotifyUpdates, (on: boolean) => setNotifyUpdates(on))
}
