"""Generate the PWA icons (192, 512, maskable 512) procedurally with Pillow.

Scene: a crescent Earth over the lunar horizon, a lunar rover with its umbrella
antenna, wheel tracks curving toward the viewer, a hard sun glint, stars.
"""
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "icons")
S = 2048


def radial(size, center, r, inner, outer):
    img = Image.new("RGBA", (size, size))
    px = img.load()
    cx, cy = center
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - cx, y - cy) / r)
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(4))
    return img


def scene(pad: float) -> Image.Image:
    random.seed(7)
    s = S
    # Deep-space background.
    bg = Image.new("RGBA", (s, s), (4, 7, 14, 255))
    glow = radial(s // 8, (s // 16 * 1.4, s // 16 * 0.5), s // 8 * 0.9, (22, 40, 78, 255), (4, 7, 14, 255)).resize((s, s), Image.BICUBIC)
    bg = Image.blend(bg, glow, 0.8)
    d = ImageDraw.Draw(bg)
    for _ in range(380):
        x, y = random.uniform(0, s), random.uniform(0, s * 0.62)
        b = random.random() ** 3
        r = 2 + b * 6
        c = int(120 + 135 * b)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(c, c, min(255, c + 20), 255))

    # Earth: crescent lit from the left (sun low on the left).
    ex, ey, er = s * 0.69, s * 0.3, s * 0.15
    earth = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ed = ImageDraw.Draw(earth)
    ed.ellipse([ex - er, ey - er, ex + er, ey + er], fill=(32, 92, 190, 255))
    for _ in range(26):
        a, rr = random.uniform(0, 6.28), random.uniform(0, er * 0.85)
        w = random.uniform(er * 0.15, er * 0.45)
        cx, cy = ex + math.cos(a) * rr, ey + math.sin(a) * rr
        col = random.choice([(240, 244, 250, 255), (70, 120, 60, 255), (235, 240, 248, 255)])
        ed.ellipse([cx - w, cy - w * 0.4, cx + w, cy + w * 0.4], fill=col)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse([ex - er, ey - er, ex + er, ey + er], fill=255)
    shade = Image.new("L", (s, s), 0)
    ImageDraw.Draw(shade).ellipse([ex - er + er * 0.32, ey - er * 1.1, ex + er * 1.45, ey + er * 1.1], fill=255)
    shade = shade.filter(ImageFilter.GaussianBlur(s * 0.012))
    lit = ImageChops.subtract(mask, shade)
    earth.putalpha(lit)
    atm = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(atm).ellipse([ex - er - 14, ey - er - 14, ex + er + 14, ey + er + 14], outline=(120, 180, 255, 200), width=10)
    atm.putalpha(ImageChops.multiply(atm.getchannel("A"), ImageChops.subtract(Image.new("L", (s, s), 255), shade)))
    atm = atm.filter(ImageFilter.GaussianBlur(8))
    bg = Image.alpha_composite(bg, atm)
    bg = Image.alpha_composite(bg, earth)

    # Lunar surface: big curved horizon, craters, side-lit.
    ground = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    gd = ImageDraw.Draw(ground)
    hy = s * 0.62
    gd.ellipse([-s * 0.6, hy, s * 1.6, hy + s * 2.2], fill=(118, 114, 108, 255))
    shade_g = radial(s // 8, (s // 16 * 1.9, s // 16 * 0.9), s // 8 * 0.8, (175, 170, 162, 255), (52, 50, 48, 255)).resize((s, s), Image.BICUBIC)
    ground = Image.composite(shade_g, ground, ground.getchannel("A"))
    gd = ImageDraw.Draw(ground)
    for _ in range(34):
        cx = random.uniform(0, s)
        cy = random.uniform(hy + s * 0.04, s)
        persp = (cy - hy) / (s - hy)
        w = random.uniform(20, 120) * (0.3 + persp * 1.8)
        h = w * (0.25 + persp * 0.3)
        gd.ellipse([cx - w, cy - h, cx + w, cy + h], fill=(70, 67, 63, 255))
        gd.arc([cx - w, cy - h, cx + w, cy + h], 200, 340, fill=(205, 200, 190, 255), width=max(3, int(w * 0.08)))
    # Wheel tracks curving to the viewer.
    rx, ry = s * 0.47, s * 0.635
    for off in (-1, 1):
        pts = []
        for i in range(60):
            tt = i / 59
            x = rx + off * (14 + tt * 210) - math.sin(tt * 2.2) * s * 0.28 * tt
            y = ry + 30 + tt * (s - ry)
            pts.append((x, y))
        for i in range(len(pts) - 1):
            wdt = int(6 + i * 0.9)
            gd.line([pts[i], pts[i + 1]], fill=(48, 46, 44, 255), width=wdt)
    bg = Image.alpha_composite(bg, ground)

    # Rover silhouette (gold) with umbrella antenna, sun-lit rim.
    rv = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rv)
    k = s / 1024
    base = ry
    gold = (255, 196, 64, 255)
    rd.rectangle([rx - 120 * k, base - 60 * k, rx + 120 * k, base - 36 * k], fill=gold)
    rd.rectangle([rx - 60 * k, base - 96 * k, rx + 20 * k, base - 60 * k], fill=gold)
    rd.line([rx + 70 * k, base - 60 * k, rx + 70 * k, base - 150 * k], fill=(230, 236, 240, 255), width=int(8 * k))
    rd.pieslice([rx + 20 * k, base - 200 * k, rx + 120 * k, base - 130 * k], 180, 360, fill=(235, 240, 245, 255))
    rd.line([rx - 100 * k, base - 60 * k, rx - 100 * k, base - 120 * k], fill=(230, 236, 240, 255), width=int(5 * k))
    for wx in (-90, 0, 90):
        c = (rx + wx * k, base - 18 * k)
        rr = 30 * k
        rd.ellipse([c[0] - rr, c[1] - rr, c[0] + rr, c[1] + rr], fill=(30, 30, 32, 255), outline=gold, width=int(7 * k))
        rd.ellipse([c[0] - 8 * k, c[1] - 8 * k, c[0] + 8 * k, c[1] + 8 * k], fill=gold)
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon(
        [(rx - 120 * k, base + 10 * k), (rx + 120 * k, base + 10 * k), (rx + 520 * k, base + 60 * k), (rx + 260 * k, base + 70 * k)], fill=(0, 0, 0, 170)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(4))
    bg = Image.alpha_composite(bg, shadow)
    bg = Image.alpha_composite(bg, rv)

    # Sun glint at the upper-left edge.
    sun = radial(s // 4, (s // 8 * 0.35, s // 8 * 0.55), s // 4 * 0.22, (255, 250, 235, 230), (255, 250, 235, 0)).resize((s, s), Image.BICUBIC)
    bg = Image.alpha_composite(bg, sun)
    fl = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fl)
    sx, sy = s * 0.18, s * 0.27
    fd.line([sx - s * 0.2, sy, sx + s * 0.2, sy], fill=(255, 245, 220, 200), width=10)
    fd.line([sx, sy - s * 0.12, sx, sy + s * 0.12], fill=(255, 245, 220, 150), width=6)
    fl = fl.filter(ImageFilter.GaussianBlur(5))
    bg = Image.alpha_composite(bg, fl)
    ImageDraw.Draw(bg).ellipse([sx - 36, sy - 36, sx + 36, sy + 36], fill=(255, 255, 250, 255))

    # Rounded-square frame with a thin cyan rim.
    if pad > 0:
        inner = int(s * pad)
        bg = bg.resize((s - 2 * inner, s - 2 * inner), Image.LANCZOS)
        canvas = Image.new("RGBA", (s, s), (4, 7, 14, 255))
        canvas.paste(bg, (inner, inner))
        bg = canvas
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    rim = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle([6, 6, s - 7, s - 7], radius=int(s * 0.22), outline=(90, 210, 255, 160), width=14)
    out = Image.alpha_composite(bg, rim)
    out.putalpha(m)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    regular = scene(0.0)
    regular.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"))
    regular.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
    # Maskable: full-bleed square, content inside the 80 % safe zone.
    mk = scene(0.1)
    full = Image.new("RGBA", mk.size, (4, 7, 14, 255))
    full = Image.alpha_composite(full, mk)
    full.convert("RGB").resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-maskable-512.png"))
    print("icons written")


if __name__ == "__main__":
    main()
