/**
 * Switching the vault folder without relaunching.
 *
 * The bug: picking a folder persisted it and changed nothing visible. The path
 * on screen stayed on the old folder, the graph stayed on the old vault, and
 * the only thing that moved was a line of small print saying to restart — while
 * nothing in the app could restart. A setting you change that does not change
 * is indistinguishable from a broken one.
 *
 * What must hold now: the switch really repoints the vault, it drops the index
 * so the next read is the NEW folder rather than a memo of the old one, and it
 * refuses rather than half-applies when the folder has gone.
 *
 * STATE IS BUILT THROUGH THE PICKER, not by writing settings.json. `settings.ts`
 * resolves settings.json ONCE at module scope, so in a full run the first suite
 * to import it owns the path and every later suite writing its own file is
 * writing somewhere the module never reads. Stubbing the picker drives the same
 * code path the user does and is immune to who imported first.
 *
 * The electron stub has no windows, so `webContents.reload()` at the end of the
 * handler is inert here. That is deliberate: this suite is the state change,
 * and the reload is the renderer's half of it.
 */
import './fixtures/ts-hooks.mjs'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings = await import('../src/main/settings.ts')
const vault = await import('../src/main/vault.ts')
const { CH } = await import('../src/shared/ipc.ts')
// Same module instance the code under test sees: ts-hooks maps `electron` here.
const electron = await import('./fixtures/electron-stub.mjs')

const H = new Map()
settings.register((channel, fn) => H.set(channel, fn))
const get = () => H.get(CH.settingsGet)()
const pick = () => H.get(CH.settingsPickVaultDir)()
const apply = () => H.get(CH.settingsApplyVaultDir)()

const REAL_PICKER = electron.dialog.showOpenDialog
/** Make the next folder pick return `dir` instead of cancelling. */
const choose = (dir) => {
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
}
test.after(() => {
  electron.dialog.showOpenDialog = REAL_PICKER
})

/** A vault directory holding one note, named after it. */
function vaultWith(note) {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'))
  mkdirSync(join(dir, '.obsidian'), { recursive: true })
  writeFileSync(join(dir, '.obsidian', 'app.json'), '{}', 'utf8')
  writeFileSync(join(dir, note), `# ${note}\n`, 'utf8')
  return dir
}

/**
 * The state a folder-pick leaves behind: settings hold the CHOSEN folder while
 * the live root is still the old one. Returns both.
 */
async function pending() {
  const live = vaultWith('Live.md')
  const chosen = vaultWith('Chosen.md')
  vault.setVaultDir(live)
  choose(chosen)
  await pick()
  return { live, chosen }
}

test('switching now repoints the live vault at the pending folder', async () => {
  const { live, chosen } = await pending()
  assert.equal(get().vaultDir, live, 'precondition: still on the old folder')
  assert.equal(get().pendingVaultDir, chosen, 'precondition: a pick is waiting')

  await apply()
  assert.equal(vault.getVaultDir(), chosen)
  assert.equal(get().vaultDir, chosen)
})

test('nothing is left pending afterwards', async () => {
  await pending()
  await apply()
  // The small print promising a future change must not outlive the change.
  assert.equal(get().pendingVaultDir, null)
})

test('the next read comes from the new folder, not a memo of the old one', async () => {
  // THE BUG at the layer that actually matters: `list()` and `graph()` are
  // served from an index memo with a 30s TTL, so repointing the root without
  // dropping it would leave the explorer, the database and the graph showing the
  // previous vault for half a minute — which IS "I changed it and it still
  // points at the old one".
  await pending()
  assert.deepEqual(
    (await vault.list()).map((n) => n.path),
    ['Live.md'],
    'precondition: the memo holds the old vault',
  )

  await apply()
  assert.deepEqual(
    (await vault.list()).map((n) => n.path),
    ['Chosen.md'],
    'the index memo survived the switch',
  )
})

test('a switch with nothing pending changes nothing', async () => {
  const { chosen } = await pending()
  await apply()
  assert.equal(get().pendingVaultDir, null)

  await apply() // second time: no-op
  assert.equal(vault.getVaultDir(), chosen)
})

test('a folder deleted between the pick and the click is refused, not applied', async () => {
  const { live, chosen } = await pending()
  rmSync(chosen, { recursive: true, force: true })

  const after = await apply()
  assert.equal(vault.getVaultDir(), live, 'the app switched to a folder that is gone')
  assert.match(after.rootMismatch ?? '', /missing/i, 'and said nothing about it')
})

test('a dot-folder is refused at the picker, not accepted and puzzled over', async () => {
  // How the app ended up rooted at `…\Desktop\.obsidian`: the picker opens at
  // the CURRENT vault folder, so changing vaults starts you one level inside
  // your own vault and stepping into .obsidian is one double-click away. The
  // result was an empty explorer and an empty graph with nothing visibly wrong.
  const live = vaultWith('Live.md')
  vault.setVaultDir(live)
  const dotted = join(mkdtempSync(join(tmpdir(), 'holder-')), '.obsidian')
  mkdirSync(dotted, { recursive: true })

  choose(dotted)
  const after = await pick()

  assert.equal(after.pendingVaultDir, null, 'a dot-folder must not become pending')
  assert.equal(vault.getVaultDir(), live, 'and must not touch the live root')
  assert.match(after.rootMismatch ?? '', /dot/i, 'and must say why')
})

test('the boot warning is recomputed, not carried over from the old root', async () => {
  // A root one level above a vault produces a message naming the subfolder to
  // use. After switching INTO that subfolder the advice is stale and would sit
  // there telling you to pick the folder you are already in.
  const parent = mkdtempSync(join(tmpdir(), 'parent-'))
  const inner = join(parent, 'Real Vault')
  mkdirSync(join(inner, '.obsidian'), { recursive: true })
  writeFileSync(join(inner, '.obsidian', 'app.json'), '{}', 'utf8')
  writeFileSync(join(inner, 'Home.md'), '# Home\n', 'utf8')

  vault.setVaultDir(parent)
  choose(inner)
  await pick()
  settings.setRootMismatch(await vault.checkRoots())
  assert.match(get().rootMismatch ?? '', /Real Vault/, 'precondition: the bad-root warning')

  await apply()
  assert.equal(get().rootMismatch, null, 'the stale warning outlived the root it described')
})
