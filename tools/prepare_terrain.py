"""Prepare game terrain data for the Apollo 15 site (Hadley Rille), 8 x 8 km.

Inputs  (raw_data/, not committed):
  NAC_DTM_APOLLO15.TIF                     32-bit float DTM, 2 m/px (a 4 km wide N-S strip)
  NAC_DTM_APOLLO15_M111571816_50CM.TIF     8-bit orthophoto, 0.5 m/px
  sldem_512_rows_1470_2500.bin             SLDEM2015 rows (LOLA + SELENE TC, 59 m/px), see README
  bsc5-short.json                          Yale Bright Star Catalog

Outputs (public/data/):
  heightmap.bin   16-bit heights (4000 x 4000, 2 m) in steps of heightStep above minHeight (tools/heightmap_io.py)
  ortho.jpg       albedo image of the whole window (2 m/px)
  ortho_hi.jpg    orthophoto at ~0.6 m/px around the LM and the east rim of the rille
  shadow.png      8-bit baked cast-shadow mask for the game epoch (fallback; the game
                  recomputes shadows on the GPU as the Sun moves)
  stars.bin       Yale Bright Star Catalog in the local sky: float32 [x, y, z, Vmag, T_K] per star
  terrain.json    metadata (size, heights, geo reference, sun/earth, mission sites)

The DTM covers only a ~4 km wide strip (E-W) of the window. The strips to the east
and west come from SLDEM2015, vertically matched to the DTM with a smoothly varying
offset, given the DTM's own small-scale roughness spectrum (seeded noise), and blended
into the DTM over 300 m. Where there is no orthophoto, the albedo image is synthesised
by shading the merged relief with the orthophoto's own (fitted) illumination, so the
whole window looks like one photograph.

Usage: python tools/prepare_terrain.py
"""
import json
import math
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.windows import Window
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import heightmap_io  # noqa: E402
from ephemeris import GAME_EPOCH, LunarSky  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data")
OUT = os.path.join(ROOT, "public", "data")

DTM_FILE = os.path.join(RAW, "NAC_DTM_APOLLO15.TIF")
ORTHO_FILE = os.path.join(RAW, "NAC_DTM_APOLLO15_M111571816_50CM.TIF")
SLDEM_FILE = os.path.join(RAW, "sldem_512_rows_1470_2500.bin")
STAR_FILE = os.path.join(RAW, "bsc5-short.json")

MOON_R = 1737400.0
COS_SP = math.cos(math.radians(26.0))  # standard parallel of the DTM projection
LANDING_LAT, LANDING_LON = 26.13224, 3.63400  # LM Falcon (LROC NAC, Wagner et al. 2017)

# 8 x 8 km window (4000 x 4000 px at 2 m/px) in DTM pixel coordinates: from the rille
# north-west of the LM down to St. George crater on the flank of Hadley Delta.
COL0, ROW0, SIZE = -540, 4900, 4000
PX = 2.0
HSTEP = 0.04
ORTHO_OUT = 4096
SHADOW_OUT = 2000
BLEND_M = 300.0
# High-resolution ortho tile, absolute offset from the LM (metres, game axes).
HI_FROM_LM = (-980.0, -47.0)
HI_SIZE = 2458.0
HI_OUT = 4096

# SLDEM2015 tile 00N-30N, 000-045E at 512 px/deg; rows 1470..2499 were downloaded.
SL_ROW0, SL_NROWS, SL_NCOLS, SL_PPD = 1470, 1030, 23040, 512

# The LM is visible in the orthophoto (LROC NAC, 2009) 19.2 m west and 5.4 m north of
# its catalogue position: hardware is registered to the photo (so the 3D model sits
# in its own blast zone), craters keep their catalogue centres.
HW_REG = (-19.2, -5.4)
HARDWARE = ("lm", "lrv", "alsep")

# Mission sites (lat, lon). Hardware: LROC NAC (Wagner et al. 2017, "Coordinates of
# anthropogenic features on the Moon", Icarus 283). Craters: IAU / LTO 41B4 names,
# centres from the Gazetteer of Planetary Nomenclature (rounded 0.01 deg), refined on
# the DTM where noted in docs/REALISM.md.
SITES = {
    "lm": (26.13224, 3.63400),
    "lrv": (26.13173, 3.63808),
    "alsep": (26.13406, 3.62991),
    "elbow": (26.03, 3.60),
    "stgeorge": (25.96, 3.54),
    "spur": (25.98, 3.67),
    # Rim of Hadley Rille, found on the DTM: walking from the LM toward the rille, the
    # first edge where the ground falls > 16 m within 20 m (azimuth 224°, 1.74 km).
    "rille": (26.09115, 3.58893),
}


def to_game(lat, lon, lat_c, lon_c):
    x = MOON_R * COS_SP * math.radians(lon - lon_c)
    z = -MOON_R * math.radians(lat - lat_c)
    return x, z


def read_dtm():
    with rasterio.open(DTM_FILE) as d:
        win = Window(COL0, ROW0, SIZE, SIZE)
        h = d.read(1, window=win, boundless=True, fill_value=-3.4e38).astype(np.float64)
        transform = d.window_transform(win)
    valid = h > -1e30
    # Close pinholes inside the strip; the outside is filled from SLDEM below.
    holes = ~valid & ndimage.binary_closing(valid, iterations=6)
    if holes.any():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        h[holes] = h[tuple(i[holes] for i in idx)]
        valid |= holes
    print(f"DTM window {h.shape}: DTM coverage {valid.mean() * 100:.1f}%")
    return h, valid, transform


def sample_sldem(lat, lon):
    dem = np.memmap(SLDEM_FILE, "<f4", mode="r", shape=(SL_NROWS, SL_NCOLS))
    r = (15359.5 - lat * SL_PPD) - SL_ROW0
    c = lon * SL_PPD - 0.5
    r0, r1 = int(np.floor(r.min())) - 3, int(np.ceil(r.max())) + 4
    c0, c1 = int(np.floor(c.min())) - 3, int(np.ceil(c.max())) + 4
    sub = np.array(dem[r0:r1, c0:c1], dtype=np.float64) * 1000.0
    # Bicubic spline: no 59 m facets.
    return ndimage.map_coordinates(sub, [r - r0, c - c0], order=3, mode="nearest")


def merge_sldem(h, valid, lat, lon):
    sl = sample_sldem(lat, lon)
    # Smoothly varying vertical offset DTM - SLDEM, extrapolated outside the strip.
    diff = np.where(valid, h - sl, 0.0)
    wsum = ndimage.gaussian_filter(valid.astype(np.float64), 150)
    off = ndimage.gaussian_filter(diff, 150) / np.maximum(wsum, 1e-6)
    far = wsum < 1e-3
    if far.any():
        off[far] = float(diff[valid].mean())
    base = sl + off
    # DTM roughness below SLDEM resolution: std of DTM minus its 60 m low-pass.
    hp = (h - ndimage.gaussian_filter(np.where(valid, h, base), 15))[valid]
    rough = float(np.std(hp[np.abs(hp) < np.percentile(np.abs(hp), 99)]))
    # The roughness (DTM-like spectrum) is NOT stored: incompressible noise was 40 % of
    # the heightmap download. The game adds the same seeded roughness at run time where
    # the DTM weight is < 1 (TerrainData.synthRough), for the mesh and the physics alike.
    dist = ndimage.distance_transform_edt(valid) * PX
    w = np.clip(dist / BLEND_M, 0, 1)
    w = w * w * (3 - 2 * w)
    out = np.where(valid, h * w + base * (1 - w), base)
    print(f"SLDEM merge: DTM-SLDEM offset mean {diff[valid].mean():.1f} m, roughness std {rough:.2f} m")
    return out, w, rough


def read_ortho(transform, shape):
    """Orthophoto resampled onto the window grid at 2 m (0 = no data)."""
    left, top = transform.c, transform.f
    with rasterio.open(ORTHO_FILE) as o:
        c0 = int(round((left - o.transform.c) / o.res[0]))
        r0 = int(round((o.transform.f - top) / o.res[1]))
        n = SIZE * 4
        img = o.read(1, window=Window(c0, r0, n, n), out_shape=shape, boundless=True, fill_value=0,
                     resampling=rasterio.enums.Resampling.average)
    return img.astype(np.float64)


def masked_blur(img, mask, sigma):
    num = ndimage.gaussian_filter(np.where(mask, img, 0.0), sigma)
    den = ndimage.gaussian_filter(mask.astype(np.float64), sigma)
    return num / np.maximum(den, 1e-6), den


def synth_albedo(ortho, valid):
    """
    The orthophoto was taken under a high Sun: its brightness is essentially albedo
    (bright fresh-crater halos, darker mature regolith). Two NAC frames with different
    gains meet along a seam, so the small-scale detail (< ~200 m) is kept and the
    large-scale level is replaced by a smooth version. Outside the photo the large-scale
    level is extrapolated and the detail is synthetic speckle with the photo's statistics.
    """
    have = (ortho > 0) & valid
    have = ndimage.binary_erosion(have, iterations=15)  # dark frame borders
    big, den_big = masked_blur(ortho, have, 200)  # 400 m
    mean = float(ortho[have].mean())
    big = np.where(den_big > 0.02, big, mean)
    big = ndimage.gaussian_filter(big, 60)
    small, _ = masked_blur(ortho, have, 50)  # 100 m: removes the gain step at the seam
    detail = np.where(have, ortho / np.maximum(small, 1.0), 1.0)
    dstd = float(np.std(np.clip(detail[have], 0.3, 3.0)))
    rng = np.random.default_rng(15415)
    speck = sum(ndimage.gaussian_filter(rng.standard_normal(ortho.shape), s) * w for s, w in ((0.8, 1.0), (3, 1.2), (10, 1.0)))
    speck = 1 + speck / speck.std() * dstd * 0.5
    dist = ndimage.distance_transform_edt(have) * PX
    w = np.clip(dist / 150.0, 0, 1)
    dist = ndimage.distance_transform_edt(~have) * PX
    w = w * w * (3 - 2 * w)
    # Far from the photo the extrapolated level relaxes to the scene mean (no dark bands).
    wl = np.clip(dist / 800.0, 0, 1)
    big = big * (1 - wl) + mean * wl
    out = big * (detail * w + speck * (1 - w))
    print(f"Albedo: photo coverage {have.mean() * 100:.0f}%, detail std {dstd:.3f}")
    return out


def remove_hardware(img, lm_rel, px):
    """Paint out the LM descent stage and its shadow (LROC imaged the site in 2009):
    the game places the 3D model there."""
    import cv2
    h, w = img.shape
    cx = int(round((lm_rel[0] + HI_SIZE / 2) / px))
    cy = int(round((lm_rel[1] + HI_SIZE / 2) / px))
    mask = np.zeros_like(img, dtype=np.uint8)
    cv2.circle(mask, (cx, cy), int(round(13 / px)), 255, -1)
    return cv2.inpaint(img, mask, 9, cv2.INPAINT_TELEA)


def read_ortho_hi(transform, centre):
    left, top = transform.c, transform.f
    half = SIZE * PX / 2
    with rasterio.open(ORTHO_FILE) as o:
        x0 = left + half + centre[0] - HI_SIZE / 2
        y0 = top - half - centre[1] + HI_SIZE / 2  # game -z is north
        c0 = int(round((x0 - o.transform.c) / o.res[0]))
        r0 = int(round((o.transform.f - y0) / o.res[1]))
        n = int(round(HI_SIZE / o.res[0]))
        img = o.read(1, window=Window(c0, r0, n, n), out_shape=(HI_OUT, HI_OUT), boundless=True, fill_value=0,
                     resampling=rasterio.enums.Resampling.lanczos)
    m = img > 0
    return np.where(m, img, int(img[m].mean())).astype(np.uint8)


def write_stars(sky, path):
    def parse_ra(s):
        h, m, sec = s.replace("h", "").replace("m", "").replace("s", "").split()
        return (float(h) + float(m) / 60 + float(sec) / 3600) * 15

    def parse_dec(s):
        sign = -1 if s.strip().startswith("-") else 1
        d, m, sec = s.replace("°", " ").replace("′", " ").replace("″", " ").replace("+", "").replace("-", "").split()
        return sign * (float(d) + float(m) / 60 + float(sec) / 3600)

    rows = []
    for st in json.load(open(STAR_FILE, encoding="utf-8")):
        try:
            ra, dec, v = parse_ra(st["RA"]), parse_dec(st["Dec"]), float(st["V"])
        except (KeyError, ValueError):
            continue
        rows.append((ra, dec, v, float(st.get("K") or 5800)))
    a = np.array(rows)
    ra, dec = np.radians(a[:, 0]), np.radians(a[:, 1])
    icrf = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=1)
    g = sky.to_game(icrf)
    out = np.concatenate([g, a[:, 2:3], a[:, 3:4]], axis=1).astype(np.float32)
    out.tofile(path)
    print(f"Stars: {len(out)} (brightest V={a[:, 2].min():.2f})")


def bake_shadow(h, az_deg, el_deg, out_size):
    """Cast-shadow mask via horizon marching (1 = lit, 0 = shadow)."""
    k = h.shape[0] // out_size
    hh = h[: out_size * k, : out_size * k].reshape(out_size, k, out_size, k).max(axis=(1, 3))
    step = PX * k
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
        lit[inside & (hh[ri, ci] > hh + d * step * tan_el + 0.5)] = 0
    return lit


def main():
    os.makedirs(OUT, exist_ok=True)
    h, valid, transform = read_dtm()
    left, top = transform.c, transform.f
    cx, cy = left + SIZE * PX / 2, top - SIZE * PX / 2
    lon_c = 180 + math.degrees(cx / (MOON_R * COS_SP))
    lat_c = math.degrees(cy / MOON_R)
    # Geographic coordinates of every pixel centre.
    coords = (np.arange(SIZE) - (SIZE - 1) / 2) * PX
    zz, xx = np.meshgrid(coords, coords, indexing="ij")
    lat = lat_c - np.degrees(zz / MOON_R)
    lon = lon_c + np.degrees(xx / (MOON_R * COS_SP))
    h, wdtm, rough = merge_sldem(h, valid, lat, lon)

    hmin, hmax = float(h.min()), float(h.max())
    print(f"Height range: {hmin:.1f} .. {hmax:.1f} m")
    # 4 cm height steps: far below the DTM's vertical precision (~0.5 m), and a third
    # smaller file than full 16-bit precision.
    q = np.round((h - hmin) / HSTEP).astype(np.uint16)
    hmax = hmin + float(q.max()) * HSTEP
    heightmap_io.save(OUT, q)
    # DTM weight (1 = measured at 2 m, 0 = SLDEM + synthetic detail), for docs and debugging.
    Image.fromarray((wdtm[::4, ::4] * 255).astype(np.uint8)).save(os.path.join(RAW, "dtm_weight.png"))
    # DTM weight for the run-time roughness (1000², a few kB).
    Image.fromarray((wdtm[::4, ::4] * 255).astype(np.uint8)).save(os.path.join(OUT, "dtm_weight.png"), optimize=True)

    ortho = read_ortho(transform, (SIZE, SIZE))
    ortho = synth_albedo(ortho, valid)
    img = Image.fromarray(np.clip(ortho, 0, 255).astype(np.uint8)).resize((ORTHO_OUT, ORTHO_OUT), Image.LANCZOS)
    img.save(os.path.join(OUT, "ortho.jpg"), quality=93, optimize=True, progressive=True)  # q80 showed 8×8 JPEG blocks on the ground

    lm_x, lm_z = to_game(LANDING_LAT, LANDING_LON, lat_c, lon_c)
    lm_x, lm_z = lm_x + HW_REG[0], lm_z + HW_REG[1]
    hi_c = (lm_x - HW_REG[0] + HI_FROM_LM[0], lm_z - HW_REG[1] + HI_FROM_LM[1])
    hi = read_ortho_hi(transform, hi_c)
    hi = remove_hardware(hi, (lm_x - hi_c[0], lm_z - hi_c[1]), HI_SIZE / HI_OUT)
    Image.fromarray(hi).save(os.path.join(OUT, "ortho_hi.jpg"), quality=93, optimize=True, progressive=True)

    sky = LunarSky(GAME_EPOCH, LANDING_LAT, LANDING_LON)
    sun_az, sun_el = sky.az_el(sky.sun())
    earth_az, earth_el = sky.az_el(sky.earth())
    print(f"Sun az {sun_az:.1f} el {sun_el:.1f}; Earth az {earth_az:.1f} el {earth_el:.1f}")
    write_stars(sky, os.path.join(OUT, "stars.bin"))

    shadow = bake_shadow(h, sun_az, sun_el, SHADOW_OUT)
    Image.fromarray((shadow * 255).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)

    sites = {}
    for k, (la, lo) in SITES.items():
        x, z = to_game(la, lo, lat_c, lon_c)
        if k in HARDWARE:
            x, z = x + HW_REG[0], z + HW_REG[1]
        sites[k] = {"lat": la, "lon": lo, "x": round(x, 2), "z": round(z, 2)}
    meta = {
        "source": "LROC NAC DTM NAC_DTM_APOLLO15 + orthophoto M111571816 (NASA/GSFC/Arizona State University); "
                  "edges: SLDEM2015 (LOLA + SELENE TC)",
        "width": SIZE,
        "height": SIZE,
        "pixelSize": PX,
        "sizeX": (SIZE - 1) * PX,
        "sizeZ": (SIZE - 1) * PX,
        "minHeight": hmin,
        "maxHeight": hmax,
        "heightStep": HSTEP,
        "synthRough": {"file": "dtm_weight.png", "n": SIZE // 4, "std": round(rough, 3)},
        "centerLat": lat_c,
        "centerLon": lon_c,
        "projection": {"radius": MOON_R, "standardParallel": 26.0},
        # Game coords: +x east, -z north, origin at the window centre.
        "landing": {"x": lm_x, "z": lm_z},
        "orthoHi": {"x": hi_c[0], "z": hi_c[1], "size": HI_SIZE},
        "epoch": GAME_EPOCH.isoformat(),
        "sun": {"azimuth": sun_az, "elevation": sun_el},
        "earth": {"azimuth": earth_az, "elevation": earth_el},
        "sites": sites,
    }
    old = os.path.join(OUT, "terrain.json")
    if os.path.exists(old):
        prev = json.load(open(old, encoding="utf-8"))
        for k in ("galaxy", "detail"):  # written by prepare_sky.py / prepare_detail.py
            if k in prev:
                meta[k] = prev[k]
    with open(old, "w") as f:
        json.dump(meta, f, indent=2)
    for k, v in sites.items():
        print(f"  site {k:9s} x {v['x']:8.1f}  z {v['z']:8.1f}")

    total = 0
    for name in os.listdir(OUT):
        p = os.path.join(OUT, name)
        if os.path.isfile(p):
            total += os.path.getsize(p)
            print(f"  {name}: {os.path.getsize(p) / 1e6:.2f} MB")
    print(f"Total lunar game data: {total / 1e6:.2f} MB")
    assert total < 30e6, "game data exceeds 30 MB"


if __name__ == "__main__":
    main()
