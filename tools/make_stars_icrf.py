"""Yale Bright Star Catalogue as ICRF unit vectors, for skies that turn in the game
(Mars: src/fx/MarsNight.ts rotates them with the planet).

Input  raw_data/bsc5-short.json
Output public/data/stars_icrf.bin: float32 [x, y, z (ICRF), Vmag, T_K] per star

Usage: python tools/make_stars_icrf.py
"""
import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_ra(s):
    h, m, sec = s.replace("h", "").replace("m", "").replace("s", "").split()
    return (float(h) + float(m) / 60 + float(sec) / 3600) * 15


def parse_dec(s):
    sign = -1 if s.strip().startswith("-") else 1
    d, m, sec = s.replace("°", " ").replace("′", " ").replace("″", " ").replace("+", "").replace("-", "").split()
    return sign * (float(d) + float(m) / 60 + float(sec) / 3600)


def main():
    rows = []
    for st in json.load(open(os.path.join(ROOT, "raw_data", "bsc5-short.json"), encoding="utf-8")):
        try:
            ra, dec, v = parse_ra(st["RA"]), parse_dec(st["Dec"]), float(st["V"])
        except (KeyError, ValueError):
            continue
        rows.append((ra, dec, v, float(st.get("K") or 5800)))
    a = np.array(rows)
    ra, dec = np.radians(a[:, 0]), np.radians(a[:, 1])
    icrf = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=1)
    out = np.concatenate([icrf, a[:, 2:3], a[:, 3:4]], axis=1).astype(np.float32)
    out.tofile(os.path.join(ROOT, "public", "data", "stars_icrf.bin"))
    print(f"Stars: {len(out)}")


if __name__ == "__main__":
    main()
