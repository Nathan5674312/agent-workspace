import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH } from '../shared/ipc.js'
import * as vault from './vault.js'
import * as corner from './corner.js'
import * as network from './network.js'

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

export function registerIpc(): void {
  handle(CH.vaultTree, () => vault.tree())
  handle(CH.vaultList, () => vault.list())
  handle(CH.vaultRead, (p: string) => vault.read(p))
  handle(CH.vaultSave, (p: string, t: string, m: number) => vault.save(p, t, m))
  handle(CH.vaultGraph, () => vault.graph())
  handle(CH.vaultBacklinks, (p: string) => vault.backlinks(p))

  corner.register(handle)
  network.register(handle)
}

export type Handle = typeof handle
