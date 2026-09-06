/**
 * THE SELF-UPDATE PATH, ASSERTED AT THE PLACES IT HAS ACTUALLY BROKEN.
 *
 * Not a test of electron-updater, which is somebody else's tested library.
 * This pins the four facts around it that are easy to lose and impossible to
 * see: three of them live in package.json, and none of them makes anything
 * look wrong when it goes missing.
 *
 * WHAT WENT WRONG, and why a test rather than a note. A user on 1.0.4 clicked
 * "Get the update", restarted, and was asked again — every launch, forever.
 * The build he was running had no install path in it at all: the code was on a
 * branch, and the releases it would have downloaded carried no `latest.yml`,
 * because `publish` was not configured when they were cut. Both failures are
 * invisible from outside. The release page looks complete, the installer is
 * right there, the download page still works, and the only symptom is a person
 * being asked the same question until they stop believing the app.
 *
 * `package.json` has been silently reset TWICE in this repo — `npx asar
 * extract-file <archive> package.json` writes into the CURRENT DIRECTORY
 * rather than to stdout, so inspecting a packaged build from the repo root
 * replaces the real file with the packaged one, `publish` and all. That is not
 * a hypothetical: it is how this file came to exist.
 *
 * Read as text, not imported: package.json is data, and the two source files
 * are checked for wiring rather than run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('publish is configured, or no release can carry latest.yml', () => {
  /**
   * THE ONE THAT COSTS A RELEASE. electron-builder writes `latest.yml` and the
   * `.blockmap` ONLY when this is set. Without them every installed app's
   * update button fails at the moment someone has agreed to update, and
   * nothing about the build or the release page looks wrong.
   *
   * Measured on the releases cut without it: v1.0.4 and v1.0.5 published
   * `Fate-<v>-win.zip` and `Fate.Setup.<v>.exe` and nothing else.
   */
  const publish = pkg.build?.publish
  assert.ok(Array.isArray(publish) && publish.length > 0, 'build.publish is missing')
  assert.equal(publish[0].provider, 'github')
  assert.ok(publish[0].owner && publish[0].repo, 'the github provider names no repository')
})

test('electron-updater is a dependency, not a devDependency', () => {
  // It is imported at runtime by src/main/update.ts. A devDependency is not
  // packed into the asar, so this would be a build that passes every local
  // check and throws MODULE_NOT_FOUND on the one click that matters.
  assert.ok(pkg.dependencies?.['electron-updater'], 'electron-updater is not a runtime dependency')
  assert.ok(
    !pkg.devDependencies?.['electron-updater'],
    'electron-updater is also a devDependency, so which one ships is a coin toss',
  )
})

test('the install channel is registered in main and exposed in preload', () => {
  // A handler with no bridge, or a bridge with no handler, both fail only when
  // clicked — and the click is rare enough to ship broken.
  const main = read('src', 'main', 'update.ts')
  assert.match(main, /CH\.updateInstall/, 'main registers no install handler')
  assert.match(main, /quitAndInstall/, 'nothing in main actually installs anything')
  assert.match(main, /autoDownload\s*=\s*false/, 'autoDownload is not explicitly off')
  assert.match(
    main,
    /autoInstallOnAppQuit\s*=\s*false/,
    'an abandoned download would install itself on quit',
  )

  const preload = read('src', 'preload', 'index.ts')
  assert.match(preload, /CH\.updateInstall/, 'preload does not bridge the install channel')
  assert.match(preload, /EV\.updateProgress/, 'preload does not bridge download progress')
})

test('"Get the update" is a button that installs, not a link to a web page', () => {
  /**
   * THE REGRESSION THE USER ACTUALLY REPORTED. The old dialog rendered an
   * anchor to the release page. It worked exactly as written and was still
   * read as broken, because opening a browser at a 100 MB installer is not
   * what "Get the update" promises, and the app you are looking at is
   * unchanged when you come back to it.
   */
  const dialog = read('src', 'renderer', 'panes', 'vault', 'UpdateDialog.tsx')
  assert.doesNotMatch(
    dialog,
    /<a[^>]*href=\{url\}[^>]*onClick=\{onGet\}/,
    'Get the update is an anchor again, so it opens a page instead of updating',
  )
  assert.match(dialog, /<button[^>]*onClick=\{onGet\}/s, 'Get the update is not a button')
})
