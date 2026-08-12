/**
 * Renders the real layer stack — artwork, scrim, graph canvas — and writes two
 * PNGs so the halo can be judged by eye without guessing.
 *
 *   npx electron bench/halo/shot.cjs
 *
 * Writes bench/halo/out-with.png and out-without.png.
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

async function shot(win, halo, file) {
  await win.loadFile(path.join(__dirname, 'shot.html'), {
    search: halo ? 'halo=on' : 'halo=off',
  })
  // The page paints synchronously in its script, but capturePage can still land
  // before the compositor has the frame; one rAF-ish beat avoids a blank shot.
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, file), img.toPNG())
  console.log('wrote', file)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    useContentSize: true,
    webPreferences: { offscreen: false },
  })
  try {
    await shot(win, true, 'out-with.png')
    await shot(win, false, 'out-without.png')
    app.exit(0)
  } catch (e) {
    console.error('shot failed:', e)
    app.exit(1)
  }
})
