/**
 * SECTION 3 — network trust.
 *
 * The load-bearing rule: "private network" is OUR determination, not Windows'.
 * The OS public/private flag is user-set and frequently wrong, so it is reported
 * as advisory (`osProfile`) and MUST NOT be used on its own to suppress a
 * consent prompt.
 *
 * Trust = the network's fingerprint is in our own store because a human marked
 * it trusted in-app. Fingerprint should be the default gateway's MAC where we
 * can read it (an SSID is trivially spoofable by any nearby access point);
 * fall back to SSID only when the gateway MAC is unavailable, and treat that
 * fallback as weaker evidence.
 *
 * Untrusted or unknown network => the sync consent prompt fires. Always.
 * Fail closed: if we cannot determine the network, treat it as untrusted.
 */
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { Handle } from './ipc.js'
import { CH, type NetworkTrust } from '../shared/ipc.js'

/**
 * How a fingerprint was derived. This is part of the stored identity, not
 * metadata: a fingerprint is only ever compared against another fingerprint of
 * the SAME kind.
 *
 * Without this, `mac` and `ssid` fingerprints share one namespace, and an SSID
 * is an attacker-chosen string broadcast over the air. An AP named
 * "aa-bb-cc-dd-ee-ff" would match a home gateway trusted by that MAC. Gateway
 * MACs are not secret — consumer routers derive the BSSID in the beacon from
 * the LAN MAC — so that attack needs nothing but proximity.
 */
type FingerprintKind = 'mac' | 'ssid'

interface TrustedNetwork {
  kind: FingerprintKind
  /** Prefixed, e.g. "mac:aa-bb-cc-dd-ee-ff" or "ssid:HomeNet". */
  fingerprint: string
  ssid: string | null
}

interface TrustStore {
  trustedNetworks: TrustedNetwork[]
}

/** Path to our trust store. */
const trustStorePath = join(app.getPath('userData'), 'network-trust.json')

/** Build the namespaced fingerprint string. Never store a bare value. */
function fingerprintOf(kind: FingerprintKind, value: string): string {
  return `${kind}:${value}`
}

/**
 * Load the trust store from disk. Anything we cannot fully validate is
 * discarded — a malformed store means "nothing is trusted", never a throw and
 * never a partial trust list. The file is JSON we wrote, but it lives in a
 * user-writable directory, so it is parsed as untrusted input.
 */
function loadTrustStore(): TrustStore {
  try {
    const content = readFileSync(trustStorePath, 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== 'object' || parsed === null) return { trustedNetworks: [] }
    const list = (parsed as { trustedNetworks?: unknown }).trustedNetworks
    if (!Array.isArray(list)) return { trustedNetworks: [] }

    const trustedNetworks: TrustedNetwork[] = []
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const e = raw as Record<string, unknown>
      if (e.kind !== 'mac' && e.kind !== 'ssid') continue
      if (typeof e.fingerprint !== 'string' || !e.fingerprint) continue
      // A stored fingerprint must carry its own kind prefix. Legacy unprefixed
      // entries from before this guard existed are dropped, not upgraded: we
      // cannot tell which kind they were, and guessing is how the hole reopens.
      if (!e.fingerprint.startsWith(`${e.kind}:`)) continue
      trustedNetworks.push({
        kind: e.kind,
        fingerprint: e.fingerprint,
        ssid: typeof e.ssid === 'string' ? e.ssid : null,
      })
    }
    return { trustedNetworks }
  } catch {
    // File does not exist or is corrupt. Start fresh.
    return { trustedNetworks: [] }
  }
}

/**
 * Save the trust store to disk.
 *
 * Temp file + rename, never a bare writeFileSync. writeFileSync truncates
 * before it writes, so a crash or power loss mid-write leaves a 0-byte or
 * half-written file — and loadTrustStore() treats an unparseable store as
 * "nothing is trusted", so the failure is silent: every trusted network is
 * forgotten and the user is re-prompted with no error anywhere. rename is
 * atomic on NTFS, so the file on disk is either the old store or the new one.
 *
 * This is the same defect class fixed on the Python side on 2026-08-08
 * (`atomic_write()`); it was reintroduced here in TypeScript.
 */
function saveTrustStore(store: TrustStore): void {
  const tmp = `${trustStorePath}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, trustStorePath)
}

/**
 * Run a command with a fixed argument vector. `execFileSync` — never `exec*`
 * with a built string — so no value we read off the network is ever handed to
 * cmd.exe. Returns null instead of throwing: every caller here treats "could
 * not determine" as "untrusted", so failure must be a value, not an exception.
 *
 * Async. It was execFileSync, which blocks the ENTIRE main process: no IPC, no
 * window paints, nothing. detectNetwork() runs four of these at a 5s timeout
 * each, and register() exposes it on CH.networkTrustCurrent — so the renderer
 * could freeze every window in the app for up to 20 seconds by asking a
 * question. PowerShell startup alone is several hundred ms, so this was
 * reachable on a healthy machine, not just a broken one.
 */
const execFileAsync = promisify(execFile)

async function run(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * Detect SSID on Windows.
 * Uses `netsh wlan show interfaces` to read the currently connected SSID.
 * Returns null if not on WiFi or detection fails.
 */
async function detectSsid(): Promise<string | null> {
  const output = await run('netsh', ['wlan', 'show', 'interfaces'])
  if (!output) return null

  // Anchor to the start of the line: the same block contains a "BSSID :" line,
  // and an unanchored /SSID\s*:/ matches inside "BSSID" and captures a MAC.
  const match = output.match(/^\s*SSID\s*:\s*(.+?)\s*$/m)
  const ssid = match?.[1]?.trim()
  return ssid ? ssid : null
}

/** Only a literal dotted-quad reaches the arp lookup. */
function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  )
}

/**
 * Detect gateway MAC on Windows.
 * Uses `Get-NetRoute` via PowerShell to find the default gateway, then `arp -a`
 * to look up its MAC address. Returns null if detection fails — the caller
 * degrades to the weaker SSID fingerprint, never to "trusted".
 */
async function detectGatewayMac(): Promise<string | null> {
  const output = await run('powershell', [
    '-NoProfile',
    '-Command',
    'Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -ExpandProperty NextHop',
  ])
  if (!output) return null

  // A machine with a VPN, a second NIC, or Hyper-V has SEVERAL default routes,
  // so this is a list. Take the first usable one; 0.0.0.0 means "on-link", not
  // a gateway. Feeding the whole multi-line blob onward is how the old code
  // built a malformed command.
  const gatewayIp = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => isIpv4(line) && line !== '0.0.0.0')
  if (!gatewayIp) return null

  const arpOutput = await run('arp', ['-a', gatewayIp])
  if (!arpOutput) return null

  // arp output line looks like: "192.168.1.1           aa-bb-cc-dd-ee-ff     dynamic"
  const macMatch = arpOutput.match(
    /([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})/i,
  )
  if (!macMatch) return null

  // Normalize to lowercase hyphen-separated format.
  return macMatch[1].toLowerCase().replace(/:/g, '-')
}

/**
 * Detect the OS's reported network profile (public/private/domain).
 * Uses PowerShell to read Get-NetConnectionProfile.
 * Returns 'unknown' if detection fails.
 *
 * ADVISORY ONLY. Nothing in this file reads this value to decide `trusted`.
 */
async function detectOsProfile(): Promise<'public' | 'private' | 'domain' | 'unknown'> {
  const output = await run('powershell', [
    '-NoProfile',
    '-Command',
    'Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory',
  ])
  if (!output) return 'unknown'

  // Several adapters means several lines. Any single "Public" downgrades the
  // whole report — this is a warning channel, so the worst line wins.
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
  if (lines.includes('public')) return 'public'
  if (lines.includes('domainauthenticated')) return 'domain'
  if (lines.includes('private')) return 'private'
  return 'unknown'
}

/**
 * Determine if a fingerprint is in our trust store. Compared as the full
 * prefixed string, so a `ssid:` value can never satisfy a `mac:` entry.
 */
function isFingerprinted(fingerprint: string): boolean {
  const store = loadTrustStore()
  return store.trustedNetworks.some((n) => n.fingerprint === fingerprint)
}

/**
 * Detect the current network and return its NetworkTrust status.
 * CRITICAL: If we cannot determine the network, treat it as untrusted.
 * This is the fail-closed rule.
 */
export async function detectNetwork(): Promise<NetworkTrust> {
  // The three probes are independent, so they run concurrently. Sequentially
  // they stacked four subprocess timeouts end to end; the worst case was ~20s
  // of dead app, and the common case paid three PowerShell/netsh startups in a
  // row for no reason. Failure is still a value, never a throw, so one probe
  // dying cannot take the other two with it.
  const [mac, ssid, osProfile] = await Promise.all([
    detectGatewayMac(),
    detectSsid(),
    detectOsProfile(),
  ])

  // Prefer the gateway MAC; fall back to SSID, which is weaker evidence and is
  // recorded as such by its prefix.
  const kind: FingerprintKind | null = mac ? 'mac' : ssid ? 'ssid' : null
  const fingerprint = kind ? fingerprintOf(kind, kind === 'mac' ? mac! : ssid!) : null

  // No fingerprint at all => fail closed: untrusted.
  const trusted = fingerprint ? isFingerprinted(fingerprint) : false

  return {
    ssid,
    fingerprint,
    trusted,
    osProfile,
  }
}

/**
 * Get the current network.
 * If we cannot determine the network, always return untrusted.
 */
export async function getCurrentNetwork(): Promise<NetworkTrust> {
  return detectNetwork()
}

/**
 * Mark the current network as trusted or untrusted.
 * Only trusted networks bypass the consent prompt on sync operations.
 * Require a fingerprint to trust; if we cannot fingerprint, do nothing.
 */
export async function trustCurrentNetwork(trusted: unknown): Promise<NetworkTrust> {
  /**
   * Only literal `true` grants trust — the same rule corner.ts applies to a
   * consent decision, and for the same reason. The parameter arrives over IPC
   * from the renderer; the `boolean` annotation it used to carry is erased at
   * runtime and stopped nothing, so `trust("no")`, `trust(1)` and `trust({})`
   * all took the truthy branch and wrote a permanent trust entry that
   * suppresses every future prompt for that network.
   *
   * Anything else is a REVOCATION, not a no-op: a malformed grant must land on
   * the safe side, not be ignored.
   */
  const grant = trusted === true
  const current = await detectNetwork()

  if (!current.fingerprint) {
    // Cannot fingerprint, cannot trust. Return the current untrusted state.
    return current
  }

  const kind: FingerprintKind = current.fingerprint.startsWith('mac:') ? 'mac' : 'ssid'
  const store = loadTrustStore()

  if (grant) {
    // Add to trust store if not already there.
    if (!store.trustedNetworks.some((n) => n.fingerprint === current.fingerprint)) {
      store.trustedNetworks.push({
        kind,
        fingerprint: current.fingerprint,
        ssid: current.ssid,
      })
      saveTrustStore(store)
    }
  } else {
    // Remove from trust store.
    store.trustedNetworks = store.trustedNetworks.filter(
      (n) => n.fingerprint !== current.fingerprint,
    )
    saveTrustStore(store)
  }

  // Reflect the new state without re-running four subprocesses.
  return { ...current, trusted: grant }
}

export function register(handle: Handle): void {
  handle(CH.networkTrustCurrent, () => getCurrentNetwork())

  handle(CH.networkTrust, (trusted: unknown) => trustCurrentNetwork(trusted))
}
