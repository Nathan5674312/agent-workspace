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

/**
 * The size of the per-theme window icon.
 *
 * One size, not a set: `BrowserWindow.setIcon` takes a single image and Windows
 * scales it, unlike the .ico in the binary which carries every size. 256 is
 * what the task switcher asks for at 200% scaling and downsamples cleanly to
 * the 16px title bar.
 */
const THEMED_SIZE = 256

/**
 * WHERE THEME COLOURS COME FROM, and why they are read rather than listed.
 *
 * `src/shared/themes.ts` is a list of ids and words and says at length why it
 * holds no hex values: duplicating a colour so a second file can render it is
 * exactly the drift the token system exists to prevent. That applies here too.
 * So the icons are coloured by PARSING the stylesheets that already define the
 * palettes — tokens.css for the default, themes.css for the overrides — and a
 * theme whose colours change gets a new icon on the next `npm run icons` with
 * nothing else edited.
 *
 * Each theme needs four values. `--bg-app` is the ground; the top and bottom
 * gradient stops are derived from it rather than found, because no theme
 * defines a second ground tone and inventing token names to hold one would put
 * icon concerns into the app's stylesheet.
 */
function paletteOf(css, selector) {
  const block = css.slice(css.indexOf(selector))
  const body = block.slice(block.indexOf('{') + 1, block.indexOf('}'))
  const read = (name) => {
    const m = body.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`))
    return m ? m[1] : null
  }
  const bg = read('bg-app')
  const mark = read('accent') ?? read('label')
  return bg && mark ? { bg, mark } : null
}

/** Lighten or darken a hex by a fraction, staying in gamut. */
function shift(hex, amount) {
  const n = parseInt(hex.slice(1).padEnd(6, '0').slice(0, 6), 16)
  const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.max(0, Math.min(255, Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)))),
  )
  return '#' + parts.map((c) => c.toString(16).padStart(2, '0')).join('')
}

/** Substitute a palette into either source SVG. */
function paint(svg, { bg, mark }) {
  return svg
    .replace(/--ground-top:\s*#[0-9a-fA-F]+/, `--ground-top: ${shift(bg, 0.1)}`)
    .replace(/--ground-mid:\s*#[0-9a-fA-F]+/, `--ground-mid: ${bg}`)
    .replace(/--ground-bot:\s*#[0-9a-fA-F]+/, `--ground-bot: ${shift(bg, -0.25)}`)
    .replace(/--mark:\s*#[0-9a-fA-F]+/, `--mark: ${mark}`)
}
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

  /**
   * One icon per theme, for the window and the taskbar at runtime.
   *
   * The .ico inside the binary CANNOT follow the theme — it is read by the
   * shell for the Start Menu, the installer and the file on disk, long before
   * any of our code runs, and nothing may rewrite an installed executable.
   * `BrowserWindow.setIcon` is the part that can change, and it governs the
   * title bar, the task switcher and the taskbar button of a running window.
   * So: the binary keeps the default mark, and the running app wears the
   * user's.
   */
  const themedDir = join(out, 'themed')
  mkdirSync(themedDir, { recursive: true })

  const tokens = readFileSync(join(root, 'src/renderer/tokens.css'), 'utf8')
  const themesCss = readFileSync(join(root, 'src/renderer/themes.css'), 'utf8')
  const master = readFileSync(join(out, 'icon.svg'), 'utf8')

  // `founders` sets no data-theme attribute — its palette IS tokens.css — so it
  // is read from a different file and a different selector than the rest.
  const wanted = [
    ['founders', tokens, ':root {'],
    ...['dark', 'midnight', 'nord', 'forest', 'rosepine', 'parchment'].map((id) => [
      id,
      themesCss,
      `:root[data-theme='${id}']`,
    ]),
  ]

  for (const [id, css, selector] of wanted) {
    const palette = paletteOf(css, selector)
    if (!palette) {
      // Loud, and not fatal for the other six. A theme whose tokens were
      // renamed should fail visibly here rather than ship an icon in some other
      // theme's colours, which nobody would report as a bug.
      console.error(`themed/${id}.png  SKIPPED — no --bg-app/--accent under ${selector}`)
      continue
    }
    const out1 = await win.webContents.executeJavaScript(
      `(${rasterise})(${JSON.stringify(paint(master, palette))}, [${THEMED_SIZE}], ${MASTER})`,
    )
    writeFileSync(join(themedDir, `${id}.png`), png(out1[THEMED_SIZE]))
    console.log(`themed/${id}.png`.padEnd(26) + `ground ${palette.bg}  mark ${palette.mark}`)
  }

  app.quit()
})
