"""Prepare a Mars site with a lava-tube skylight: the collapse pit on Pavonis Mons.

The pit: a conical collapse ~190 m across on the flank of Pavonis Mons (3.73 N, 248.49 E),
walls at the angle of repose, a ~30 m opening in the centre into a void below; the top of
the debris pile is seen ~28 m below the rim of the opening, and the volume of the cone
gives a cavity at least ~90 m deep (HiRISE DTM release "A Giant Cave on a Giant
Volcano", ESP_023531_1840 / ESP_023953_1840, Mattson, U. Arizona).

Sources (all public, NASA/JPL/UArizona; USGS):
  HiRISE DTM 1 m    DTEEC_023531_1840_023953_1840_A01.IMG (hirise-pds.lpl.arizona.edu)
  HiRISE ortho 25 cm ESP_023531_1840_RED_A_01_ORTHO.JP2
  Far terrain       HRSC + MOLA blended DEM, 200 m (Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2,
                    read remotely by window)

Outputs (public/data/pavonis/): heightmap.bin (3300² at 1 m), ortho.jpg (4096² over the
window), ortho_hi.jpg (4096² over 1 km around the pit, 25 cm), shadow.png, far_height.png,
far_shadow.png, terrain.json. Then: python tools/deshade.py --dir public/data/pavonis
--backup raw_data/arsia/ortho_shaded (the HiRISE ortho carries its own sunlight).

Usage: python tools/prepare_pavonis.py   (inputs in raw_data/arsia, see README in the DTM folder)
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

import heightmap_io
from prepare_mars import R_MARS, bake_shadow, fill_mean, mars_sun

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data", "arsia")
OUT = os.path.join(ROOT, "public", "data", "pavonis")
DTM = os.path.join(RAW, "DTEEC_023531_1840_023953_1840_A01.IMG")
ORTHO = os.path.join(RAW, "ESP_023531_1840_RED_A_01_ORTHO.JP2")
FAR_DEM = "/vsicurl/https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"

# The DTM's projection (eqc, lat_ts 0, lon_0 248.5) - its own coordinates of the pit
# (lowest point) and of the centre of the largest fully measured square around it.
SRC_CRS = CRS.from_proj4(f"+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=248.5 +x_0=0 +y_0=0 +R={R_MARS} +units=m +no_defs")
SIZE, PX = 3300, 1.0
ORTHO_OUT, HI_OUT, HI_SIZE = 4096, 4096, 1024.0
FAR_N, FAR_SP = 501, 60.0


def to_latlon(x, y):
    return math.degrees(y / R_MARS), 248.5 + math.degrees(x / R_MARS)


def main():
    os.makedirs(OUT, exist_ok=True)
    with rasterio.open(DTM) as s:
        res = s.res[0]
        # Window centre (DTM row 2032, col 3120 in metres from the corner) and the pit.
        cx, cy = s.bounds.left + 3120 * res, s.bounds.top - 2032 * res
        full = s.read(1)
        valid = full > -1e30
        a = np.where(valid, full, np.nan)
        # The pit: lowest point within 400 m of the coarse estimate.
        r0, c0 = s.index(-717.0, 222133.0)
        sub = np.where(valid, full, 1e9)[r0 - 400:r0 + 400, c0 - 400:c0 + 400]
        rr, cc = np.unravel_index(sub.argmin(), sub.shape)
        px_, py_ = s.xy(r0 - 400 + rr, c0 - 400 + cc)
        src_t = s.transform
    center_lat, center_lon = to_latlon(cx, cy)
    pit_lat, pit_lon = to_latlon(px_, py_)
    print(f"Window centre {center_lat:.5f} N {center_lon:.5f} E; pit {pit_lat:.5f} N {pit_lon:.5f} E")
    game = CRS.from_proj4(f"+proj=eqc +lat_ts={center_lat} +lat_0={center_lat} +lon_0={center_lon} +x_0=0 +y_0=0 +R={R_MARS} +units=m +no_defs")

    def gxz(lat, lon):
        return (R_MARS * math.cos(math.radians(center_lat)) * math.radians(lon - center_lon), -R_MARS * math.radians(lat - center_lat))

    a = fillnodata(np.where(valid, full, 0).astype(np.float32), mask=valid.astype(np.uint8), max_search_distance=200)
    tr = from_origin(-SIZE * PX / 2, SIZE * PX / 2, PX, PX)
    h = np.zeros((SIZE, SIZE), np.float32)
    reproject(a, h, src_transform=src_t, src_crs=SRC_CRS, dst_transform=tr, dst_crs=game, resampling=Resampling.cubic)
    # Stereo-correlation noise: the DTM's 1-2 m cellular ripple on the smooth dust mantle
    # (the photo shows none) would light up as lumps. Smooth it where the ground is
    # gentle; keep the cone, its scarps and the opening sharp (blend by slope).
    from scipy import ndimage
    soft = ndimage.gaussian_filter(h, 2.5)
    sharp = ndimage.gaussian_filter(h, 1.6)  # also irons out the DTM's 2-3 m contour terracing on the cone
    slope = np.degrees(np.arctan(np.hypot(*np.gradient(soft, PX))))
    wkeep = np.clip((slope - 6.0) / 8.0, 0.0, 1.0)
    h = (soft * (1 - wkeep) + sharp * wkeep).astype(np.float32)
    hmin, hmax = float(h.min()), float(h.max())
    print(f"Heights {hmin:.1f} .. {hmax:.1f} m (areoid), relief {hmax - hmin:.1f} m")
    step = max(0.004, (hmax - hmin) / 65000)
    heightmap_io.save(OUT, np.round((h - hmin) / step).astype(np.uint16))

    with rasterio.open(ORTHO) as s:
        o = np.zeros((ORTHO_OUT, ORTHO_OUT), np.uint8)
        reproject(rasterio.band(s, 1), o, dst_transform=from_origin(-SIZE * PX / 2, SIZE * PX / 2, SIZE * PX / ORTHO_OUT, SIZE * PX / ORTHO_OUT),
                  dst_crs=game, src_crs=SRC_CRS, resampling=Resampling.average, src_nodata=0, dst_nodata=0)
        Image.fromarray(fill_mean(o)).save(os.path.join(OUT, "ortho.jpg"), quality=84, optimize=True, progressive=True)
        px_g, pz_g = gxz(pit_lat, pit_lon)
        hi = np.zeros((HI_OUT, HI_OUT), np.uint8)
        reproject(rasterio.band(s, 1), hi, dst_transform=from_origin(px_g - HI_SIZE / 2, -pz_g + HI_SIZE / 2, HI_SIZE / HI_OUT, HI_SIZE / HI_OUT),
                  dst_crs=game, src_crs=SRC_CRS, resampling=Resampling.lanczos, src_nodata=0, dst_nodata=0)
        Image.fromarray(fill_mean(hi)).save(os.path.join(OUT, "ortho_hi.jpg"), quality=84, optimize=True, progressive=True)

    # Afternoon (~15:00 local true solar time) of a sol in northern spring: the cone's
    # walls half in shadow, the opening dark.
    day = datetime(2022, 4, 20, tzinfo=timezone.utc)
    best = None
    for m in range(0, 24 * 60 + 40, 2):
        t = day.replace(hour=0) + __import__("datetime").timedelta(minutes=m)
        az, el, ls, ltst = mars_sun(t, pit_lat, pit_lon)
        if best is None or abs(ltst - 15.0) < abs(best[4] - 15.0):
            best = (t, az, el, ls, ltst)
    epoch, az, el, ls, ltst = best
    print(f"Epoch {epoch.isoformat()}: Sun az {az:.1f} el {el:.1f}, Ls {ls:.1f}, LTST {int(ltst)}:{int(ltst % 1 * 60):02d}")
    shadow = bake_shadow(h, PX, az, el, 3300 // 2)
    Image.fromarray((shadow * 255).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)

    # Far terrain: Pavonis Mons around, HRSC+MOLA 200 m on a 60 m grid.
    far_size = (FAR_N - 1) * FAR_SP
    tr_far = from_origin(-far_size / 2 - FAR_SP / 2, far_size / 2 + FAR_SP / 2, FAR_SP, FAR_SP)
    far = np.zeros((FAR_N, FAR_N), np.float32)
    print("Reading HRSC+MOLA (remote window) ...", flush=True)
    with rasterio.open(FAR_DEM) as s:
        reproject(rasterio.band(s, 1), far, dst_transform=tr_far, dst_crs=game, resampling=Resampling.bilinear,
                  src_nodata=s.nodata, dst_nodata=-32768, warp_mem_limit=1024, num_threads=4)
    cgrid = (np.arange(FAR_N) - (FAR_N - 1) / 2) * FAR_SP
    zz, xx = np.meshgrid(cgrid, cgrid, indexing="ij")
    half = SIZE * PX / 2
    inwin = (np.abs(xx) < half - 100) & (np.abs(zz) < half - 100)
    hs = np.asarray(Image.fromarray(h).resize((int(SIZE * PX / FAR_SP),) * 2, Image.BILINEAR))
    offset = float(hs.mean() - far[inwin].mean())
    far = far + offset
    rel = far - hmin
    lo, hi_ = float(rel.min()), float(rel.max())
    Image.fromarray(np.round((rel - lo) / (hi_ - lo) * 65535).astype(np.uint16), mode="I;16").save(os.path.join(OUT, "far_height.png"), optimize=True)
    Image.fromarray((bake_shadow(rel, FAR_SP, az, el, FAR_N) * 255).astype(np.uint8)).save(os.path.join(OUT, "far_shadow.png"), optimize=True)
    print(f"Far grid {FAR_N}² @ {FAR_SP} m, offset {offset:.1f} m, range {lo:.0f}..{hi_:.0f}")

    px_g, pz_g = gxz(pit_lat, pit_lon)
    # Start: ~240 m east of the pit on the smooth dust-mantled flank, facing it (west).
    meta = {
        "body": "mars",
        "source": "HiRISE DTM 1 m (DTEEC_023531_1840_023953_1840) + ortho 25 cm (ESP_023531_1840); HRSC+MOLA 200 m (NASA/JPL/UArizona; ESA/DLR/FU Berlin; USGS)",
        "width": SIZE, "height": SIZE, "pixelSize": PX,
        "sizeX": (SIZE - 1) * PX, "sizeZ": (SIZE - 1) * PX,
        "minHeight": hmin, "maxHeight": hmax, "heightStep": step,
        "centerLat": center_lat, "centerLon": center_lon,
        "landing": {"x": px_g + 240.0, "z": pz_g + 30.0},
        "orthoHi": {"x": px_g, "z": pz_g, "size": HI_SIZE},
        "epoch": epoch.isoformat(),
        "sun": {"azimuth": az, "elevation": el},
        "ls": ls,
        "far": {"n": FAR_N, "spacing": FAR_SP, "size": far_size, "min": lo, "max": hi_, "offset": offset, "source": "HRSC+MOLA blended DEM 200 m"},
        "sites": {"pit": {"lat": pit_lat, "lon": pit_lon, "x": px_g, "z": pz_g}},
        # Thick Tharsis dust mantle: few rocks show through.
        "rockAbundance": 0.6,
    }
    json.dump(meta, open(os.path.join(OUT, "terrain.json"), "w", encoding="utf-8"), indent=2)
    for f in sorted(os.listdir(OUT)):
        print(f"  {f}: {os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
