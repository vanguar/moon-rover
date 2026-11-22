"""Sky extras for the Apollo 15 epoch: constellation stick figures and the
galactic frame (for the Milky Way band), in the game's local sky frame.

Inputs  (raw_data/): constellations.lines.json (d3-celestial, RA/Dec J2000)
Outputs (public/data/): constellations.bin (float32 xyz pairs per segment),
                        terrain.json gains "galaxy": {"pole": [x,y,z], "center": [x,y,z]}

Usage: python tools/prepare_sky.py   (after prepare_terrain.py)
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ephemeris import GAME_EPOCH, LunarSky  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data")
OUT = os.path.join(ROOT, "public", "data")


def radec(ra_deg, dec_deg):
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    return np.array([math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)])


def main():
    sky = LunarSky(GAME_EPOCH, 26.13224, 3.63400)
    data = json.load(open(os.path.join(RAW, "constellations.lines.json"), encoding="utf-8"))
    segs = []
    for f in data["features"]:
        for line in f["geometry"]["coordinates"]:
            pts = [sky.to_game(radec(lon % 360, lat)) for lon, lat in line]
            for a, b in zip(pts, pts[1:]):
                segs.extend([a, b])
    arr = np.array(segs, dtype=np.float32)
    arr.tofile(os.path.join(OUT, "constellations.bin"))
    print(f"Constellation segments: {len(arr) // 2}")

    # Galactic north pole and centre (J2000).
    pole = sky.to_game(radec(192.85948, 27.12825))
    center = sky.to_game(radec(266.40510, -28.93617))
    meta_path = os.path.join(OUT, "terrain.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    meta["galaxy"] = {"pole": [float(v) for v in pole], "center": [float(v) for v in center]}
    json.dump(meta, open(meta_path, "w", encoding="utf-8"), indent=2)
    print("Galactic pole (game frame):", np.round(pole, 3), "centre:", np.round(center, 3))


if __name__ == "__main__":
    main()
