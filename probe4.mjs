import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const STUBS = {
  'stub:electron': `export const BrowserWindow={getFocusedWindow:()=>globalThis.__S3.focused,getAllWindows:()=>globalThis.__S3.windows};export const app={getPath:()=>globalThis.__S3.userData}`,
  'stub:child_process': `export function execSync(){throw new Error('x')};export function execFileSync(){throw new Error('x')}`,
}
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'stub:electron', shortCircuit: true }
    if (spec === 'node:child_process') return { url: 'stub:child_process', shortCircuit: true }
    if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) {
      const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL)
      if (!existsSync(fileURLToPath(new URL(spec, ctx.parentURL))) && existsSync(fileURLToPath(ts))) return { url: ts.href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
  load(url, ctx, next) { return STUBS[url] ? { format: 'module', source: STUBS[url], shortCircuit: true } : next(url, ctx) },
})
const sent = []
const win = { webContents: { send: (ch, p) => sent.push([ch, p]) } }
globalThis.__S3 = { focused: null, windows: [win], userData: process.cwd() }
const c = await import('./src/main/corner.ts')
const handlers = new Map()
c.register((ch, fn) => handlers.set(ch, fn))
const { CH } = await import('./src/shared/ipc.ts')

// A) consent raised while NO window is focused (app in background — the normal case)
let settled = 'PENDING'
const p = c.requestConsent({ title: 'Write file', detail: 'x', severity: 'info' })
p.then(v => settled = 'RESOLVED:' + v)
console.log('A) sent to renderer while unfocused:', JSON.stringify(sent))
console.log('A) items() sees it:', handlers.get(CH.cornerItems)().length)

// B) dismiss the consent
const id = handlers.get(CH.cornerItems)()[0].id
handlers.get(CH.cornerDismiss)(id)
await new Promise(r => setTimeout(r, 50))
console.log('B) after dismiss -> promise:', settled, '| items:', handlers.get(CH.cornerItems)().length)
console.log('B) can it still be decided?', handlers.get(CH.cornerDecide)({id, allow:true}) ?? 'no-throw')
await new Promise(r => setTimeout(r, 50))
console.log('B) after late decide -> promise:', settled)

// C) normal decide path
globalThis.__S3.focused = win; sent.length = 0
let s2 = 'PENDING'
c.requestConsent({ title:'t', detail:'d', severity:'info' }).then(v => s2 = 'RESOLVED:'+v)
const id2 = handlers.get(CH.cornerItems)()[0].id
handlers.get(CH.cornerDecide)({ id: id2, allow: false })
await new Promise(r => setTimeout(r, 20))
console.log('C) deny ->', s2, '| events:', sent.map(s=>s[0]))

// D) id shape
const ids = new Set()
for (let i=0;i<50000;i++) ids.add(Math.random().toString(36).slice(2))
console.log('D) 50k random ids, min length:', Math.min(...[...ids].map(s=>s.length)), 'collisions:', 50000-ids.size)

// E) no timeout auto-resolve
let s3='PENDING'; c.requestConsent({title:'t',detail:'d',severity:'info'}).then(v=>s3='RESOLVED:'+v)
await new Promise(r=>setTimeout(r,300))
console.log('E) after 300ms with no answer:', s3)
process.exit(0)
