"""Rock surface atlas for Mars from real rover photographs (NASA/JPL-Caltech/MSSS/ASU,
public domain): textures, grain, fractures and colour of actual Martian rocks.

Tiles (512 px each, 2 x 2):
  0  "Aztec" outcrop, Curiosity Mastcam (PIA19066): flaky, fractured sandstone slab
  1  "Agate Hill", same frame: blocky, cross-cut slab
  2  "Yeehgo", Perseverance Mastcam-Z (PIA24492): dusty, finely pitted Jezero rock
  3  "Cine", Perseverance (PIA24936): dark, rough basaltic rock
Each tile is normalised to mean 128 per channel (the shader scales it to each
rock's albedo) and made seamless by mirroring in the shader.

Moon (python tools/prepare_rocktex.py moon): Apollo Hasselblad frames (NASA, public
domain) - the split boulder at Apollo 17 station 6 (AS17-140-21496, two faces) and
House Rock, Apollo 16 (AS16-116-18649) and a rock at the rille rim, Apollo 15
(AS15-82-11164): breccia and basalt, grey, glass-
lined zap pits, fractures.

Output: public/data/mars/rocks.jpg, public/data/rocks.jpg
"""
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R = os.path.join(ROOT, "raw_data", "marsrocks")
CROPS = [
    ("PIA19066_MarsCuriosityRover_AlexanderHillsRock_20141123_Fig1.jpg", (430, 300, 650, 520)),
    ("PIA19066_MarsCuriosityRover_AlexanderHillsRock_20141123_Fig1.jpg", (1645, 395, 1820, 570)),  # between the annotation arrow (x < 1643) and the black frame
    ("PIA24492.jpg", (330, 260, 780, 710)),
    ("PIA24936.jpg", (800, 900, 1400, 1500)),
]


MOON = [
    ("AS17-140-21496.jpg", (260, 560, 460, 760)),
    ("AS17-140-21496.jpg", (470, 400, 660, 590)),
    ("AS16-116-18649.jpg", (600, 300, 880, 580)),
    ("AS15-82-11164.jpg", (350, 300, 500, 450)),
]


def main():
    import sys
    moon = len(sys.argv) > 1 and sys.argv[1] == "moon"
    global R, CROPS
    if moon:
        R = os.path.join(ROOT, "raw_data", "moonrocks")
        CROPS = MOON
    atlas = Image.new("RGB", (1024, 1024))
    for k, (f, box) in enumerate(CROPS):
        im = Image.open(os.path.join(R, f)).convert("RGB").crop(box).resize((512, 512), Image.LANCZOS)
        a = np.asarray(im).astype(np.float64)
        # Divide out the tile's overall colour cast (white balance / enhanced colour of the
        # source frame): local colour variation stays, the game tints each rock.
        a *= 128.0 / np.maximum(a.reshape(-1, 3).mean(0), 1.0)
        # Soften the photographed light and shadow at large scale (the game lights the rock);
        # fractures, grains and colour patches below ~5 % of the tile stay.
        from scipy import ndimage
        lum = a.mean(2, keepdims=True)
        big = ndimage.gaussian_filter(lum, (40, 40, 0))
        a *= (128.0 + (big - 128.0) * 0.35) / np.maximum(big, 1.0)
        atlas.paste(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)), ((k % 2) * 512, (k // 2) * 512))
    out = os.path.join(ROOT, "public", "data", "rocks.jpg" if moon else os.path.join("mars", "rocks.jpg"))
    atlas.save(out, quality=88, optimize=True, progressive=True)
    print("rocks.jpg", os.path.getsize(out) / 1e6, "MB")


if __name__ == "__main__":
    main()
