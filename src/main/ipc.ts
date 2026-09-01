import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH, type Actor } from '../shared/ipc.js'
import * as vault from './vault.js'
import * as versions from './versions.js'
import * as corner from './corner.js'
import * as network from './network.js'
import * as settings from './settings.js'
import * as terminal from './terminal.js'
import * as activity from './activity.js'

/**
 * True only for the window's top-level frame.
 *
 * `senderFrame` is documented as `WebFrameMain | null` — null once the frame has
 * navigated or been destroyed. The previous form, `e.senderFrame?.parent != null`,
 * therefore FAILED OPEN in exactly that case: optional chaining yields `undefined`,
 * and `undefined != null` is false, so a call with no identifiable sender frame was
 * treated as top-level and allowed through. An unidentifiable sender is a reason to
 * refuse, not to trust.
 *
 * Property access on a frame disposed between the two reads throws, so the whole
 * check sits in a try/catch that also refuses.
 */
function isTopFrame(e: IpcMainInvokeEvent): boolean {
  try {
    const frame = e.senderFrame
    return frame != null && frame.parent === null
  } catch {
    return false
  }
}

/**
 * Every handler is wrapped so a thrown error crosses the bridge as a plain
 * message instead of an unhandled rejection that silently hangs the caller's
 * promise. The sender frame is checked because ipcMain.handle fires for ANY
 * frame in the window, including one an <iframe> in rendered note content
 * could create.
 */
function handle(
  channel: string,
  fn: (...args: never[]) => unknown,
): void {
  ipcMain.handle(channel, async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTopFrame(e)) {
      throw new Error('ipc: refused call from a subframe')
    }
    return (fn as (...a: unknown[]) => unknown)(...args)
  })
}

/**
 * Every mutation reached through this file is USER-originated, and that is a
 * fact about the boundary rather than an assumption made for convenience.
 *
 * A call only arrives here by crossing the context bridge from the renderer,
 * and the renderer is a UI: it has no node integration, no agent loop, and no
 * way to act except when a person clicks or types. So the person IS the
 * consent, and prompting them to approve the save they just triggered would be
 * approval fatigue — the thing that teaches people to click through the prompt
 * that mattered. See src/main/consent.ts.
 *
 * An agent never appears here. It runs in MAIN and calls vault.ts directly with
 * its own `{ kind: 'agent', … }`, which is why no channel accepts an Actor and
 * why this constant is not a parameter: if the renderer could nominate an
 * actor, it could nominate `user`, and the gate would be decoration.
 */
const USER: Actor = { kind: 'user' }

export function registerIpc(): void {
  handle(CH.vaultTree, () => vault.tree())
  handle(CH.vaultList, () => vault.list())
  // Read-only, so no gate: it reads exactly what tree() already exposes.
  // NO EVENT PARAMETER: `handle` above strips it and forwards only the args.
  // Taking one here shifted every argument by one, so the query landed in the
  // unused slot and every search ran against the empty string — which returns
  // [] rather than throwing, so it looked like a vault with no matches in it.
  handle(CH.vaultSearch, (query: string) => vault.search(String(query ?? '')))
  handle(CH.vaultRead, (p: string) => vault.read(p))
  handle(CH.vaultSave, (p: string, t: string, m: number) => vault.save(p, t, m, USER))
  handle(CH.vaultGraph, () => vault.graph())
  handle(CH.vaultBacklinks, (p: string) => vault.backlinks(p))
  // Read-only. Restoring a version goes back out through CH.vaultSave above,
  // so it is guarded and backed up like any other write — there is no restore
  // channel by design.
  handle(CH.vaultVersions, (p: string) => versions.versions(p))
  handle(CH.vaultVersionText, (id: string) => versions.versionText(id))
  handle(CH.vaultMkdir, (p: string) => vault.mkdir(p, USER))
  // Both ends of a move are renderer-supplied, so both are resolved against the
  // vault root in main — see vault.move(). Nothing is deleted here: the
  // original is trashed and journalled so vault:undo-move can put it back.
  handle(CH.vaultMove, (from: string, to: string) => vault.move(from, to, USER))
  handle(CH.vaultUndoMove, (id: string) => vault.undoMove(id, USER))

  // Read-only and user-originated: the renderer is asking what it may already
  // see on screen. Nothing here can act, so there is nothing to gate.
  handle(CH.agentActivity, () => activity.current())

  corner.register(handle)
  network.register(handle)
  settings.register(handle)
  terminal.register(handle)
}

export type Handle = typeof handle
