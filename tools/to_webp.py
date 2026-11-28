"""Last step of every site pipeline: the photo layers to WebP (30-70 % smaller).

Per file, the lowest WebP quality that keeps the fine texture: the high-pass energy
(detail finer than ~3 px) at least 90 % of the JPEG's, and no visible difference (PSNR
>= 38 dB). Low-contrast photos (the smooth dust of Pavonis) need a high quality - at 82
WebP flattened their faint grain into square blocks; if even 95 cannot keep it, the
JPEG stays. Kept as
JPEG: milkyway.jpg (WebP gains ~6 % there) and the Mars detail tiles (their colour
channels carry coded slopes, which WebP's chroma subsampling would spoil).

The JPEG masters move to raw_data/jpg/<site> (other tools read them there if needed:
run deshade.py / prepare_material.py before this step).

Usage: python tools/to_webp.py [data dir ...]   (default: every site)
"""
import io
import os
import shutil
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMES = ("ortho.jpg", "ortho_hi.jpg", "far_albedo.jpg", "rocks.jpg")
SITES = ["public/data", "public/data/apollo17", "public/data/mars", "public/data/pavonis", "public/data/gale"]


def _hp(a):
    """Detail finer than ~3 px (image minus its blur)."""
    b = np.asarray(Image.fromarray(a.astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5)), np.float64)
    return a - b


def pick_quality(im):
    """Lowest quality passing on five samples (centre and corners): every part must keep its texture."""
    g = im.convert("L")
    w, h = g.size
    n = min(768, w // 3, h // 3)
    boxes = [((w - n) // 2, (h - n) // 2), (0, 0), (w - n, 0), (0, h - n), (w - n, h - n)]
    subs = [g.crop((x, y, x + n, y + n)) for x, y in boxes]
    for q in (82, 88, 92, 95):
        ok = True
        for sub in subs:
            r = np.asarray(sub, np.float64)
            buf = io.BytesIO()
            sub.save(buf, "WEBP", quality=q, method=6)
            t = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("L"), np.float64)
            keep = _hp(t).std() / max(_hp(r).std(), 1e-6)
            mse = ((t - r) ** 2).mean()
            psnr = 99 if mse == 0 else 10 * np.log10(255 ** 2 / mse)
            if keep < 0.9 or psnr < 38:
                ok = False
                break
        if ok:
            return q
    return None


def main():
    dirs = sys.argv[1:] or SITES
    total_j = total_w = 0
    for d in dirs:
        full = os.path.join(ROOT, d)
        if not os.path.isdir(full):
            continue
        keep = os.path.join(ROOT, "raw_data", "jpg", os.path.relpath(full, os.path.join(ROOT, "public")))
        for n in NAMES:
            src = os.path.join(full, n)
            if not os.path.exists(src):
                continue
            dst = src[:-4] + ".webp"
            im = Image.open(src)
            q = pick_quality(im)
            if q is None:
                print(f"{os.path.relpath(src, ROOT)}: kept as JPEG (WebP loses its fine texture)")
                continue
            im.save(dst, "WEBP", quality=q, method=6)
            j, w = os.path.getsize(src), os.path.getsize(dst)
            total_j += j
            total_w += w
            os.makedirs(keep, exist_ok=True)
            shutil.move(src, os.path.join(keep, n))
            print(f"{os.path.relpath(dst, ROOT)}: q{q} {j / 1e6:.2f} -> {w / 1e6:.2f} MB")
    if total_j:
        print(f"total {total_j / 1e6:.1f} -> {total_w / 1e6:.1f} MB ({(1 - total_w / total_j) * 100:.0f}% less)")


if __name__ == "__main__":
    main()
