"""Prepare a Mars site in Gale crater: Glen Torridon and the sulfate-bearing buttes at the
foot of Mount Sharp (Aeolis Mons), along Curiosity's traverse.

Sources (USGS Astrogeology; NASA/JPL-Caltech/UArizona; ESA/DLR/FU Berlin):
  MSL_Gale_DEM_Mosaic_1m_v3.tif          merged HiRISE/CTX/HRSC DEM tied to MOLA, 1 m (Calef & Parker)
  MSL_Gale_HiRISE-LRGB_78quads_sharp_cog colour HiRISE mosaic, 25 cm (read remotely by window)
  HRSC+MOLA blended DEM, 200 m            far terrain (Mount Sharp on the horizon)

The DEM window is fetched once by raw_data/gale/fetch_dem.py (the file is stored in
1-row strips: ~650 MB of rows for a 5.4 km window).

Outputs (public/data/gale/): heightmap.bin (2500² at 2 m), ortho.jpg, ortho_hi.jpg,
shadow.png, far_height.png, far_shadow.png, terrain.json. Then:
  python tools/deshade.py --dir public/data/gale --backup raw_data/gale/ortho_shaded
"""
import json
import math
import os
from datetime import datetime, timedelta, timezone

import numpy as np
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.fill import fillnodata
from rasterio.transform import Affine, from_origin
from rasterio.warp import reproject

import heightmap_io
from prepare_mars import R_MARS, bake_shadow, mars_sun

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data", "gale")
OUT = os.path.join(ROOT, "public", "data", "gale")
LRGB = "/vsicurl/https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif"
FAR_DEM = "/vsicurl/https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif"
SRC_CRS = CRS.from_proj4(f"+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={R_MARS} +units=m +no_defs")
CX, CY = 8144887.0, -281538.0          # window centre in the source projection
SIZE, PX = 2500, 2.0                    # 5 km at 2 m
ORTHO_OUT, HI_OUT, HI_SIZE = 4096, 4096, 1200.0
FAR_N, FAR_SP = 501, 120.0              # 60 km: Mount Sharp's slopes on the horizon
# Gale floor albedo (TES ~0.2) close to the Jezero floor: the same mean as its ortho.
ORTHO_MEAN = 108.0


def main():
    os.makedirs(OUT, exist_ok=True)
    center_lat, center_lon = math.degrees(CY / R_MARS), math.degrees(CX / R_MARS)
    game = CRS.from_proj4(f"+proj=eqc +lat_ts={center_lat} +lat_0={center_lat} +lon_0={center_lon} +x_0=0 +y_0=0 +R={R_MARS} +units=m +no_defs")
    print(f"Window centre {center_lat:.5f} N {center_lon:.5f} E")

    a = np.load(os.path.join(RAW, "dem_window.npy")).astype(np.float32)
    t = Affine(*json.load(open(os.path.join(RAW, "dem_window.json"))))
    valid = a > -30000
    print(f"DEM window {a.shape}, measured {valid.mean() * 100:.2f}%")
    if not valid.all():
        a = fillnodata(np.where(valid, a, 0), mask=valid.astype(np.uint8), max_search_distance=300)
    tr = from_origin(-SIZE * PX / 2, SIZE * PX / 2, PX, PX)
    h = np.zeros((SIZE, SIZE), np.float32)
    reproject(a, h, src_transform=t, src_crs=SRC_CRS, dst_transform=tr, dst_crs=game, resampling=Resampling.average)
    hmin, hmax = float(h.min()), float(h.max())
    step = max(0.004, (hmax - hmin) / 65000)
    print(f"Heights {hmin:.1f} .. {hmax:.1f} m, relief {hmax - hmin:.1f} m, step {step * 100:.1f} cm")
    heightmap_io.save(OUT, np.round((h - hmin) / step).astype(np.uint16))

    # Photo: the colour HiRISE mosaic, as luminance (the game lights it itself).
    with rasterio.open(LRGB) as s:
        def lum(size_m, n, cx=0.0, cz=0.0, rs=Resampling.average):
            rgb = np.zeros((3, n, n), np.uint8)
            for b in range(3):
                reproject(rasterio.band(s, b + 1), rgb[b], dst_transform=from_origin(cx - size_m / 2, -cz + size_m / 2, size_m / n, size_m / n),
                          dst_crs=game, src_crs=SRC_CRS, resampling=rs, dst_nodata=0)
            return (0.30 * rgb[0] + 0.55 * rgb[1] + 0.15 * rgb[2]).astype(np.float32)
        print("Reading the HiRISE colour mosaic (remote) ...", flush=True)
        o = lum(SIZE * PX, ORTHO_OUT)
        gain = ORTHO_MEAN / float(o[o > 0].mean())
        Image.fromarray(np.clip(o * gain, 0, 255).astype(np.uint8)).save(os.path.join(OUT, "ortho.jpg"), quality=84, optimize=True, progressive=True)
        hx, hz = 0.0, 0.0
        hi = lum(HI_SIZE, HI_OUT, hx, hz, Resampling.lanczos)
        Image.fromarray(np.clip(hi * gain, 0, 255).astype(np.uint8)).save(os.path.join(OUT, "ortho_hi.jpg"), quality=84, optimize=True, progressive=True)

    # Afternoon, ~15:00 local true solar time.
    day = datetime(2024, 6, 15, tzinfo=timezone.utc)
    best = None
    for m in range(0, 24 * 60 + 40, 2):
        tt = day + timedelta(minutes=m)
        az, el, ls, ltst = mars_sun(tt, center_lat, center_lon)
        if best is None or abs(ltst - 15.0) < abs(best[4] - 15.0):
            best = (tt, az, el, ls, ltst)
    epoch, az, el, ls, ltst = best
    print(f"Epoch {epoch.isoformat()}: Sun az {az:.1f} el {el:.1f}, Ls {ls:.1f}, LTST {int(ltst)}:{int(ltst % 1 * 60):02d}")
    shadow = bake_shadow(h, PX, az, el, SIZE)
    Image.fromarray((shadow * 255).astype(np.uint8)).save(os.path.join(OUT, "shadow.png"), optimize=True)

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
    inwin = (np.abs(xx) < half - 150) & (np.abs(zz) < half - 150)
    hs = np.asarray(Image.fromarray(h).resize((int(SIZE * PX / FAR_SP),) * 2, Image.BILINEAR))
    offset = float(hs.mean() - far[inwin].mean())
    far = far + offset
    rel = far - hmin
    lo, hi_ = float(rel.min()), float(rel.max())
    Image.fromarray(np.round((rel - lo) / (hi_ - lo) * 65535).astype(np.uint16), mode="I;16").save(os.path.join(OUT, "far_height.png"), optimize=True)
    Image.fromarray((bake_shadow(rel, FAR_SP, az, el, FAR_N) * 255).astype(np.uint8)).save(os.path.join(OUT, "far_shadow.png"), optimize=True)
    print(f"Far grid {FAR_N}² @ {FAR_SP} m, offset {offset:.1f} m, range {lo:.0f}..{hi_:.0f}")

    meta = {
        "body": "mars",
        "source": "MSL Gale merged DEM 1 m (HiRISE/CTX/HRSC on MOLA; Calef & Parker, USGS) + HiRISE colour mosaic; HRSC+MOLA 200 m",
        "width": SIZE, "height": SIZE, "pixelSize": PX,
        "sizeX": (SIZE - 1) * PX, "sizeZ": (SIZE - 1) * PX,
        "minHeight": hmin, "maxHeight": hmax, "heightStep": step,
        "centerLat": center_lat, "centerLon": center_lon,
        "landing": {"x": 0.0, "z": 0.0},
        "orthoHi": {"x": hx, "z": hz, "size": HI_SIZE},
        "epoch": epoch.isoformat(),
        "sun": {"azimuth": az, "elevation": el},
        "ls": ls,
        "far": {"n": FAR_N, "spacing": FAR_SP, "size": far_size, "min": lo, "max": hi_, "offset": offset, "source": "HRSC+MOLA blended DEM 200 m"},
        "sites": {},
        # Glen Torridon: clay-bearing bedrock with loose blocks, the buttes shed boulders.
        "rockAbundance": 3.0,
    }
    json.dump(meta, open(os.path.join(OUT, "terrain.json"), "w", encoding="utf-8"), indent=2)
    for f in sorted(os.listdir(OUT)):
        print(f"  {f}: {os.path.getsize(os.path.join(OUT, f)) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
