/**
 * Test helper: a minimal HTTP server mimicking server.py's vault API.
 * Runs on a free port; point vault.mjs at it via environment override.
 */

import { createServer } from 'http'
import { URL } from 'url'

export function startMockVault(state) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const path = url.pathname

        // CORS checks that server.py does
        const bad = checkBadOrigin(req)
        if (bad) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: bad }))
          return
        }

        if (req.method === 'GET' && path === '/notes') {
          const notes = Object.entries(state.notes).map(([rel]) => ({
            path: rel,
            title: rel.split('/').pop().replace(/\.md$/i, ''),
            folder: rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '(root)',
            type: '',
            depth: 1,
            orphan: false,
          }))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(notes))
          return
        }

        if (req.method === 'GET' && path.startsWith('/note')) {
          const sp = new URL(req.url, `http://${req.headers.host}`)
          const notePath = sp.searchParams.get('path')
          if (!notePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'missing path' }))
            return
          }
          const note = state.notes[notePath]
          if (!note) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `not found: ${notePath}` }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              path: notePath,
              text: note.text,
              mtime: note.mtime,
            }),
          )
          return
        }

        if (req.method === 'POST' && path === '/save') {
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
          })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              const note = state.notes[data.path]

              // Check stale mtime guard
              if (note && data.mtime !== note.mtime) {
                res.writeHead(409, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'stale mtime', mtime: note.mtime }))
                return
              }

              // Save the note
              const newMtime = Date.now() * 1_000_000 // nanoseconds
              state.notes[data.path] = { text: data.text, mtime: newMtime }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  ok: true,
                  issues: [],
                  mtime: newMtime,
                }),
              )
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: String(e) }))
            }
          })
          return
        }

        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{}')
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(e) }))
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr !== 'string') {
        const url = `http://127.0.0.1:${addr.port}`
        resolve({
          url,
          close: () =>
            new Promise((res, rej) => {
              server.close((err) => (err ? rej(err) : res()))
            }),
        })
      } else {
        reject(new Error('could not bind server'))
      }
    })
  })
}

function checkBadOrigin(req) {
  const host = (req.headers.host || '').toLowerCase()
  // Accept localhost or 127.0.0.1
  if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost')) {
    return 'bad host'
  }
  // Node fetch doesn't set Origin on loopback, so we're permissive here
  return null
}
