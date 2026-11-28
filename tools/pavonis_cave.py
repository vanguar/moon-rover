"""The cave under the Pavonis Mons skylight: measured opening + reconstructed void.

Measured (HiRISE DTM): the opening's rim height and its outline (radius at 72 bearings
where the ground first rises above the rim height going outward), the top of the debris
pile seen through it (28 m below the rim, per the HiRISE release). From the funnel's
volume the release gives a cavity at least ~90 m deep and a pile at least ~62 m tall.

Reconstructed (not observed): a lava tube along the volcano's downslope direction (the
tube the collapse fell into), ~70 m wide and ~80 m tall, roof ~10 m thick at the
opening. Written into terrain.json "cave"; the game builds the meshes from it.

Usage: python tools/pavonis_cave.py   (after prepare_pavonis.py)
"""
import json
import math
import os

import numpy as np
from PIL import Image

import heightmap_io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "public", "data", "pavonis")
RIM_ABOVE_PILE = 28.0   # HiRISE release: debris top 28 m below the rim of the opening
CAVITY_DEPTH = 90.0     # ... cavity at least 90 m deep below the rim


def main():
    m = json.load(open(os.path.join(D, "terrain.json"), encoding="utf-8"))
    px = m["pixelSize"]
    h = heightmap_io.load(D).astype(float) * m["heightStep"] + m["minHeight"]
    half = m["sizeX"] / 2
    p = m["sites"]["pit"]
    r0, c0 = int(round(p["z"] + half)), int(round(p["x"] + half))
    W = 60
    w = h[r0 - W:r0 + W, c0 - W:c0 + W]
    pile = float(w.min())
    rim = pile + RIM_ABOVE_PILE
    yy, xx = np.nonzero(w < rim - 2)
    cz, cx = yy.mean() + r0 - W - half, xx.mean() + c0 - W - half
    # Outline of the opening: per bearing, the first radius where the ground is above the rim.
    radii = []
    for k in range(72):
        a = 2 * math.pi * k / 72
        r = 2.0
        while r < 45:
            x, z = cx + math.cos(a) * r, cz + math.sin(a) * r
            i, j = int(round(z + half)), int(round(x + half))
            if h[i, j] >= rim:
                break
            r += 0.5
        radii.append(round(r, 1))
    # Downslope direction of the flank (the tube's axis) from the far terrain.
    f = m["far"]
    a = np.asarray(Image.open(os.path.join(D, "far_height.png"))).astype(float)
    hf = f["min"] + (f["max"] - f["min"]) * a / 65535
    n, sp = f["n"], f["spacing"]
    i, j = int(round(cz / sp + (n - 1) / 2)), int(round(cx / sp + (n - 1) / 2))
    gz = (hf[i + 5, j] - hf[i - 5, j]) / (10 * sp)
    gx = (hf[i, j + 5] - hf[i, j - 5]) / (10 * sp)
    g = math.hypot(gx, gz)
    axis = [-gx / g, -gz / g]
    rel = lambda y: round(y - m["minHeight"], 2)
    m["cave"] = {
        "x": round(cx, 2), "z": round(cz, 2),
        "rimY": rel(rim), "pileTopY": rel(pile),
        "ceilY": rel(rim - 10.0), "floorY": rel(rim - CAVITY_DEPTH),
        "holeR": radii, "axis": [round(axis[0], 4), round(axis[1], 4)],
        "width": 70.0, "length": 520.0, "slope": round(g, 4),
        "source": "opening and pile top: HiRISE DTM; depth: HiRISE release estimate; tube shape: reconstruction",
    }
    # A find for the journal: the debris pile, photographed from inside (by the helicopter).
    m["sites"]["cave"] = {"lat": p["lat"], "lon": p["lon"], "x": m["cave"]["x"], "z": m["cave"]["z"]}
    json.dump(m, open(os.path.join(D, "terrain.json"), "w", encoding="utf-8"), indent=2)
    print(json.dumps({k: v for k, v in m["cave"].items() if k != "holeR"}))
    print("opening radius min/mean/max", min(radii), round(sum(radii) / 72, 1), max(radii))


if __name__ == "__main__":
    main()
