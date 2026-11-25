"""Game data for a lunar site from a DTM and an orthomosaic in any map projection.

Everything is reprojected onto the game grid - equirectangular, standard parallel and
origin at the window centre (+x east, -z north) - so the recipe does not depend on the
source files' own grids. (The Apollo 15 site predates this script: prepare_terrain.py.)

Apollo 17, Taurus-Littrow valley (raw_data/apollo17/):
  APOLLO17_DTM_150CM.TIFF         DTM 1.5 m/px, 14 x 12 km  } Haase, Wählisch, Gläser, Oberst,
  APOLLO17_ORTHOMOSAIC_50CM.TIFF  LROC NAC orthomosaic 0.5 m } Robinson 2018/2019, USGS Astropedia
  Apollo17_PDS_Hasse__DATA__APOLLO17_CONTROLPOINTS_2018.TAB  LM, ALSEP instruments, flag, the
                                  station panorama and LRV positions (body-fixed x, y, z, m)
  sldem_512_rows_4480_5560.bin    SLDEM2015 rows for the far terrain (prepare_far.py)
  The control points and the traverse were extracted from Apollo17_PDS_fullPackage_Haase.zip by
  HTTP range requests (only the bytes of those files).

Output (public/data/<site>/): heightmap.bin, ortho.jpg, ortho_hi.jpg, shadow.png, stars.bin,
terrain.json. Then: prepare_far.py --site <site>, prepare_sky.py --site <site>.

Usage: python tools/prepare_moon_site.py --site apollo17
"""
import json
import math
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import heightmap_io  # noqa: E402
from ephemeris import LunarSky  # noqa: E402
from moon_sites import RAW, site_arg  # noqa: E402
from prepare_terrain import bake_shadow, write_stars  # noqa: E402

MOON_R = 1737400.0
STAR_FILE = os.path.join(RAW, "bsc5-short.json")

BUILD = {
    "apollo17": {
        "dtm": os.path.join(RAW, "apollo17", "APOLLO17_DTM_150CM.TIFF"),
        "ortho": os.path.join(RAW, "apollo17", "APOLLO17_ORTHOMOSAIC_50CM.TIFF"),
        "points": os.path.join(RAW, "apollo17", "Apollo17_PDS_Hasse__DATA__APOLLO17_CONTROLPOINTS_2018.TAB"),
        # 10.4 x 10.4 km at 2.6 m: all nine geology stations (Nansen at the South Massif to
        # the Sculptured Hills) at least 250 m inside, the window inside the measured DTM.
        "size": 4000,
        "px": 2.6,
        "centre_from_lm": (-1930.0, 30.0),  # metres east, north of the LM
        "hi_from_lm": (0.0, 0.0),
        "hi_size": 2458.0,
        "source": "DTM 1.5 m and LROC NAC orthomosaic 0.5 m of Taurus-Littrow (Haase et al. 2019, USGS; "
                  "NASA/GSFC/Arizona State University); sites: Haase et al. control points; "
                  "edges: SLDEM2015 (LOLA + SELENE TC)",
    },
}
ORTHO_OUT = 4096
HI_OUT = 4096
SHADOW_OUT = 2000


def game_grid(lat_c, lon_c, size, px):
    """CRS and transform of the game grid (top-left pixel corner at x = -half, z = -half)."""
    crs = CRS.from_proj4(f"+proj=eqc +lat_ts={lat_c} +lat_0={lat_c} +lon_0={lon_c} +R={MOON_R} +units=m +no_defs")
    half = size * px / 2
    return crs, from_origin(-half, half, px, px)


def read_points(path):
    """Haase et al. control points: name -> (lat, lon, height above 1737.4 km)."""
    out = {}
    for line in open(path, encoding="latin-1"):
        p = [s.strip() for s in line.split(",")]
        if len(p) < 5:
            continue
        x, y, z = map(float, p[1:4])
        name = ",".join(p[4:]).strip('"').strip()
        r = math.sqrt(x * x + y * y + z * z)
        out[name] = (math.degrees(math.asin(z / r)), math.degrees(math.atan2(y, x)), r - MOON_R)
    return out


def warp(src_path, crs, transform, shape, resampling, dtype=np.float32, nodata=np.nan):
    with rasterio.open(src_path) as s:
        dst = np.full(shape, nodata, dtype=dtype)
        reproject(
            source=rasterio.band(s, 1), destination=dst, src_transform=s.transform, src_crs=s.crs,
            src_nodata=s.nodata, dst_transform=transform, dst_crs=crs, dst_nodata=nodata, resampling=resampling,
        )
    return dst


def destripe(h):
    """
    Remove the seam stripes of a stereo-model mosaic: bands of columns whose cross-wise
    (x) roughness is far above the rest (the Apollo 17 DTM has one ~350 m wide, running
    the whole height of the valley). Inside them only the variation across the band is
    damped (a smoothing along x of the fine relief), so craters and slopes stay; the
    weight follows the anomaly, so there is no edge. Found from the data, not placed by hand.
    """
    hp = h - ndimage.gaussian_filter(h, 4)
    e = np.abs(np.diff(hp, axis=1)).mean(0)
    e = np.append(e, e[-1])
    med = np.median(e)
    z = (e - med) / (np.median(np.abs(e - med)) * 1.4826)
    z[:12] = 0
    z[-12:] = 0  # the filter's own edge effect
    w = np.clip((ndimage.gaussian_filter1d(z, 15) - 2.0) / 5.0, 0, 1)
    if w.max() == 0:
        return h
    cols = np.where(w > 0)[0]
    print(f"Seam stripes damped in columns {cols.min()}..{cols.max()} (max anomaly {z.max():.0f} sigma)")
    # The seam's noise is a ~25 m ripple in every direction. Inside the band the relief
    # finer than ~40 m is replaced by the fine relief of the same plain ~1.1 km to the
    # side (real regolith texture, small craters and all) - neither ripples nor a smooth
    # strip; larger forms (the Lee-Lincoln scarp, craters) stay.
    fine = h - ndimage.gaussian_filter(h, 8)
    shift = 420 if cols.min() < h.shape[1] // 2 else -420
    donor = np.roll(fine, -shift, axis=1)
    return h + (donor - fine) * w[None, :]


def deshade_check(ortho, h, px):
    """How much of the photo's brightness follows the slopes (the photo's own shading)."""
    gy, gx = np.gradient(h, px)
    m = ortho > 0
    return float(np.corrcoef(ortho[m][::97], gx[m][::97])[0, 1]), float(np.corrcoef(ortho[m][::97], gy[m][::97])[0, 1])


def remove_lm(img, cx, cy, radius_px):
    """Paint out the LM descent stage and its shadow (LROC imaged the site decades later):
    the game places the 3D model there."""
    import cv2

    mask = np.zeros_like(img, dtype=np.uint8)
    cv2.circle(mask, (int(round(cx)), int(round(cy))), int(round(radius_px)), 255, -1)
    return cv2.inpaint(img, mask, 9, cv2.INPAINT_TELEA)


def main():
    sid, site = site_arg("apollo17")
    b = BUILD[sid]
    out = site["out"]
    os.makedirs(out, exist_ok=True)
    size, px = b["size"], b["px"]
    lm_lat, lm_lon = site["lm"]
    # Window centre: an offset from the LM on the local sphere.
    e, n = b["centre_from_lm"]
    lat_c = lm_lat + math.degrees(n / MOON_R)
    lon_c = lm_lon + math.degrees(e / (MOON_R * math.cos(math.radians(lat_c))))
    crs, tr = game_grid(lat_c, lon_c, size, px)
    cos_sp = math.cos(math.radians(lat_c))

    def to_game(lat, lon):
        return MOON_R * cos_sp * math.radians(lon - lon_c), -MOON_R * math.radians(lat - lat_c)

    # Terrain.
    h = warp(b["dtm"], crs, tr, (size, size), Resampling.average).astype(np.float64)
    valid = np.isfinite(h) & (h > -1e20)
    print(f"DTM on the game grid: {valid.mean() * 100:.2f}% measured")
    if not valid.all():
        idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        h = h[tuple(idx)]
    h = destripe(h)
    hmin, hmax = float(h.min()), float(h.max())
    step = max(0.04, (hmax - hmin) / 65000.0)
    q = np.round((h - hmin) / step).astype(np.uint16)
    hmax = hmin + float(q.max()) * step
    heightmap_io.save(out, q)
    print(f"Heights {hmin:.1f} .. {hmax:.1f} m (relief {hmax - hmin:.0f} m), step {step * 100:.1f} cm")

    # Albedo image of the whole window and the high-resolution centre.
    opx = size * px / ORTHO_OUT
    _, otr = game_grid(lat_c, lon_c, ORTHO_OUT, opx)
    ortho = warp(b["ortho"], crs, otr, (ORTHO_OUT, ORTHO_OUT), Resampling.average, np.float32, 0.0)
    hs = np.asarray(Image.fromarray(h.astype(np.float32)).resize((ORTHO_OUT, ORTHO_OUT), Image.BILINEAR), dtype=np.float64)
    print("Photo brightness vs slope (east, south) correlation: %.2f %.2f" % deshade_check(ortho, hs, opx))
    have = ortho > 0
    if not have.all():
        ortho[~have] = float(ortho[have].mean())
    lm_x, lm_z = to_game(*site["lm"])
    ortho = remove_lm(np.clip(ortho, 0, 255).astype(np.uint8), (lm_x + size * px / 2) / opx, (lm_z + size * px / 2) / opx, 13 / opx)
    Image.fromarray(ortho).save(os.path.join(out, "ortho.jpg"), quality=93, optimize=True, progressive=True)

    hx, hz = lm_x + b["hi_from_lm"][0], lm_z - b["hi_from_lm"][1]
    hi_px = b["hi_size"] / HI_OUT
    hi_tr = from_origin(hx - b["hi_size"] / 2, -(hz - b["hi_size"] / 2), hi_px, hi_px)
    hi = warp(b["ortho"], crs, hi_tr, (HI_OUT, HI_OUT), Resampling.lanczos, np.float32, 0.0)
    m = hi > 0
    hi = np.where(m, hi, float(hi[m].mean()))
    hi = remove_lm(np.clip(hi, 0, 255).astype(np.uint8), (lm_x - hx + b["hi_size"] / 2) / hi_px, (lm_z - hz + b["hi_size"] / 2) / hi_px, 13 / hi_px)
    Image.fromarray(hi).save(os.path.join(out, "ortho_hi.jpg"), quality=93, optimize=True, progressive=True)

    # Sky and Sun at the start of EVA-1; baked terrain shadows.
    sky = LunarSky(site["epoch"], lm_lat, lm_lon)
    sun_az, sun_el = sky.az_el(sky.sun())
    earth_az, earth_el = sky.az_el(sky.earth())
    print(f"Sun az {sun_az:.1f} el {sun_el:.1f}; Earth az {earth_az:.1f} el {earth_el:.1f}")
    write_stars(sky, os.path.join(out, "stars.bin"))
    shadow = bake_shadow(h - hmin, sun_az, sun_el, SHADOW_OUT, px)
    Image.fromarray((shadow * 255).astype(np.uint8)).save(os.path.join(out, "shadow.png"), optimize=True)

    # Sites and hardware at the Haase et al. positions (registered on this orthomosaic).
    pts = read_points(b["points"])
    named = {"lm": "LM", "alsep": "ALSEP C/S", "flag": "US flag", "sep": "SEP transmitter"}
    sites = {}
    for k, name in named.items():
        la, lo, _ = pts[name]
        x, z = to_game(la, lo)
        sites[k] = {"lat": round(la, 6), "lon": round(lo, 6), "x": round(x, 2), "z": round(z, 2)}
    # LRV final parking (LROC, Wagner et al. 2016): east of the LM, its camera on Challenger.
    x, z = to_game(20.1896, 30.7769)
    sites["lrv"] = {"lat": 20.1896, "lon": 30.7769, "x": round(x, 2), "z": round(z, 2)}
    for i in range(1, 10):
        la, lo, _ = pts[f"Station {i},LRV/ center station {i}"]
        x, z = to_game(la, lo)
        sites[f"st{i}"] = {"lat": round(la, 6), "lon": round(lo, 6), "x": round(x, 2), "z": round(z, 2)}
    hardware = []
    for name in ("RTG", "LEAM", "LACE", "LSG", "LSP", "HFE", "G/M (geophone  module)", "Geo-1", "Geo-2", "Geo-3", "Geo-4"):
        la, lo, _ = pts[name]
        x, z = to_game(la, lo)
        hardware.append({"type": name.split(" ")[0].lower().replace("g/m", "gm"), "x": round(x, 2), "z": round(z, 2)})

    meta = {
        "source": b["source"],
        "width": size,
        "height": size,
        "pixelSize": px,
        "sizeX": (size - 1) * px,
        "sizeZ": (size - 1) * px,
        "minHeight": hmin,
        "maxHeight": hmax,
        "heightStep": step,
        "centerLat": lat_c,
        "centerLon": lon_c,
        "projection": {"radius": MOON_R, "standardParallel": lat_c},
        "landing": {"x": lm_x, "z": lm_z},
        "orthoHi": {"x": hx, "z": hz, "size": b["hi_size"]},
        "epoch": site["epoch"].isoformat(),
        "sun": {"azimuth": sun_az, "elevation": sun_el},
        "earth": {"azimuth": earth_az, "elevation": earth_el},
        "sites": sites,
        "hardware": hardware,
    }
    path = os.path.join(out, "terrain.json")
    if os.path.exists(path):
        prev = json.load(open(path, encoding="utf-8"))
        for k in ("galaxy", "far", "detail"):  # written by prepare_sky.py / prepare_far.py / prepare_detail.py
            if k in prev:
                meta[k] = prev[k]
    json.dump(meta, open(path, "w", encoding="utf-8"), indent=2)
    for k, v in sites.items():
        print(f"  site {k:6s} x {v['x']:8.1f}  z {v['z']:8.1f}")
    total = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out) if os.path.isfile(os.path.join(out, f)))
    print(f"Site data: {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
