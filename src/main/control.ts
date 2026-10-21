/**
 * The app's end of the channel outside agents use: see shared/control.ts.
 *
 * Two requests, both POST, both carrying the token and the vault they mean:
 *   /open     bring a view forward ("show the graph", "open this board")
 *   /changed  an agent wrote to the vault; re-read the folder and the graph
 *
 * Failure here costs live views and nothing else. A port that will not bind or
 * a temp folder that will not take the file is swallowed, because an agent
 * that cannot drive the window still has every other tool, and the app must
 * not die over a convenience.
 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import { controlFile, parseOpen, sameVault, type ControlInfo } from '../shared/control.js'
import { EV } from '../shared/ipc.js'
import { getVaultDir, invalidateGraph } from './vault.js'

let server: Server | null = null
let token = ''
let announced: string | null = null
/** Whose windows to address. A parameter only so a test can hand in its own rather than patch Electron's. */
let windows = (): BrowserWindow[] => BrowserWindow.getAllWindows()

function broadcast(channel: string, payload: unknown): void {
  for (const win of windows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Resolves once the address is announced, so a caller can knock straight away. */
export function start(getWindows: () => BrowserWindow[] = () => BrowserWindow.getAllWindows()): Promise<void> {
  if (server) return Promise.resolve()
  windows = getWindows
  token = randomBytes(24).toString('hex')
  server = createServer((req, res) => {
    const reply = (code: number, text: string): void => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
    }
    if (req.method !== 'POST' || req.headers['x-fate-token'] !== token) return reply(403, 'Not for this app.')
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      let j: { vault?: unknown } | null = null
      try {
        j = JSON.parse(body)
      } catch {
        return reply(400, 'The body is not JSON.')
      }
      // The file is named after a vault, but the app can switch vaults after
      // writing it. A request for the old one must not drive the new one.
      if (typeof j?.vault !== 'string' || !sameVault(j.vault, getVaultDir())) {
        return reply(409, 'Fate has a different vault open.')
      }
      if (req.url === '/open') {
        const open = parseOpen(j)
        if (!open) return reply(400, 'Not a view this app can open.')
        const win = windows().find((w) => !w.isDestroyed())
        if (win) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
        broadcast(EV.agentOpen, open)
        return reply(200, 'ok')
      }
      if (req.url === '/changed') {
        invalidateGraph()
        broadcast(EV.vaultChanged, null)
        return reply(200, 'ok')
      }
      reply(404, 'Unknown request.')
    })
  })
  const s = server
  return new Promise((done) => {
    s.on('error', () => done())
    s.listen(0, '127.0.0.1', () => {
      announce()
      done()
    })
  })
}

/** (Re)write the file agents look for. On start, and whenever the open vault changes. */
export function announce(): void {
  const addr = server?.address()
  if (!addr || typeof addr === 'string') return
  try {
    if (announced) rmSync(announced, { force: true })
    announced = controlFile(getVaultDir())
    const info: ControlInfo = { port: addr.port, token, vault: getVaultDir(), pid: process.pid }
    writeFileSync(announced, JSON.stringify(info))
  } catch {
    announced = null
  }
}

export function stop(): void {
  try {
    if (announced) rmSync(announced, { force: true })
  } catch {}
  announced = null
  server?.close()
  server = null
}
