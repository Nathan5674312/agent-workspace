import { registerHooks } from 'node:module'
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const STUBS = {
  'stub:electron': `export const BrowserWindow={getFocusedWindow:()=>globalThis.__S3.focused,getAllWindows:()=>globalThis.__S3.windows};export const app={getPath:()=>globalThis.__S3.userData}`,
  'stub:child_process': `export function execSync(c,o){globalThis.__S3.calls.push(['execSync',c]);return globalThis.__S3.exec(c,o)}
export function execFileSync(f,a,o){globalThis.__S3.calls.push(['execFileSync',f,a]);return globalThis.__S3.execFile(f,a,o)}`,
}
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'node:child_process' || spec === 'child_process') return { url: 'stub:child_process', shortCircuit: true }
    if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) {
      const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL)
      if (!existsSync(fileURLToPath(new URL(spec, ctx.parentURL))) && existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) { return STUBS[url] ? { format: 'module', source: STUBS[url], shortCircuit: true } : next(url, ctx) },
})
const dir = mkdtempSync(join(tmpdir(), 's3-'))
globalThis.__S3 = { focused: null, windows: [], userData: dir, calls: [], exec: () => { throw new Error('x') }, execFile: () => { throw new Error('x') } }
const n = await import('./src/main/network.ts')

// --- Scenario 1: at home. gateway MAC detectable.
globalThis.__S3.exec = (cmd) => {
  if (cmd.includes('Get-NetRoute')) return '192.168.1.1\r\n'
  if (cmd.startsWith('arp')) return '\r\nInterface: 192.168.1.100 --- 0xa\r\n  Internet Address      Physical Address      Type\r\n  192.168.1.1           aa-bb-cc-dd-ee-ff     dynamic\r\n'
  if (cmd.includes('netsh')) return '\r\n    Name  : Wi-Fi\r\n    State : connected\r\n    SSID  : HomeNet\r\n    BSSID : aa:bb:cc:dd:ee:f0\r\n'
  if (cmd.includes('Get-NetConnectionProfile')) return 'Private\r\n'
  throw new Error('unexpected ' + cmd)
}
console.log('home before trust:', JSON.stringify(n.detectNetwork()))
console.log('home after trust :', JSON.stringify(n.trustCurrentNetwork(true)))
console.log('store:', readFileSync(join(dir,'network-trust.json'),'utf8').replace(/\s+/g,' '))

// --- Scenario 2: hostile AP. SSID is literally the home gateway MAC. gateway MAC undetectable (e.g. ARP cache cold / VPN).
globalThis.__S3.exec = (cmd) => {
  if (cmd.includes('Get-NetRoute')) return '10.0.0.1\r\n'
  if (cmd.startsWith('arp')) return 'No ARP Entries Found.\r\n'
  if (cmd.includes('netsh')) return '\r\n    SSID  : aa-bb-cc-dd-ee-ff\r\n    BSSID : 66:77:88:99:aa:bb\r\n'
  if (cmd.includes('Get-NetConnectionProfile')) return 'Public\r\n'
  throw new Error('unexpected ' + cmd)
}
console.log('HOSTILE AP with SSID == trusted MAC:', JSON.stringify(n.detectNetwork()))

// --- Scenario 3: multiple default gateways (VPN up)
globalThis.__S3.calls = []
globalThis.__S3.exec = (cmd) => {
  if (cmd.includes('Get-NetRoute')) return '192.168.1.1\r\n10.8.0.1\r\n'
  if (cmd.startsWith('arp')) return 'garbage'
  if (cmd.includes('netsh')) return '    SSID  : HomeNet\r\n'
  if (cmd.includes('Get-NetConnectionProfile')) return 'Private\r\n'
  throw new Error('unexpected')
}
console.log('VPN multi-gw:', JSON.stringify(n.detectNetwork()))
console.log('arp cmd issued:', JSON.stringify(globalThis.__S3.calls.filter(c=>String(c[1]).startsWith('arp'))))

// --- Scenario 4: corrupt store shape
writeFileSync(join(dir,'network-trust.json'), '{"trustedNetworks":"pwned"}')
try { console.log('bad-shape store:', JSON.stringify(n.detectNetwork())) } catch (e) { console.log('bad-shape store THREW:', e.constructor.name, e.message) }
