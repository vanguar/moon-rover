"""Prepare Mars terrain data: Jezero crater, Perseverance landing site (Octavia E. Butler Landing).

Sources (Mars 2020 Terrain Relative Navigation maps, USGS Astrogeology, read remotely by window):
  HiRISE DTM 1 m   JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif
  HiRISE ortho     JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif (tiled, 25 cm)
  CTX DTM 20 m     JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif
  CTX ortho 6 m    JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif

Outputs (public/data/mars/):
  heightmap.bin  16-bit, 3000 x 3000 at 2 m (6 x 6 km), tools/heightmap_io.py
  ortho.jpg      4096² over the window (1.46 m/px);  ortho_hi.jpg 4096² over 2.4 km (0.59 m/px)
  shadow.png     baked cast shadows for the real sun (Mars24 algorithm)
  far_height.png CTX terrain, 501² at 60 m (30 x 30 km); far_albedo.jpg CTX ortho 2048²; far_shadow.png
  terrain.json   metadata

Game frame: +x east, -z north, origin at the window centre; equirectangular with
the standard parallel at the window centre (true distances to < 0.1 %).

Usage: python tools/prepare_mars.py   (first run downloads ~0.5–1 GB of windows into raw_data/mars)
"""
import json
import math
import os
from datetime import datetime, timezone

import numpy as np
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.fill import fillnodata
from rasterio.transform import from_origin
from rasterio.warp import reproject
from rasterio.windows import from_bounds

import heightmap_io

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("GDAL_CACHEMAX", "1024")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data", "mars")
OUT = os.path.join(ROOT, "public", "data", "mars")
URL = "/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/"
HIRISE_DTM = URL + "HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif"
HIRISE_ORTHO = URL + "HiRISE/JEZ_hirise_soc_007_orthoMosaic_25cm_Ortho_blend120.tif"
CTX_DTM = URL + "CTX/JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif"
CTX_ORTHO = URL + "CTX/JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif"

R_MARS = 3396190.0
LANDING_LAT, LANDING_LON = 18.4447, 77.4508  # Octavia E. Butler Landing (Perseverance)
# Window centre: 2.0 km west / 0.5 km north of the landing site, to take in the delta front.
CENTER_LAT = LANDING_LAT + math.degrees(500.0 / R_MARS)
CENTER_LON = LANDING_LON - math.degrees(2000.0 / (R_MARS * math.cos(math.radians(LANDING_LAT))))
SIZE, PX = 3000, 2.0
ORTHO_OUT = 4096
HI_CENTER = (1200.0, 700.0)  # game coords (x east, z south) — around the landing site
HI_SIZE = 2400.0
HI_OUT = 4096
FAR_N, FAR_SP = 501, 60.0
# Sol 0 afternoon, ~1 h 15 min after touchdown (2021-02-18 20:55 UTC): low sun, long shadows.
EPOCH = datetime(2021, 2, 18, 22, 10, tzinfo=timezone.utc)

GAME_CRS = CRS.from_proj4(
    f"+proj=eqc +lat_ts={CENTER_LAT} +lat_0={CENTER_LAT} +lon_0={CENTER_LON} +x_0=0 +y_0=0 +R={R_MARS} +units=m +no_defs"
)


def mars_sun(utc: datetime, lat: float, lon_e: float):
    """Sun azimuth/elevation (deg) for a site on Mars — Allison & McEwen (2000), Mars24 algorithm."""
    jd_ut = utc.timestamp() / 86400.0 + 2440587.5
    jd_tt = jd_ut + 69.184 / 86400.0
    dt = jd_tt - 2451545.0
    M = math.radians(19.3871 + 0.52402073 * dt)
    a_fms = 270.3871 + 0.524038496 * dt
    pbs = 0.0
    for A, tau, phi in [(0.0071, 2.2353, 49.409), (0.0057, 2.7543, 168.173), (0.0039, 1.1177, 191.837),
                        (0.0037, 15.7866, 21.736), (0.0021, 2.1354, 15.704), (0.0020, 2.4694, 95.528),
                        (0.0018, 32.8493, 49.095)]:
        pbs += A * math.cos(math.radians(0.985626 * dt / tau + phi))
    nu_m = (10.691 + 3.0e-7 * dt) * math.sin(M) + 0.623 * math.sin(2 * M) + 0.050 * math.sin(3 * M) \
        + 0.005 * math.sin(4 * M) + 0.0005 * math.sin(5 * M) + pbs
    ls = math.radians((a_fms + nu_m) % 360)
    dec = math.asin(0.42565 * math.sin(ls)) + math.radians(0.25) * math.sin(ls)
    eot = 2.861 * math.sin(2 * ls) - 0.071 * math.sin(4 * ls) + 0.002 * math.sin(6 * ls) - nu_m
    mst = (24 * (((jd_tt - 2451549.5) / 1.0274912517) + 44796.0 - 0.0009626) % 24)
    lmst = (mst - (360 - lon_e) * (24 / 360)) % 24  # west longitude convention
    ltst = lmst + eot * (24 / 360)
    H = math.radians((ltst - 12) * 15)
    phi = math.radians(lat)
    sin_el = math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(H)
    el = math.asin(sin_el)
    az = math.atan2(math.sin(H), math.cos(H) * math.sin(phi) - math.tan(dec) * math.cos(phi))
    az_deg = (math.degrees(az) + 180) % 360
    return az_deg, math.degrees(el), math.degrees(ls), ltst


def game_transform(size_m: float, n: int, cx=0.0, cz=0.0):
    """Affine transform of an n² grid covering size_m centred at game (cx, cz) (pixel-is-area)."""
    px = size_m / n
    return from_origin(cx - size_m / 2, -cz + size_m / 2, px, px), px


def warp(src_path, dst_shape, dst_transform, resampling, dtype=np.float32, nodata=None, cache=None):
    if cache and os.path.exists(cache):
        return np.load(cache)
    dst = np.zeros(dst_shape, dtype=dtype)
    with rasterio.open(src_path) as s:
        reproject(rasterio.band(s, 1), dst, dst_transform=dst_transform, dst_crs=GAME_CRS,
                  resampling=resampling, src_nodata=s.nodata if nodata is None else nodata, dst_nodata=0,
                  num_threads=4, warp_mem_limit=1024)
    if cache:
        np.save(cache, dst)
    return dst


def read_hirise_dtm():
    """1 m DTM window (eqc lat_ts=0), cached locally, warped to the game grid at 2 m."""
    cache = os.path.join(RAW, "hirise_dtm_window.npy")
    meta_c = os.path.join(RAW, "hirise_dtm_window.json")
    if not os.path.exists(cache):
        with rasterio.open(HIRISE_DTM) as s:
            cx, cy = R_MARS * math.radians(CENTER_LON), R_MARS * math.radians(CENTER_LAT)
            hw = (SIZE * PX / 2 + 200) / math.cos(math.radians(CENTER_LAT))
            hh = SIZE * PX / 2 + 200
            win = from_bounds(cx - hw, cy - hh, cx + hw, cy + hh, s.transform).round_offsets().round_lengths()
            print(f"Reading HiRISE DTM window {win} (remote) ...", flush=True)
            a = s.read(1, window=win)
            t = s.window_transform(win)
        np.save(cache, a)
        json.dump(list(t)[:6], open(meta_c, "w"))
    a = np.load(cache)
    t = rasterio.Affine(*json.load(open(meta_c)))
    valid = a > -1e30
    print(f"DTM window {a.shape}, invalid {(~valid).mean() * 100:.2f}%")
    if (~valid).any():
        a = fillnodata(a, mask=valid.astype(np.uint8), max_search_distance=300, smoothing_iterations=2)
    src_crs = CRS.from_proj4(f"+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={R_MARS} +units=m +no_defs")
    tr, _ = game_transform(SIZE * PX, SIZE)
    # Heights are sampled at pixel centres (grid nodes in the game).
    out = np.zeros((SIZE, SIZE), np.float32)
    reproject(a, out, src_transform=t, src_crs=src_crs, dst_transform=tr, dst_crs=GAME_CRS,
              resampling=Resampling.cubic, src_nodata=None)
    return out


def bake_shadow(h, px, az_deg, el_deg, out_size):
    """Cast-shadow mask via horizon marching (1 = lit, 0 = shadow)."""
    k = h.shape[0] // out_size
    hh = h[: out_size * k, : out_size * k].reshape(out_size, k, out_size, k).max(axis=(1, 3)).astype(np.float64)
    step = px * k
    az, el = math.radians(az_deg), math.radians(el_deg)
    dc, dr = math.sin(az), -math.cos(az)
    tan_el = math.tan(el)
    rows, cols = np.mgrid[0:out_size, 0:out_size].astype(np.float64)
    lit = np.ones_like(hh)
    relief = float(hh.max() - hh.min())
    max_d = min(int(1.5 * out_size), int(relief / (tan_el * step)) + 2)
    for d in range(1, max_d):
        rr, cc = rows + dr * d, cols + dc * d
        inside = (rr >= 0) & (rr <= out_size - 1) & (cc >= 0) & (cc <= out_size - 1)
        if not inside.any():
            break
        ri = np.clip(np.round(rr).astype(int), 0, out_size - 1)
        ci = np.clip(np.round(cc).astype(int), 0, out_size - 1)
        lit[inside & (hh[ri, ci] > hh + d * step * tan_el + 0.4)] = 0
    return lit


def fill_mean(img):
    m = img > 0
    return np.where(m, img, int(img[m].mean()) if m.any() else 128).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(RAW, exist_ok=True)
    h = read_hirise_dtm()
    hmin, hmax = float(h.min()), float(h.max())
    print(f"Height range {hmin:.1f} .. {hmax:.1f} m (areoid)")
    q = np.round((h - hmin) / (hmax - hmin) * 65535).astype(np.uint16)
    heightmap_io.save(OUT, q)

    tr, _ = game_transform(SIZE * PX, ORTHO_OUT)
    print("Warping HiRISE ortho (window) ...", flush=True)
    ortho = warp(HIRISE_ORTHO, (ORTHO_OUT, ORTHO_OUT), tr, Resampling.average, np.uint8, 0, os.path.join(RAW, "ortho.npy"))
    Image.fromarray(fill_mean(ortho)).save(os.path.join(OUT, "ortho.jpg"), quality=82, optimize=True, progressive=True)
    tr_hi, _ = game_transform(HI_SIZE, HI_OUT, *HI_CENTER)
    print("Warping HiRISE ortho (hi-res centre) ...", flush=True)
    hi = warp(HIRISE_ORTHO, (HI_OUT, HI_OUT), tr_hi, Resampling.average, np.uint8, 0, os.path.join(RAW, "ortho_hi.npy"))
    Image.fromarray(fill_mean(hi)).save(os.path.join(OUT, "ortho_hi.jpg"), quality=80, optimize=True, progressive=True)

    az, el, ls, ltst = mars_sun(EPOCH, LANDING_LAT, LANDING_LON)
    print(f"Sun: az {az:.1f} el {el:.1f}, Ls {ls:.1f}, LTST {int(ltst)}:{int(ltst % 1 * 60):02d}")
    shadow = bake_shadow(h, PX, az, el, SIZE)
    Image.fromarray((shadow * 255).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)

    # Far terrain (CTX 20 m) on a 60 m grid, nodes centred on the window centre.
    far_size = (FAR_N - 1) * FAR_SP
    tr_far = from_origin(-far_size / 2 - FAR_SP / 2, far_size / 2 + FAR_SP / 2, FAR_SP, FAR_SP)
    far = warp(CTX_DTM, (FAR_N, FAR_N), tr_far, Resampling.bilinear, np.float32, -3.4028226550889045e38)
    valid = far != 0
    if (~valid).any():
        far = fillnodata(far, mask=valid.astype(np.uint8), max_search_distance=400, smoothing_iterations=0)
    # Vertical alignment with the HiRISE window (both are on the MOLA areoid; remove residual).
    half = SIZE * PX / 2
    c = (np.arange(FAR_N) - (FAR_N - 1) / 2) * FAR_SP
    zz, xx = np.meshgrid(c, c, indexing="ij")
    inwin = (np.abs(xx) < half - 100) & (np.abs(zz) < half - 100)
    hs = np.asarray(Image.fromarray(h).resize((int(SIZE * PX / FAR_SP),) * 2, Image.BILINEAR))
    offset = float(hs.mean() - far[inwin].mean())
    far = far + offset
    rel = far - hmin
    lo, hi_ = float(rel.min()), float(rel.max())
    Image.fromarray(np.round((rel - lo) / (hi_ - lo) * 65535).astype(np.uint16), mode="I;16").save(
        os.path.join(OUT, "far_height.png"), optimize=True)
    far_lit = bake_shadow(rel, FAR_SP, az, el, FAR_N)
    Image.fromarray((far_lit * 255).astype(np.uint8)).save(os.path.join(OUT, "far_shadow.png"), optimize=True)
    tr_fa = from_origin(-far_size / 2, far_size / 2, far_size / 2048, far_size / 2048)
    print("Warping CTX ortho ...", flush=True)
    fa = warp(CTX_ORTHO, (2048, 2048), tr_fa, Resampling.average, np.uint8, 0, os.path.join(RAW, "far_albedo.npy"))
    # Match the CTX stretch to the HiRISE ortho over the window, so the two blend without a seam.
    w = int(round(SIZE * PX / far_size * 2048))
    c0 = (2048 - w) // 2
    sub = fa[c0:c0 + w, c0:c0 + w].astype(np.float64)
    o = ortho[ortho > 0].astype(np.float64)
    gain = o.std() / sub[sub > 0].std()
    bias = o.mean() - gain * sub[sub > 0].mean()
    fa = np.where(fa > 0, np.clip(fa * gain + bias, 0, 255), o.mean()).astype(np.uint8)
    Image.fromarray(fa).save(os.path.join(OUT, "far_albedo.jpg"), quality=82, optimize=True)
    print(f"Far grid {FAR_N}² @ {FAR_SP} m, offset {offset:.1f} m, range {lo:.0f}..{hi_:.0f}")

    # Distant ridges shadowing the window.
    m = 500
    wc = (np.arange(m) + 0.5) / m * SIZE * PX - half
    wz, wx = np.meshgrid(wc, wc, indexing="ij")
    hsm = np.asarray(Image.fromarray(h).resize((m, m), Image.BILINEAR)) - hmin
    az_r, tan_el = math.radians(az), math.tan(math.radians(el))
    dx, dz = math.sin(az_r), -math.cos(az_r)
    lit = np.ones((m, m))
    for d in np.arange(1500.0, far_size / 2, FAR_SP / 2):
        ci = np.clip(np.round((wx + dx * d) / FAR_SP + (FAR_N - 1) / 2).astype(int), 0, FAR_N - 1)
        ri = np.clip(np.round((wz + dz * d) / FAR_SP + (FAR_N - 1) / 2).astype(int), 0, FAR_N - 1)
        lit[rel[ri, ci] > hsm + d * tan_el + 2.0] = 0
    occl = np.asarray(Image.fromarray((lit * 255).astype(np.uint8)).resize((SIZE, SIZE), Image.BILINEAR), dtype=np.float32)
    Image.fromarray(np.minimum(shadow * 255, occl).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)

    lx = R_MARS * math.cos(math.radians(CENTER_LAT)) * math.radians(LANDING_LON - CENTER_LON)
    lz = -R_MARS * math.radians(LANDING_LAT - CENTER_LAT)
    meta = {
        "body": "mars",
        "source": "HiRISE DTM 1 m + ortho 25 cm, CTX DTM 20 m (Mars 2020 TRN maps; NASA/JPL/UArizona/USGS)",
        "width": SIZE,
        "height": SIZE,
        "pixelSize": PX,
        "sizeX": (SIZE - 1) * PX,
        "sizeZ": (SIZE - 1) * PX,
        "minHeight": hmin,
        "maxHeight": hmax,
        "centerLat": CENTER_LAT,
        "centerLon": CENTER_LON,
        "landing": {"x": lx, "z": lz},
        "orthoHi": {"x": HI_CENTER[0], "z": HI_CENTER[1], "size": HI_SIZE},
        "epoch": EPOCH.isoformat(),
        "sun": {"azimuth": az, "elevation": el},
        "ls": ls,
        "far": {"n": FAR_N, "spacing": FAR_SP, "size": far_size, "min": lo, "max": hi_, "offset": offset,
                "source": "CTX DTM 20 m (Mars 2020 TRN)"},
    }
    json.dump(meta, open(os.path.join(OUT, "terrain.json"), "w", encoding="utf-8"), indent=2)
    for f in sorted(os.listdir(OUT)):
        print(f"  {f}: {os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
