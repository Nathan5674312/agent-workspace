/**
 * Rasterise build/icon.svg into the files electron-builder wants.
 *
 * Run: npm run icons   (i.e. `electron scripts/make-icons.mjs`)
 *
 * WHY ELECTRON AND NOT A LIBRARY. The repo already depends on Electron, and
 * Chromium is a correct SVG renderer. Every alternative — sharp, canvas,
 * resvg, an ImageMagick on PATH — is a new dependency or a new machine
 * assumption for a script that runs perhaps twice a year. This one adds
 * nothing to package.json and cannot rot separately from the app.
 *
 * WHY THE PAGE DRAWS ITSELF INTO A CANVAS rather than the main process calling
 * `webContents.capturePage()`. capturePage goes through the window compositor,
 * and on this machine a `transparent: true` BrowserWindow captures as 1024x1024
 * of literal zeroes — measured: a page holding one opaque #f0cba5 div returned
 * BGRA 0,0,0,0 at its centre pixel on six consecutive captures. It also raced
 * the first paint and silently wrote a blank png once. The canvas never touches
 * the compositor, keeps the alpha channel exactly as the SVG defines it, and is
 * deterministic: the promise does not resolve until the image has decoded.
 *
 * WHAT IT DOES NOT MAKE: .icns. electron-builder derives the macOS icon from
 * icon.png itself as long as that png is >= 512x512, and there is no macOS on
 * this machine to verify a hand-packed .icns against. Shipping an unverified
 * binary container is worse than letting the tool that builds the .app do it.
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build')

/**
 * Sizes Windows actually picks from: tray/titlebar, list views, taskbar, tiles.
 * The two smallest come from the hinted source — see build/icon-small.svg for
 * what it changes and why one master resampled to 16px does not work.
 */
const SOURCES = [
  { file: 'icon-small.svg', sizes: [16, 24] },
  { file: 'icon.svg', sizes: [32, 48, 64, 128, 256] },
]
const ICO_SIZES = SOURCES.flatMap((s) => s.sizes)
const MASTER = 1024

/**
 * Pack PNGs into an .ico. The format is a 6-byte header, a 16-byte directory
 * entry per image, then the image payloads — and since Vista the payload may be
 * a whole PNG file rather than a DIB, which is what makes this ~20 lines.
 * The one trap: a 256px image writes its dimension byte as 0, because the field
 * is a u8 and 256 does not fit.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, png }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2) // palette size — 0 for truecolour
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // colour planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += png.length
  })

  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

/**
 * Runs in the page. Decodes the SVG once at MASTER, then downsamples each icon
 * size off that raster rather than re-rendering the vector small — at 16px a
 * direct vector render drops the 4px rim entirely and aliases the ring's stroke
 * into a smudge, where a high-quality downscale of the big raster keeps both as
 * grey. Returns data URLs because that is what survives the IPC boundary.
 */
function rasterise(svg, sizes, master) {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('the SVG failed to decode'))
    img.onload = () => {
      const draw = (size, source) => {
        const c = document.createElement('canvas')
        c.width = size
        c.height = size
        const ctx = c.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(source, 0, 0, size, size)
        return c
      }
      const big = draw(master, img)
      const result = { [master]: big.toDataURL('image/png') }
      for (const size of sizes) result[size] = draw(size, big).toDataURL('image/png')
      resolve(result)
    }
    img.src = url
  })
}

const png = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')

app.disableHardwareAcceleration()

/**
 * Everything runs inside whenReady().then rather than after a top-level await.
 * Under Electron's ESM main-process loader a top-level `await app.whenReady()`
 * resolves and then the process exits without running the rest of the module —
 * silently, exit code 0, no output. Measured here on Electron 33.
 */
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  await win.loadURL('data:text/html,<body></body>')

  const frames = {}
  for (const { file, sizes } of SOURCES) {
    const svg = readFileSync(join(out, file), 'utf8')
    Object.assign(
      frames,
      await win.webContents.executeJavaScript(
        `(${rasterise})(${JSON.stringify(svg)}, ${JSON.stringify(sizes)}, ${MASTER})`,
      ),
      // The master png is whatever the LAST source produced, and SOURCES is
      // ordered so that is icon.svg. Deliberate: the 1024 master must be the
      // full mark, never the hinted one.
    )
  }

  mkdirSync(out, { recursive: true })

  // The master. electron-builder reads this one for macOS and Linux.
  writeFileSync(join(out, 'icon.png'), png(frames[MASTER]))
  writeFileSync(join(out, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, png: png(frames[size]) }))))

  console.log(`icon.png  ${MASTER}x${MASTER}  (icon.svg)`)
  for (const { file, sizes } of SOURCES) console.log(`icon.ico  ${sizes.join(', ').padEnd(24)}  (${file})`)

  app.quit()
})
