/**
 * Test helper: a minimal HTTP server mimicking server.py's vault API.
 * Runs on a free port; point vault.mjs at it via environment override.
 *
 * OPT-IN knobs on `state`, all absent by default so existing suites see the
 * exact behaviour they saw before:
 *
 *   state.pythonGuard   - replicate server.py's REAL /save lost-update guard
 *                         (server.py:703-708) instead of the stricter one below.
 *                         The real one only runs when the request carries a
 *                         non-null `mtime`; that difference is a data-loss bug
 *                         the strict version hides.
 *   state.saveBodies    - array; every raw /save request body is pushed to it,
 *                         so a test can assert what actually went on the wire
 *                         (a dropped `mtime` key is invisible from the outside).
 *   state.respond       - fn({method, path, url, data}) -> {status, body} to
 *                         answer with, the string 'hang' to never answer at all,
 *                         or a falsy value to fall through to normal handling.
 *   state.noteDelayMs   - hold each GET /note open this long before answering,
 *                         so overlapping requests are observable.
 *   state.inflight      - initialise to 0 to have GET /note track concurrency;
 *                         the peak is written to state.peak.
 *   state.reads         - array; every GET /note path is pushed to it in
 *                         request order. A DIRECT measurement of what was
 *                         fetched, for tests that need "exactly once" — edge
 *                         counts can no longer show it now that graph() dedups
 *                         repeated links to the same target.
 */

import { createServer } from 'http'
import { URL } from 'url'

export function startMockVault(state) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const path = url.pathname

        if (typeof state.respond === 'function' && req.method !== 'POST') {
          const r = state.respond({ method: req.method, path, url })
          if (r === 'hang') return // deliberately never answer
          if (r) {
            res.writeHead(r.status, { 'Content-Type': 'application/json' })
            res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
            return
          }
        }

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
          if (Array.isArray(state.reads)) state.reads.push(notePath)
          if (state.inflight !== undefined) {
            state.inflight++
            state.peak = Math.max(state.peak ?? 0, state.inflight)
          }
          const send = () => {
            if (state.inflight !== undefined) state.inflight--
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                path: notePath,
                text: note.text,
                mtime: note.mtime,
              }),
            )
          }
          if (state.noteDelayMs) setTimeout(send, state.noteDelayMs)
          else send()
          return
        }

        if (req.method === 'POST' && path === '/save') {
          let body = ''
          req.on('data', (chunk) => {
            body += chunk
          })
          req.on('end', () => {
            try {
              if (Array.isArray(state.saveBodies)) state.saveBodies.push(body)
              const data = JSON.parse(body)

              if (typeof state.respond === 'function') {
                const r = state.respond({ method: 'POST', path, url, data })
                if (r === 'hang') return
                if (r) {
                  res.writeHead(r.status, { 'Content-Type': 'application/json' })
                  res.end(
                    typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
                  )
                  return
                }
              }

              const note = state.notes[data.path]

              // server.py:703-708 verbatim:
              //   if p.exists() and data.get("mtime") is not None:
              //       cur = p.stat().st_mtime_ns
              //       if int(data["mtime"]) != cur: -> 409
              // A body with no `mtime` key, or `mtime: null`, skips the guard.
              if (state.pythonGuard) {
                if (note && data.mtime !== undefined && data.mtime !== null) {
                  if (Number(data.mtime) !== note.mtime) {
                    res.writeHead(409, { 'Content-Type': 'application/json' })
                    res.end(
                      JSON.stringify({
                        error: 'note changed since you opened it',
                        mtime: note.mtime,
                      }),
                    )
                    return
                  }
                }
              } else if (note && data.mtime !== note.mtime) {
                // Stricter than server.py; kept as the default so the existing
                // suite's expectations do not move.
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
