"""Surface material map of the Mars window: rocky pavement vs. loose sand.

On the Jezero floor the lighter-toned areas of the HiRISE image are the Máaz
bedrock pavement (fractured, dusty, rocky) and the darker ones are basaltic sand
and regolith with ripples. The map is the orthophoto's brightness (8 m average) relative to its
~150 m surroundings, smoothed: 255 = pavement, 0 = sand. The game uses the SAME map
for the look (plates, cracks, colour) and for the physics (plates are proud of the
sand, so the rover jolts over them).

Output: public/data/mars/material.png (8-bit, 1024², covering the whole window).
Usage: python tools/prepare_material.py   (after deshade.py)
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, "public", "data", "mars")


def main():
    o = np.asarray(Image.open(os.path.join(D, "ortho.jpg")).convert("L")).astype(np.float64)
    o = np.asarray(Image.fromarray(o.astype(np.uint8)).resize((1024, 1024), Image.LANCZOS)).astype(np.float64)
    px = 6000.0 / 1024  # ~5.9 m
    # Patches of tens of metres (ripple shading and single rocks are averaged out).
    rel = ndimage.gaussian_filter(o, 8.0 / px) / np.maximum(ndimage.gaussian_filter(o, 150.0 / px), 1.0)
    t = np.clip((rel - 0.94) / (1.08 - 0.94), 0, 1)
    m = t * t * (3 - 2 * t)
    Image.fromarray((m * 255).astype(np.uint8)).save(os.path.join(D, "material.png"), optimize=True)
    print(f"material.png: pavement {(m > 0.5).mean() * 100:.0f}% of the window, "
          f"{os.path.getsize(os.path.join(D, 'material.png')) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
