/**
 * `vault.mkdir` — the "+ Folder" button's main-process half, against a scratch
 * vault.
 *
 * This is the ONE piece of the dead-button work that must not be verified by
 * hand. Every other control in that batch fails visibly when it is wrong; this
 * one takes a renderer-supplied string and creates a directory with it, so a
 * hole here is a write primitive over the whole disk handed to the untrusted
 * side. The containment assertions below check the filesystem afterwards rather
 * than trusting the thrown error, because a call that both throws AND creates
 * would pass a message-only test.
 *
 * No Electron, no IPC — same shape as versions.test.mjs and section4-data-layer.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir as mkdirp, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vault from '../src/main/vault.ts'

const isDir = async (p) => {
  const s = await stat(p).catch(() => null)
  return !!s && s.isDirectory()
}

test('vault.mkdir', async (t) => {
  /**
   * The vault sits one level INSIDE the scratch directory, so `..` from the
   * vault root is a parent this test owns exclusively and can assert is empty.
   *
   * The first version of this pointed the escape cases at `<tmp>/Escaped` and
   * failed on a directory of that name already sitting in %TEMP% since
   * 2026-08-08 — someone else's leftovers. An escape assertion against a shared
   * location tests the machine's history, not the guard.
   */
  const parent = await mkdtemp(join(tmpdir(), 'vault-mkdir-'))
  const dir = join(parent, 'vault')
  await mkdirp(dir)
  vault._setVaultDirForTest(dir)

  await t.test('creates a folder at the vault root', async () => {
    await vault.mkdir('Scratch')
    assert.ok(await isDir(join(dir, 'Scratch')))
  })

  await t.test('creates a folder inside an existing one', async () => {
    await vault.mkdir('Scratch/Inner')
    assert.ok(await isDir(join(dir, 'Scratch', 'Inner')))
  })

  await t.test('a name that already exists is refused, not silently ignored', async () => {
    // The whole reason mkdirSync is NOT recursive here: `recursive: true`
    // resolves happily on an existing directory, so typing the name of a folder
    // that is already there would report success and appear to do nothing.
    await assert.rejects(() => vault.mkdir('Scratch'), /EEXIST|exists/i)
  })

  await t.test('a missing parent is refused rather than conjured', async () => {
    await assert.rejects(() => vault.mkdir('Nope/Deep'), /ENOENT|no such/i)
    assert.equal(await isDir(join(dir, 'Nope')), false)
  })

  /**
   * The traversal guard. `resolveInVault` is what enforces it and it is shared
   * with read() and save(), so these cases are as much a regression test on
   * that function as on this one.
   */
  await t.test('a path that climbs out of the vault creates nothing', async () => {
    for (const bad of ['../Escaped', '../../Escaped', 'Scratch/../../Escaped']) {
      await assert.rejects(() => vault.mkdir(bad), /escapes the vault/)
    }
    // The filesystem is the assertion, not the message: a call that both threw
    // AND created would pass a rejects-only test.
    assert.deepEqual(await readdir(parent), ['vault'])
  })

  await t.test('an absolute path or a drive letter creates nothing', async () => {
    for (const bad of ['C:\\Windows\\Temp\\Escaped', '/tmp/Escaped', 'C:/Escaped']) {
      await assert.rejects(() => vault.mkdir(bad), /escapes the vault/)
    }
    assert.deepEqual(await readdir(parent), ['vault'])
  })

  await t.test('the vault root itself is not a folder to create', async () => {
    for (const bad of ['', '.', './']) {
      await assert.rejects(() => vault.mkdir(bad), /vault:/)
    }
  })

  await t.test('a non-string path is refused at the boundary', async () => {
    // The `path: string` annotation is erased at runtime and the renderer sends
    // whatever it likes, so the check has to be a real one.
    for (const bad of [undefined, null, 42, {}, ['Scratch']]) {
      await assert.rejects(() => vault.mkdir(bad), /non-empty string/)
    }
  })

  await t.test('a name the explorer would hide is refused', async () => {
    // tree() skips dot-directories and everything in HIDDEN. Creating one would
    // make a real folder that never appears in the sidebar — a button that
    // reports success and shows nothing, which is the defect being fixed.
    for (const bad of ['.obsidian', '.git', 'node_modules', 'Scratch/.hidden']) {
      await assert.rejects(() => vault.mkdir(bad), /does not show folders/)
    }
    assert.equal((await readdir(dir)).includes('.obsidian'), false)
  })

  await t.test('the error never carries the vault path', async () => {
    // Everything thrown here crosses IPC to an untrusted renderer, and node's
    // fs errors stringify with the absolute path they failed on — which would
    // leak the vault location, and with it the OS username, on every collision.
    const e = await vault.mkdir('Scratch').catch((err) => err)
    assert.ok(!e.message.includes(dir), e.message)
    assert.match(e.message, /<path>/)
  })
})
