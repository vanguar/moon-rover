"""Far terrain around the DTM window from SLDEM2015 (LOLA + SELENE/Kaguya TC, 59 m/px).

Gives the real skyline: Hadley Delta, Mons Hadley, the Apennine front, Hadley Rille.

Input  (raw_data/): sldem_512_rows_1470_2500.bin — rows 1470..2499 of
        SLDEM2015_512_00N_30N_000_045_FLOAT.IMG (float32 km above 1737.4 km),
        fetched with an HTTP range request (see README).
Output (public/data/): far_height.png  16-bit heights on a 112 m metric grid, 56 x 56 km
                       far_shadow.png  baked cast-shadow mask of the far terrain
                       shadow.png      near mask updated with shadows cast by distant massifs
                       terrain.json    gains "far": {...}

Usage: python tools/prepare_far.py   (after prepare_terrain.py)
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ephemeris import GAME_EPOCH, LunarSky  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data")
OUT = os.path.join(ROOT, "public", "data")
R_MOON = 1737400.0
ROW0, NROWS, NCOLS, PPD = 1470, 1030, 23040, 512
SPACING = 112.0
HALF = 28000.0


def sample_sldem(dem, lat, lon):
    r = (15359.5 - lat * PPD) - ROW0
    c = lon * PPD - 0.5
    r0 = np.clip(np.floor(r).astype(int), 0, NROWS - 2)
    c0 = np.clip(np.floor(c).astype(int), 0, NCOLS - 2)
    fr, fc = np.clip(r - r0, 0, 1), np.clip(c - c0, 0, 1)
    v = (dem[r0, c0] * (1 - fr) * (1 - fc) + dem[r0, c0 + 1] * (1 - fr) * fc
         + dem[r0 + 1, c0] * fr * (1 - fc) + dem[r0 + 1, c0 + 1] * fr * fc)
    return v * 1000.0


def march_shadow(h, step, az_deg, el_deg, max_d):
    """1 = lit, 0 = shadow; h on a square grid (rows = south, cols = east)."""
    n = h.shape[0]
    az, el = math.radians(az_deg), math.radians(el_deg)
    dc, dr = math.sin(az), -math.cos(az)
    tan_el = math.tan(el)
    rows, cols = np.mgrid[0:n, 0:n].astype(np.float64)
    lit = np.ones_like(h)
    for d in range(1, max_d):
        rr, cc = rows + dr * d, cols + dc * d
        inside = (rr >= 0) & (rr <= n - 1) & (cc >= 0) & (cc <= n - 1)
        if not inside.any():
            break
        ri = np.clip(np.round(rr).astype(int), 0, n - 1)
        ci = np.clip(np.round(cc).astype(int), 0, n - 1)
        lit[inside & (h[ri, ci] > h + d * step * tan_el + 1.0)] = 0
    return lit


def main():
    meta_path = os.path.join(OUT, "terrain.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    dem = np.fromfile(os.path.join(RAW, "sldem_512_rows_1470_2500.bin"), "<f4").reshape(NROWS, NCOLS)

    lat_c, lon_c = meta["centerLat"], meta["centerLon"]
    cos_sp = math.cos(math.radians(26.0))  # DTM projection standard parallel
    n = int(round(2 * HALF / SPACING)) + 1
    coords = (np.arange(n) - (n - 1) / 2) * SPACING
    zz, xx = np.meshgrid(coords, coords, indexing="ij")  # rows: z (south), cols: x (east)
    lat = lat_c - np.degrees(zz / R_MOON)
    lon = lon_c + np.degrees(xx / (R_MOON * cos_sp))
    h = sample_sldem(dem, lat, lon)

    # Vertical alignment with the NAC DTM over the DTM window.
    hm = np.asarray(Image.open(os.path.join(OUT, "heightmap.png")), dtype=np.float64)
    dtm = meta["minHeight"] + hm * meta.get("heightStep", (meta["maxHeight"] - meta["minHeight"]) / 65535.0)
    half_w = meta["sizeX"] / 2
    inwin = (np.abs(xx) < half_w) & (np.abs(zz) < half_w)
    offset = float(dtm.mean() - h[inwin].mean())
    h += offset
    print(f"Far grid {n}x{n} @ {SPACING} m, DTM alignment offset {offset:.1f} m, range {h.min():.0f}..{h.max():.0f}")

    rel = h - meta["minHeight"]
    lo, hi = float(rel.min()), float(rel.max())
    q = np.round((rel - lo) / (hi - lo) * 65535).astype(np.uint16)
    Image.fromarray(q, mode="I;16").save(os.path.join(OUT, "far_height.png"), optimize=True)

    sky = LunarSky(GAME_EPOCH, 26.13224, 3.63400)
    az, el = sky.az_el(sky.sun())
    max_d = int((hi - lo) / (math.tan(math.radians(el)) * SPACING)) + 2
    far_lit = march_shadow(rel, SPACING, az, el, max_d)
    Image.fromarray((far_lit * 255).astype(np.uint8)).save(os.path.join(OUT, "far_shadow.png"), optimize=True)

    # Shadows cast by distant massifs onto the DTM window (500² samples, upsampled).
    m = 500
    win_c = (np.arange(m) + 0.5) / m * meta["sizeX"] - half_w
    wz, wx = np.meshgrid(win_c, win_c, indexing="ij")
    hm_small = np.asarray(Image.fromarray(dtm.astype(np.float32)).resize((m, m), Image.BILINEAR)) - meta["minHeight"]
    az_r, tan_el = math.radians(az), math.tan(math.radians(el))
    dx, dz = math.sin(az_r), -math.cos(az_r)
    lit = np.ones((m, m))
    for d in np.arange(1500.0, HALF, SPACING / 2):
        px, pz = wx + dx * d, wz + dz * d
        ci = np.clip(np.round(px / SPACING + (n - 1) / 2).astype(int), 0, n - 1)
        ri = np.clip(np.round(pz / SPACING + (n - 1) / 2).astype(int), 0, n - 1)
        lit[rel[ri, ci] > hm_small + d * tan_el + 2.0] = 0
    occl = np.asarray(Image.fromarray((lit * 255).astype(np.uint8)).resize((2000, 2000), Image.BILINEAR), dtype=np.float32)
    near = np.asarray(Image.open(os.path.join(OUT, "shadow.png")), dtype=np.float32)
    Image.fromarray(np.minimum(near, occl).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)
    print(f"Distant-massif shadow on the DTM window: {(lit < 0.5).mean() * 100:.1f}% of area")

    meta["far"] = {"n": n, "spacing": SPACING, "size": float(coords[-1] - coords[0]), "min": lo, "max": hi, "offset": offset,
                   "source": "SLDEM2015 (LOLA + SELENE TC), 512 px/deg"}
    json.dump(meta, open(meta_path, "w", encoding="utf-8"), indent=2)
    for name in ("far_height.png", "far_shadow.png", "shadow.png"):
        print(f"  {name}: {os.path.getsize(os.path.join(OUT, name)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
