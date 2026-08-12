/**
 * Runs bench.html in the real runtime and prints the result to stdout.
 *
 *   npx electron bench/halo/main.cjs
 *
 * Electron is the browser this app actually ships in, so the numbers come from
 * the same Chromium and the same GPU path as production rather than from a
 * canvas shim. The window is hidden; the page's console is forwarded out.
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.disableHardwareAcceleration = app.disableHardwareAcceleration // no-op, kept explicit

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 960 })

  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('RESULT ')) {
      const data = JSON.parse(message.slice(7))
      const rows = Object.entries(data)
      const base = data.baseline
      console.log('\nms per frame — 250 nodes, 850 links, best of 3 interleaved runs\n')
      for (const [name, ms] of rows) {
        const delta = name === 'baseline' ? '' : `  (+${(ms - base).toFixed(2)} vs baseline)`
        console.log(`  ${name.padEnd(20)} ${ms.toFixed(3)} ms${delta}`)
      }
      const budget = 1000 / 60
      console.log(`\n  60fps budget is ${budget.toFixed(2)} ms/frame\n`)
      app.exit(0)
    } else {
      console.log('[page]', message)
    }
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('renderer gone:', details)
    app.exit(1)
  })

  win.loadFile(path.join(__dirname, 'bench.html'))

  setTimeout(() => {
    console.error('bench timed out')
    app.exit(1)
  }, 120000)
})
