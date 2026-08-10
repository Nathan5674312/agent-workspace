import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STUBS = {
  'stub:electron': `
    export const BrowserWindow = { getFocusedWindow: () => globalThis.__S3.focused, getAllWindows: () => globalThis.__S3.windows }
    export const app = { getPath: () => globalThis.__S3.userData }
  `,
  'stub:child_process': `
    export function execSync(cmd, opts) { return globalThis.__S3.exec(cmd, opts) }
    export function execFileSync(file, args, opts) { return globalThis.__S3.execFile(file, args, opts) }
  `,
}
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'node:child_process' || spec === 'child_process') return { url: 'stub:child_process', shortCircuit: true }
    if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) {
      const guess = new URL(spec, ctx.parentURL)
      if (!existsSync(fileURLToPath(guess)) && existsSync(fileURLToPath(new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL)))) {
        return { url: new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) {
    if (STUBS[url]) return { format: 'module', source: STUBS[url], shortCircuit: true }
    return next(url, ctx)
  },
})
globalThis.__S3 = { focused: null, windows: [], userData: process.cwd(), exec: () => { throw new Error('no') }, execFile: () => { throw new Error('no') } }
const c = await import('./src/main/corner.ts')
const n = await import('./src/main/network.ts')
console.log('corner:', Object.keys(c))
console.log('network:', Object.keys(n))
console.log('detectNetwork with all-throwing exec:', JSON.stringify(n.detectNetwork()))
