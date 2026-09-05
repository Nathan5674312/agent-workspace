"""
Parchment's own copy of the canvas artwork.

WHY A SECOND FILE. `canvas-art-treated.jpg` is not a neutral image with an
opacity on it: tokens.css bakes a duotone running Ink -> Sand into the pixels,
so the shipped artwork is MADE OF the dark palette. On Parchment — the one
light theme — that file is near-black where the paper should show, and no
opacity value rescues it, because the treatment is in the pixels. So Parchment
shipped with `--canvas-art: none` and the artwork was simply absent there.

This is the recipe in tokens.css run in the other direction, which that comment
already named as the fix:

  1. convert('L')             graphite is already tonal
  2. NO INVERT                the master is a LIGHT image (mean luminance
                              144.6/255) and Parchment is a light ground, so
                              the master's own tonal direction is already the
                              right one. This is the single step that differs.
  3. autocontrast, mirrored   (12, 1) rather than (1, 12): marks to true black,
                              paper to the top of the range. Same levels move,
                              reflected because step 2 no longer flipped it.
  4. duotone LUT, Umber -> Paper
                              every pixel becomes a colour BETWEEN two entries
                              of the Parchment palette, so the drawing is made
                              of this theme rather than grey sitting on it.

Regenerate:  python scripts/make-parchment-art.py
"""

from PIL import Image, ImageOps
import pathlib

ASSETS = pathlib.Path(__file__).resolve().parent.parent / "src" / "renderer" / "assets"
MASTER = ASSETS / "canvas-art.jpg"
OUT = ASSETS / "canvas-art-parchment.jpg"

# Both read out of :root[data-theme='parchment'] in src/renderer/themes.css.
# --accent is the darkest entry in that palette (12.74:1 on the paper), which is
# what Nathan asked for: whatever on the palette stands out most.
UMBER = (0x32, 0x25, 0x1B)  # --accent
PAPER = (0xF4, 0xED, 0xE1)  # --bg-app

src = Image.open(MASTER)
print(f"master {src.size} mode={src.mode}")

g = src.convert("L")
print(f"mean luminance before: {sum(g.histogram()[i] * i for i in range(256)) / (g.size[0] * g.size[1]):.1f}/255")

g = ImageOps.autocontrast(g, cutoff=(12, 1))

# colorize IS the duotone LUT: it interpolates every level between the two
# endpoints, which is exactly what step 4 describes.
out = ImageOps.colorize(g, black=UMBER, white=PAPER)

out.save(OUT, "JPEG", quality=88, optimize=True, progressive=True)
print(f"wrote {OUT.name}  {OUT.stat().st_size:,} bytes")
