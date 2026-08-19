/**
 * The terminal's main-process half: what the agent dashboard reads, and the one
 * door to the operating system.
 *
 * TWO SURFACES, and they are deliberately not the same thing:
 *
 *   READ-ONLY   `processes` and `exits` report what the supervisor already
 *               knows. No side effects, nothing to gate.
 *   THE SHELL   `run` executes a command. Everything about it is arranged so
 *               that it cannot happen quietly.
 *
 * WHY THE SHELL ASKS EVEN THOUGH THE USER TYPED IT:
 *
 * consent.ts draws the line at WHO — user-originated actions proceed silently,
 * because prompting someone for permission to do the thing they just asked for
 * is approval fatigue, and a human trained to click through a prompt is worse
 * off than one never prompted. That reasoning is right for vault writes and it
 * does NOT carry to arbitrary command execution.
 *
 * The difference is blast radius and reversibility. A vault write is bounded by
 * `resolveInVault`, backed up in `.backups/`, and undoable. A shell command is
 * bounded by nothing: it runs as the user, over the whole disk and the network,
 * and `.backups/` will not bring back what `rm -rf` removed. The renderer is
 * also the least trusted part of this app — the corner pane already documents a
 * `javascript:` bypass where agent-supplied input reached page script holding
 * the full bridge. An exec channel that trusts "the renderer said the user
 * typed it" would hand that same bypass a shell.
 *
 * So the gate here is on the ACT, not the actor, and it is the only place in
 * this app where that is true. Nathan chose this shape explicitly: slash
 * commands run freely, anything touching the OS asks first.
 */
import { execFile } from 'node:child_process'
import type { Handle } from './ipc.js'
import { CH, type ShellResult } from '../shared/ipc.js'
import { requestConsent } from './corner.js'
import { getVaultDir } from './vault.js'
import { listExits, listProcesses, kill } from './supervisor.js'

/** Hard ceiling on a command. A shell that never returns hangs the panel. */
const TIMEOUT_MS = 30_000

/**
 * Output kept per command. Enough for `git log`, far short of what a runaway
 * `type bigfile` would send across the bridge.
 */
const MAX_OUTPUT = 200_000

export function register(handle: Handle): void {
  handle(CH.terminalProcesses, async () => listProcesses())
  handle(CH.terminalExits, async () => listExits())

  handle(CH.terminalKill, async (sessionId: string) => {
    if (typeof sessionId !== 'string') throw new Error('terminal: session id must be a string')
    return kill(sessionId)
  })

  handle(CH.terminalRun, async (command: string): Promise<ShellResult> => {
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('terminal: command must be a non-empty string')
    }
    const cmd = command.trim()
    const cwd = getVaultDir()

    /**
     * ASK FIRST — before anything is spawned, and showing the command verbatim.
     *
     * The string put in front of the human is the exact string that will run.
     * Summarising it ("run a git command?") is how a prompt becomes a rubber
     * stamp: the whole value of the gate is that the thing approved and the
     * thing executed are the same text.
     */
    const allowed = await requestConsent({
      title: 'Run a shell command',
      detail: `Run this in ${cwd}:\n\n${cmd}`,
      severity: 'warn',
    })
    if (!allowed) {
      return { ok: false, denied: true, code: null, stdout: '', stderr: '' }
    }

    return await new Promise<ShellResult>((resolve) => {
      /**
       * `execFile` with an explicit interpreter, never `exec`.
       *
       * `exec` builds a command line by string concatenation, so it is the
       * function that turns a quoting mistake into an injection. Here the
       * command is one argument handed to one interpreter, which is also why
       * `shell: false` is left at its default.
       *
       * PowerShell rather than cmd: it is what this machine's other tooling
       * assumes, and `-NoProfile` keeps a user profile from changing what a
       * command means between machines.
       */
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true },
        (err, stdout, stderr) => {
          // A non-zero exit is a RESULT, not a transport failure — `git status`
          // in a non-repo should print git's complaint, not an app error.
          const code =
            err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
              ? ((err as unknown as { code: number }).code)
              : err
                ? 1
                : 0
          resolve({
            ok: !err,
            denied: false,
            code,
            stdout: String(stdout).slice(0, MAX_OUTPUT),
            stderr: String(stderr).slice(0, MAX_OUTPUT) || (err ? err.message : ''),
          })
        },
      )
    })
  })
}
