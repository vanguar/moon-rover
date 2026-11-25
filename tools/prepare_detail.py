"""Full-resolution orthophoto tiles, streamed around the rover in the game.

Mars: HiRISE orthomosaic 25 cm (Mars 2020 TRN maps, USGS; read remotely), the
       illumination photographed by HiRISE divided out with the same DTM shading
       model as tools/deshade.py, so the game lights the ground itself and the
       image looks right from any direction.
Moon: LROC NAC orthophoto M111571816 at 50 cm over the whole DTM strip.

Tiles: 256 m squares on the game grid (x east, z south), grayscale JPEG,
public/data[/mars]/detail/<i>_<j>.jpg; terrain.json gains "detail".

Usage: python tools/prepare_detail.py [moon|mars]
"""
import json
import math
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILE = 256.0
Q = 80


def save_tiles(out_dir, get, x0, z0, ni, nj, res, keep):
    os.makedirs(out_dir, exist_ok=True)
    names, total = [], 0
    for j in range(nj):
        for i in range(ni):
            a = get(i, j)
            if a is None or not keep(a):
                continue
            n = f"{i}_{j}.jpg"
            # RGB tiles (albedo + slopes) keep full chroma resolution: no 4:2:0 subsampling.
            Image.fromarray(a).save(os.path.join(out_dir, n), quality=Q, optimize=True, progressive=True, subsampling=0 if a.ndim == 3 else -1)
            names.append(f"{i}_{j}")
            total += os.path.getsize(os.path.join(out_dir, n))
        print(f"  row {j + 1}/{nj}: {len(names)} tiles, {total / 1e6:.1f} MB", flush=True)
    return names, total


def moon():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import prepare_terrain as P
    D = os.path.join(ROOT, "public", "data")
    meta = json.load(open(os.path.join(D, "terrain.json"), encoding="utf-8"))
    with rasterio.open(P.DTM_FILE) as d:
        tr = d.window_transform(Window(P.COL0, P.ROW0, P.SIZE, P.SIZE))
    left, top = tr.c, tr.f
    half = P.SIZE * P.PX / 2
    # Whole DTM strip (x ±2048 m) from the rille north of the LM to St. George.
    x0, x1, z0, z1 = -2048.0, 2048.0, -3072.0, 4096.0
    ni, nj = int((x1 - x0) / TILE), int((z1 - z0) / TILE)
    res = 512  # 0.5 m/px, the orthophoto's own resolution
    o = rasterio.open(P.ORTHO_FILE)
    hw = P.HW_REG  # hardware registration does not move the photo

    def get(i, j):
        gx, gz = x0 + i * TILE, z0 + j * TILE
        X = left + half + gx
        Y = top - half - gz
        c0 = int(round((X - o.transform.c) / o.res[0]))
        r0 = int(round((o.transform.f - Y) / o.res[1]))
        a = o.read(1, window=Window(c0, r0, res, res), boundless=True, fill_value=0)
        # The LM photographed in 2009 is painted out: the 3D model stands there.
        lm = meta["sites"]["lm"]
        lx, lz = (lm["x"] - gx) / 0.5, (lm["z"] - gz) / 0.5
        if -30 < lx < res + 30 and -30 < lz < res + 30:
            import cv2
            m = np.zeros_like(a)
            cv2.circle(m, (int(round(lx)), int(round(lz))), 26, 255, -1)
            a = cv2.inpaint(a, m, 9, cv2.INPAINT_TELEA)
        return a

    keep = lambda a: (a > 0).mean() > 0.9  # only tiles fully inside the photo
    names, total = save_tiles(os.path.join(D, "detail"), get, x0, z0, ni, nj, res, keep)
    meta["detail"] = {"x0": x0, "z0": z0, "tile": TILE, "res": res, "tiles": names}
    json.dump(meta, open(os.path.join(D, "terrain.json"), "w", encoding="utf-8"), indent=2)
    print(f"Moon detail: {len(names)} tiles, {total / 1e6:.1f} MB")
    del hw


def mars():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import prepare_mars as M
    from rasterio.warp import reproject
    D = os.path.join(ROOT, "public", "data", "mars")
    meta = json.load(open(os.path.join(D, "terrain.json"), encoding="utf-8"))
    L = meta["landing"]
    # Landing site, Wright Brothers Field and the way west to the delta front.
    x0 = math.floor((L["x"] - 2300) / TILE) * TILE
    x1 = math.ceil((L["x"] + 520) / TILE) * TILE
    z0 = math.floor((L["z"] - 1000) / TILE) * TILE
    z1 = math.ceil((L["z"] + 700) / TILE) * TILE
    half = meta["sizeX"] / 2
    x0, x1 = max(x0, -half), min(x1, half)
    z0, z1 = max(z0, -half), min(z1, half)
    ni, nj = int((x1 - x0) // TILE), int((z1 - z0) // TILE)
    res = 1024  # 0.25 m/px, HiRISE's own resolution

    # Shading factor (same model as deshade.py) on the 2 m DTM grid.
    import deshade as DS
    import heightmap_io
    h = heightmap_io.load(D).astype(np.float64) * (meta["maxHeight"] - meta["minHeight"]) / 65535
    px = meta["pixelSize"]
    az, el = 275, 35
    s = DS.shade(h, px, az, el)
    rel = s / math.sin(math.radians(el)) - 1.0
    factor = np.clip(1.0 + 0.94 * ndimage.gaussian_filter(rel, 0.7), 0.35, 2.5).astype(np.float32)
    fac_img = Image.fromarray(factor, mode="F")

    src = rasterio.open(M.HIRISE_ORTHO)
    # HiRISE DTM at 1 m (cached by prepare_mars.py): slopes for the relief shading
    # near the rover, finer than the 2 m game mesh.
    from rasterio.crs import CRS
    dtm = np.load(os.path.join(M.RAW, "hirise_dtm_window.npy")).astype(np.float32)
    dtm = np.where(dtm > -1e30, dtm, np.nan)
    if np.isnan(dtm).any():
        dtm = np.where(np.isnan(dtm), np.nanmean(dtm), dtm)
    dtm_tr = rasterio.Affine(*json.load(open(os.path.join(M.RAW, "hirise_dtm_window.json"))))
    dtm_crs = CRS.from_proj4(f"+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={M.R_MARS} +units=m +no_defs")

    def slopes(gx, gz):
        n = 256 + 2  # 1 m grid with a 1-sample border
        tr, _ = M.game_transform(TILE + 2, n, gx + TILE / 2, gz + TILE / 2)
        hh = np.zeros((n, n), np.float32)
        reproject(dtm, hh, src_transform=dtm_tr, src_crs=dtm_crs, dst_transform=tr, dst_crs=M.GAME_CRS,
                  resampling=Resampling.cubic, src_nodata=None)
        gz_, gx_ = np.gradient(hh.astype(np.float64), 1.0)  # rows = +z (south), cols = +x (east)
        sx, sz = gx_[1:-1, 1:-1], gz_[1:-1, 1:-1]
        enc = lambda v: np.sign(v) * np.sqrt(np.minimum(np.abs(v) / 2.0, 1.0))  # |slope| <= 2 (63°)
        up = lambda a: np.asarray(Image.fromarray(((enc(a) * 0.5 + 0.5) * 255).astype(np.float32), mode="F").resize((res, res), Image.BICUBIC))
        return up(sx), up(sz)

    def get(i, j):
        gx, gz = x0 + i * TILE, z0 + j * TILE
        tr, _ = M.game_transform(TILE, res, gx + TILE / 2, gz + TILE / 2)
        a = np.zeros((res, res), np.uint8)
        reproject(rasterio.band(src, 1), a, dst_transform=tr, dst_crs=M.GAME_CRS, resampling=Resampling.bilinear,
                  src_nodata=src.nodata if src.nodata is not None else 0, dst_nodata=0, num_threads=4)
        if (a > 0).mean() < 0.9:
            return None
        fx, fz = (gx + half) / px, (gz + half) / px
        f = np.asarray(fac_img.transform((res, res), Image.EXTENT, (fx, fz, fx + TILE / px, fz + TILE / px), Image.BILINEAR))
        alb = np.where(a > 0, np.clip(a / f, 0, 255), 0)
        sx, sz = slopes(gx, gz)
        return np.dstack([alb, np.clip(sx, 0, 255), np.clip(sz, 0, 255)]).astype(np.uint8)

    names, total = save_tiles(os.path.join(D, "detail"), get, x0, z0, ni, nj, res, lambda a: True)
    meta["detail"] = {"x0": x0, "z0": z0, "tile": TILE, "res": res, "tiles": names, "slopes": True}
    json.dump(meta, open(os.path.join(D, "terrain.json"), "w", encoding="utf-8"), indent=2)
    print(f"Mars detail: {len(names)} tiles, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    if which in ("moon", "both"):
        moon()
    if which in ("mars", "both"):
        mars()
