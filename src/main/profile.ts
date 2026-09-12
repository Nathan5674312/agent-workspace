/**
 * WHICH PROFILE THIS RUN WRITES TO, decided before anything reads it.
 *
 * Electron names the userData directory after package.json's `name`, so until
 * this file existed there was exactly ONE of them — `%APPDATA%\agent-workspace`
 * — and `npm run dev`, the installed app, and an agent driving a build over CDP
 * all shared it. Measured 2026-09-10: that directory held Nathan's real
 * settings.json next to a `DevToolsActivePort` left by an agent's
 * remote-debugging run. Every test run had been editing the settings of the app
 * he actually uses, and nothing about it was visible from either side.
 *
 * THE RULE: a build running out of `dist/` is a TEST, not an install. An
 * installed copy runs from wherever NSIS put it and never from the repo's own
 * build directory, so the executable's path is the honest signal — more honest
 * than `isPackaged`, which is TRUE for `dist/win-unpacked` and so cannot tell a
 * verification run apart from a user's app.
 *
 * WHAT IS DELIBERATELY UNTOUCHED: a packaged build running from an install
 * keeps the profile it has always had. Moving that would silently strand
 * everyone's settings behind a path they never asked to change, which is a
 * worse bug than the one this fixes.
 *
 * AN EXPLICIT `--user-data-dir` ALWAYS WINS. Electron has already applied it by
 * the time this runs, and overriding it here would break the one workflow that
 * needs a genuinely empty profile: watching onboarding happen for real.
 *
 * THIS MODULE IS A SIDE EFFECT AND MUST BE IMPORTED FIRST. `settings.ts`
 * resolves its path at module scope, and ESM evaluates every import before the
 * importing module's own body — so the same call written in index.ts's body
 * would run after settings.ts had already read the old location. Do not sort
 * this into the alphabetical import block; it is above them for a reason.
 */
import { app } from 'electron'

/** `dist\win-unpacked\FateVault.exe`, on either slash. */
const FROM_BUILD_DIR = /[\\/]dist[\\/]win-unpacked[\\/]/i

export const isTestRun = !app.isPackaged || FROM_BUILD_DIR.test(process.execPath)

const chosen = process.argv.some((a) => a.startsWith('--user-data-dir'))

if (isTestRun && !chosen) {
  /**
   * SUFFIXED, NOT REBUILT. `appData` + `getName()` would reconstruct the same
   * string on a good day and diverge on any other — and `getName()` is one more
   * method the security suite's Electron stub has to carry just to import
   * index.ts. Asking Electron where userData already is and adding four
   * characters cannot disagree with itself.
   */
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}
