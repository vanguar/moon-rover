"""Remove the illumination baked into the Mars orthophotos (HiRISE, afternoon Sun).

The orthophoto is used as albedo, but HiRISE imaged Jezero with the Sun in the
west (~35° high, fitted below), so ridges (TARs) carry photographed shading and
shadows. Under the game's own lighting — and especially in a dust storm, when the
light is diffuse — they show up as "shadows" that are not there.

Method: fit the Sun direction by correlating the high-passed orthophoto with a
Lambert hillshade of the DTM, regress the photo's relative brightness on the
shading, and divide it out. Detail finer than the DTM (rocks, sand texture) stays.

Usage: python tools/deshade_mars.py   (originals are kept in raw_data/mars/)
"""
import json
import math
import os
import shutil

import numpy as np
from PIL import Image
from scipy import ndimage

import heightmap_io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "public", "data", "mars")
BK = os.path.join(ROOT, "raw_data", "mars", "ortho_shaded")


def shade(h, px, az, el):
    gy, gx = np.gradient(h, px)
    nx, ny, nz = -gx, np.ones_like(h), gy
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    a, e = math.radians(az), math.radians(el)
    s = (math.sin(a) * math.cos(e), math.sin(e), -math.cos(a) * math.cos(e))
    return np.clip((nx * s[0] + ny * s[1] + nz * s[2]) / l, 0, None)


def main():
    m = json.load(open(os.path.join(D, "terrain.json"), encoding="utf-8"))
    os.makedirs(BK, exist_ok=True)
    for f in ("ortho.jpg", "ortho_hi.jpg"):
        if not os.path.exists(os.path.join(BK, f)):
            shutil.copy(os.path.join(D, f), os.path.join(BK, f))
    h = heightmap_io.load(D).astype(np.float64) * (m["maxHeight"] - m["minHeight"]) / 65535
    px = m["pixelSize"]
    o = np.asarray(Image.open(os.path.join(BK, "ortho.jpg")).convert("L")).astype(np.float64)
    o2 = np.asarray(Image.fromarray(o.astype(np.uint8)).resize(h.shape[::-1], Image.BILINEAR)).astype(np.float64)
    hp = lambda a: a - ndimage.gaussian_filter(a, 8)
    sub = (slice(0, None, 3), slice(0, None, 3))
    best = None
    for az in range(240, 301, 5):
        for el in range(20, 61, 5):
            f = hp(shade(h[sub], px * 3, az, el))
            c = np.corrcoef(f.ravel(), hp(o2[sub]).ravel())[0, 1]
            if best is None or c > best[0]:
                best = (c, az, el)
    c, az, el = best
    s = shade(h, px, az, el)
    flat = math.sin(math.radians(el))
    rel = s / flat - 1.0
    oo = o2 / ndimage.gaussian_filter(o2, 8) - 1.0
    beta = float(np.sum(hp(rel) * oo) / np.sum(hp(rel) ** 2))
    print(f"HiRISE Sun fit: azimuth {az}°, elevation {el}° (r = {c:.2f}); shading gain {beta:.2f}")
    # Relative shading factor on the DTM grid, resampled to each image.
    factor = np.clip(1.0 + beta * ndimage.gaussian_filter(rel, 0.7), 0.35, 2.5)
    fac_img = Image.fromarray(factor.astype(np.float32), mode="F")

    def fix(name, rect):
        src = np.asarray(Image.open(os.path.join(BK, name)).convert("L")).astype(np.float64)
        n = src.shape[0]
        if rect is None:
            f = np.asarray(fac_img.resize((n, n), Image.BILINEAR))
        else:
            # ortho_hi covers a square (x, z, size) in game metres; crop the factor grid.
            half = m["sizeX"] / 2
            x0 = (rect["x"] - rect["size"] / 2 + half) / px
            z0 = (rect["z"] - rect["size"] / 2 + half) / px
            sz = rect["size"] / px
            f = np.asarray(fac_img.transform((n, n), Image.EXTENT, (x0, z0, x0 + sz, z0 + sz), Image.BILINEAR))
        out = np.clip(src / f, 0, 255)
        Image.fromarray(out.astype(np.uint8)).save(os.path.join(D, name), quality=90, optimize=True, progressive=True)
        print(f"  {name}: de-shaded")

    fix("ortho.jpg", None)
    fix("ortho_hi.jpg", m.get("orthoHi"))


if __name__ == "__main__":
    main()
