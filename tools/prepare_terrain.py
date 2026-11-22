"""Prepare game terrain data from LROC NAC DTM + orthophoto (Apollo 15, Hadley Rille).

Inputs  (raw_data/, not committed):
  NAC_DTM_APOLLO15.TIF                     32-bit float DTM, 2 m/px
  NAC_DTM_APOLLO15_M111571816_50CM.TIF     8-bit orthophoto, 0.5 m/px

Outputs (public/data/):
  heightmap.png   16-bit grayscale PNG, heights normalized to [min, max]
  ortho.jpg       orthophoto, downscaled, same footprint
  shadow.png      8-bit baked terrain cast-shadow mask for the game sun
  terrain.json    metadata (size in metres, min/max height, sun direction, geo info)

Usage: python tools/prepare_terrain.py
"""
import json
import math
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.fill import fillnodata
from rasterio.windows import Window

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data")
OUT = os.path.join(ROOT, "public", "data")

DTM_FILE = os.path.join(RAW, "NAC_DTM_APOLLO15.TIF")
ORTHO_FILE = os.path.join(RAW, "NAC_DTM_APOLLO15_M111571816_50CM.TIF")

MOON_R = 1737400.0
LANDING_LAT, LANDING_LON = 26.13224, 3.63400  # Apollo 15 LM "Falcon"

# 4 x 4 km window (2000 x 2000 px at 2 m/px): Hadley Rille on the west, LM site near centre.
COL0, ROW0, SIZE = 400, 5100, 2000
ORTHO_OUT = 4096
SHADOW_OUT = 1024
# Game sun: low and harsh, from the south-east (roughly along the rille axis,
# so part of the rille floor stays lit). The orthophoto is a high-sun image,
# so its baked shading is mild and works as albedo.
GAME_SUN_AZ_DEG = 135.0
GAME_SUN_ELEV_DEG = 9.0


def read_dtm():
    with rasterio.open(DTM_FILE) as d:
        win = Window(COL0, ROW0, SIZE, SIZE)
        h = d.read(1, window=win).astype(np.float32)
        transform = d.window_transform(win)
    valid = h > -1e30
    print(f"DTM window: {h.shape}, invalid px: {(~valid).sum()}")
    if (~valid).any():
        h = fillnodata(h, mask=valid.astype(np.uint8), max_search_distance=200, smoothing_iterations=2)
    return h, transform


def read_ortho(transform):
    left, top = transform.c, transform.f
    with rasterio.open(ORTHO_FILE) as o:
        c0 = int(round((left - o.transform.c) / o.res[0]))
        r0 = int(round((o.transform.f - top) / o.res[1]))
        n = SIZE * 4
        img = o.read(1, window=Window(c0, r0, n, n),
                     out_shape=(ORTHO_OUT, ORTHO_OUT),
                     resampling=rasterio.enums.Resampling.average)
    print(f"Ortho window at col {c0} row {r0}, black px: {(img == 0).mean():.4f}")
    return img


def bake_shadow(h, px, az_deg, el_deg, out_size):
    """Cast-shadow mask via horizon marching (1 = lit, 0 = shadow)."""
    k = h.shape[0] // out_size
    hh = h[: out_size * k, : out_size * k].reshape(out_size, k, out_size, k).max(axis=(1, 3)).astype(np.float64)
    step = px * k
    az, el = math.radians(az_deg), math.radians(el_deg)
    # Direction towards the sun in pixel space (col = east, row = south).
    dc, dr = math.sin(az), -math.cos(az)
    tan_el = math.tan(el)
    rows, cols = np.mgrid[0:out_size, 0:out_size].astype(np.float64)
    lit = np.ones_like(hh)
    max_d = int(1.5 * out_size)
    for d in range(1, max_d):
        rr, cc = rows + dr * d, cols + dc * d
        inside = (rr >= 0) & (rr <= out_size - 1) & (cc >= 0) & (cc <= out_size - 1)
        if not inside.any():
            break
        ri = np.clip(np.round(rr).astype(int), 0, out_size - 1)
        ci = np.clip(np.round(cc).astype(int), 0, out_size - 1)
        ray_h = hh + d * step * tan_el
        blocked = inside & (hh[ri, ci] > ray_h + 0.5)
        lit[blocked] = 0
    return lit


def main():
    os.makedirs(OUT, exist_ok=True)
    h, transform = read_dtm()
    hmin, hmax = float(h.min()), float(h.max())
    print(f"Height range: {hmin:.1f} .. {hmax:.1f} m")

    q = np.round((h - hmin) / (hmax - hmin) * 65535).astype(np.uint16)
    Image.fromarray(q, mode="I;16").save(os.path.join(OUT, "heightmap.png"), optimize=True)

    ortho = read_ortho(transform)
    # Fill black no-data in ortho with mean to avoid holes.
    m = ortho > 0
    ortho = np.where(m, ortho, int(ortho[m].mean())).astype(np.uint8)
    Image.fromarray(ortho).save(os.path.join(OUT, "ortho.jpg"), quality=82, optimize=True, progressive=True)

    shadow = bake_shadow(h, 2.0, GAME_SUN_AZ_DEG, GAME_SUN_ELEV_DEG, SHADOW_OUT)
    Image.fromarray((shadow * 255).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)

    left, top = transform.c, transform.f
    cx = left + SIZE * 2.0 / 2
    cy = top - SIZE * 2.0 / 2
    lon_c = 180 + math.degrees(cx / (MOON_R * math.cos(math.radians(26))))
    lat_c = math.degrees(cy / MOON_R)
    lx = MOON_R * math.cos(math.radians(26)) * math.radians(LANDING_LON - 180)
    ly = MOON_R * math.radians(LANDING_LAT)
    meta = {
        "source": "LROC NAC DTM NAC_DTM_APOLLO15 + orthophoto M111571816 (NASA/GSFC/Arizona State University)",
        "width": SIZE,
        "height": SIZE,
        "pixelSize": 2.0,
        "sizeX": (SIZE - 1) * 2.0,
        "sizeZ": (SIZE - 1) * 2.0,
        "minHeight": hmin,
        "maxHeight": hmax,
        "centerLat": lat_c,
        "centerLon": lon_c,
        # Game coords: +x east, -z north, origin at the window centre.
        "landing": {"x": lx - cx, "z": -(ly - cy)},
        "sun": {"azimuth": GAME_SUN_AZ_DEG, "elevation": GAME_SUN_ELEV_DEG},
    }
    with open(os.path.join(OUT, "terrain.json"), "w") as f:
        json.dump(meta, f, indent=2)

    total = 0
    for name in os.listdir(OUT):
        s = os.path.getsize(os.path.join(OUT, name))
        total += s
        print(f"  {name}: {s / 1e6:.2f} MB")
    print(f"Total game data: {total / 1e6:.2f} MB")
    assert total < 20e6, "game data exceeds 20 MB"


if __name__ == "__main__":
    main()
