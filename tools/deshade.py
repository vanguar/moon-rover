"""Remove the illumination baked into a site's orthophotos (used as albedo).

Mars (default): HiRISE, afternoon Sun.

The orthophoto is used as albedo, but HiRISE imaged Jezero with the Sun in the
west (~35° high, fitted below), so ridges (TARs) carry photographed shading and
shadows. Under the game's own lighting — and especially in a dust storm, when the
light is diffuse — they show up as "shadows" that are not there.

Method: fit the Sun direction by correlating the high-passed orthophoto with a
Lambert hillshade of the DTM, regress the photo's relative brightness on the
shading, and divide it out. Detail finer than the DTM (rocks, sand texture) stays.

The Moon's Apollo 17 orthomosaic (LROC NAC) carries its own lunar-morning shading the
same way: python tools/deshade.py --dir public/data/apollo17 --backup raw_data/apollo17/ortho_shaded
(the Sun direction is then searched over the whole sky).

Usage: python tools/deshade.py   (Mars; originals are kept in raw_data/mars/ortho_shaded)
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


def _arg(name, default):
    import sys

    return os.path.join(ROOT, sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


D = _arg("--dir", os.path.join(ROOT, "public", "data", "mars"))
BK = _arg("--backup", os.path.join(ROOT, "raw_data", "mars", "ortho_shaded"))
# Mars: the HiRISE Sun was in the west; elsewhere search the whole sky.
MARS = D == os.path.join(ROOT, "public", "data", "mars")
AZ = range(240, 301, 5) if MARS else range(0, 360, 5)
# --steep: fit only where the ground slopes (> 4°) - for a site that is flat dust save
# for one landform (the Pavonis pit), where flat ground would swamp the fit.
STEEP = "--steep" in __import__("sys").argv
EL = range(20, 61, 5) if MARS else range(5, 66, 5)


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
    h = heightmap_io.load(D).astype(np.float64) * m.get("heightStep", (m["maxHeight"] - m["minHeight"]) / 65535)
    px = m["pixelSize"]
    o = np.asarray(Image.open(os.path.join(BK, "ortho.jpg")).convert("L")).astype(np.float64)
    o2 = np.asarray(Image.fromarray(o.astype(np.uint8)).resize(h.shape[::-1], Image.BILINEAR)).astype(np.float64)
    # High-pass of 8 cells; a lone landform (--steep) is fitted on its own scale (~30 m),
    # since the fine scale there is mostly DTM noise.
    hp = lambda a: a - ndimage.gaussian_filter(a, 30 if STEEP else 8)
    if STEEP:
        # Only the steep landform: a box around it, fitted where the slope is over 4°.
        sl = np.degrees(np.arctan(np.hypot(*np.gradient(h, px))))
        # The largest steep patch (the landform itself, not scattered DTM noise).
        lab, n = ndimage.label(ndimage.binary_opening(sl > 12, iterations=2))
        sizes = ndimage.sum(lab > 0, lab, range(1, n + 1))
        rr, cc = np.where(lab == int(np.argmax(sizes)) + 1)
        r0, r1 = max(0, rr.min() - 40), min(h.shape[0], rr.max() + 40)
        c0, c1 = max(0, cc.min() - 40), min(h.shape[1], cc.max() + 40)
        hs_, os_ = h[r0:r1, c0:c1], o2[r0:r1, c0:c1]
        sel = sl[r0:r1, c0:c1] > 4
        stp = 1
        print(f"Fit on the steep landform: box {r1 - r0} x {c1 - c0} m-cells, {sel.mean() * 100:.0f}% of it sloping")
    else:
        hs_, os_ = h[::3, ::3], o2[::3, ::3]
        sel = np.ones(hs_.shape, bool)
        stp = 3
    ohp = hp(os_)[sel]
    best = None
    for az in AZ:
        for el in EL:
            f = hp(shade(hs_, px * stp, az, el))[sel]
            c = np.corrcoef(f.ravel(), ohp.ravel())[0, 1]
            if best is None or c > best[0]:
                best = (c, az, el)
    c, az, el = best
    s = shade(h, px, az, el)
    flat = math.sin(math.radians(el))
    rel = s / flat - 1.0
    oo = o2 / ndimage.gaussian_filter(o2, 30 if STEEP else 8) - 1.0
    full_sel = (np.hypot(*np.gradient(h, px)) > math.tan(math.radians(4))) if STEEP else np.ones(h.shape, bool)
    beta = float(np.sum((hp(rel) * oo)[full_sel]) / np.sum((hp(rel) ** 2)[full_sel]))
    print(f"Photo Sun fit: azimuth {az}°, elevation {el}° (r = {c:.2f}); shading gain {beta:.2f}")
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
