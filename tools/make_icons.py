"""Generate the PWA icons (192, 512, maskable 512, apple-touch 180) procedurally.

Design ("Planetokhod"): a deep indigo field; one planet split by a soft S-shaped
terminator into the Moon (cool silver, craters) and Mars (rust-orange, polar
cap); a glowing orbit ring that passes behind and in front of the planet; a
white rover glyph riding the ring. Rendered at 2048 px with numpy and
downsampled for clean edges.
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "icons")
S = 2048


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def background(s):
    y, x = np.mgrid[0:s, 0:s].astype(np.float32) / s
    t = np.clip((x * 0.45 + y * 0.75), 0, 1)
    top = np.array([16, 22, 58], np.float32)
    bot = np.array([34, 12, 44], np.float32)
    img = top[None, None, :] * (1 - t[..., None]) + bot[None, None, :] * t[..., None]
    # Two soft glows: cool upper-left, warm lower-right.
    g1 = np.exp(-(((x - 0.25) ** 2 + (y - 0.2) ** 2) / 0.06))[..., None] * np.array([40, 70, 140])
    g2 = np.exp(-(((x - 0.82) ** 2 + (y - 0.85) ** 2) / 0.05))[..., None] * np.array([120, 40, 20])
    img = img + g1 + g2
    # Stars.
    rng = np.random.default_rng(11)
    for _ in range(140):
        sx, sy = rng.uniform(0, 1, 2)
        b = rng.uniform(0, 1) ** 4
        r = (1.2 + b * 5) / 2048 * s
        d2 = ((x - sx) ** 2 + (y - sy) ** 2) * s * s
        img += np.exp(-d2 / (2 * r * r))[..., None] * (90 + 165 * b)
    return img


def planet(s, cx, cy, R):
    y, x = np.mgrid[0:s, 0:s].astype(np.float32)
    nx, ny = (x - cx) / R, (y - cy) / R
    r2 = nx * nx + ny * ny
    inside = r2 <= 1
    nz = np.sqrt(np.clip(1 - r2, 0, 1))
    # Light from the upper left.
    L = np.array([-0.55, -0.6, 0.58])
    L = L / np.linalg.norm(L)
    lam = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    shade = 0.42 + 0.58 * lam ** 0.8
    # S-shaped split: Moon upper-left, Mars lower-right.
    split = (nx + ny) * 0.7071 + 0.18 * np.sin(ny * 3.0 - nx * 1.2)
    mars = smooth(-0.03, 0.03, split)
    # Moon: silver with craters and maria.
    moon = np.stack([lerp(150, 225, lam), lerp(160, 230, lam), lerp(185, 245, lam)], -1)
    rng = np.random.default_rng(3)
    for _ in range(16):
        ux, uy = rng.uniform(-0.9, 0.3), rng.uniform(-0.9, 0.3)
        rr = rng.uniform(0.05, 0.16)
        d = np.sqrt((nx - ux) ** 2 + (ny - uy) ** 2) / rr
        rim = np.exp(-((d - 1) ** 2) / 0.03) * 0.07
        bowl = smooth(1.0, 0.7, d) * 0.1
        moon *= (1 - bowl + rim)[..., None]
    mare = np.exp(-(((nx + 0.35) ** 2) / 0.05 + ((ny + 0.1) ** 2) / 0.03)) * 0.25
    moon *= (1 - mare)[..., None]
    # Mars: rust with darker albedo bands and a polar cap at the lower-right limb.
    band = 0.5 + 0.5 * np.sin(nx * 4.0 + ny * 2.5 + np.sin(ny * 6) * 0.8)
    marsc = np.stack([lerp(205, 255, lam), lerp(78, 150, lam), lerp(32, 72, lam)], -1)
    marsc *= (0.82 + 0.18 * band)[..., None]
    cap = smooth(0.88, 0.95, (nx * 0.5 + ny * 0.86)) * 0.6
    marsc = marsc * (1 - cap[..., None]) + np.array([250, 235, 225]) * cap[..., None]
    col = moon * (1 - mars[..., None]) + marsc * mars[..., None]
    col *= shade[..., None] / np.maximum(shade.max(), 1e-3) * 1.05
    # Seam glow and rim light.
    seam = np.exp(-(split ** 2) / 0.0012) * 0.7
    col += seam[..., None] * np.array([255, 220, 160]) * 0.55
    rim = np.clip(1 - nz, 0, 1) ** 3
    col += rim[..., None] * (np.array([120, 180, 255]) * (1 - mars[..., None]) + np.array([255, 130, 60]) * mars[..., None]) * 0.45
    alpha = smooth(1.0, 0.996, np.sqrt(r2)) * inside
    return col, alpha


def ring_layer(s, cx, cy, a, b, tilt, width, front):
    """Orbit ellipse (front or back half) as an RGBA layer with a gradient stroke and glow."""
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pts = []
    n = 720
    for i in range(n + 1):
        t = i / n * 2 * math.pi
        x, y = a * math.cos(t), b * math.sin(t)
        ct, st = math.cos(tilt), math.sin(tilt)
        pts.append((cx + x * ct - y * st, cy + x * st + y * ct, t))
    for i in range(n):
        x0, y0, t0 = pts[i]
        x1, y1, _ = pts[i + 1]
        is_front = math.sin(t0) > 0
        if is_front != front:
            continue
        u = (math.cos(t0 - 0.6) + 1) / 2  # amber -> cyan around the ring
        c = (int(lerp(90, 255, u)), int(lerp(210, 180, u)), int(lerp(255, 80, u)), 255)
        d.line([(x0, y0), (x1, y1)], fill=c, width=width)
        d.ellipse([x0 - width / 2, y0 - width / 2, x0 + width / 2, y0 + width / 2], fill=c)
    glow = img.filter(ImageFilter.GaussianBlur(width * 2.2))
    out = Image.alpha_composite(glow, glow)
    return Image.alpha_composite(out, img)


def rover_glyph(s, x, y, size, angle):
    """Minimal white rover: body, mast with camera head, solar deck, three wheels."""
    k = 4
    w = int(size * 2.2)
    g = Image.new("RGBA", (w * k, w * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    u = size * k / 10
    ox, oy = w * k / 2, w * k / 2
    white = (255, 255, 255, 255)
    # Deck and body.
    d.rounded_rectangle([ox - 4.6 * u, oy - 1.9 * u, ox + 4.6 * u, oy - 1.2 * u], radius=0.35 * u, fill=white)
    d.rounded_rectangle([ox - 3.4 * u, oy - 1.4 * u, ox + 3.0 * u, oy + 0.6 * u], radius=0.6 * u, fill=white)
    # Mast and head.
    d.rounded_rectangle([ox + 1.9 * u, oy - 5.0 * u, ox + 2.5 * u, oy - 1.6 * u], radius=0.3 * u, fill=white)
    d.rounded_rectangle([ox + 1.2 * u, oy - 5.9 * u, ox + 3.6 * u, oy - 4.6 * u], radius=0.45 * u, fill=white)
    # Rocker-bogie legs.
    d.line([(ox - 2.8 * u, oy + 0.2 * u), (ox - 3.6 * u, oy + 1.9 * u)], fill=white, width=int(0.55 * u))
    d.line([(ox + 2.4 * u, oy + 0.2 * u), (ox + 3.4 * u, oy + 1.9 * u)], fill=white, width=int(0.55 * u))
    d.line([(ox - 0.2 * u, oy + 0.2 * u), (ox - 0.2 * u, oy + 1.9 * u)], fill=white, width=int(0.55 * u))
    for wx in (-3.6, -0.2, 3.4):
        r = 1.25 * u
        d.ellipse([ox + wx * u - r, oy + 2.2 * u - r, ox + wx * u + r, oy + 2.2 * u + r], fill=white)
        r2 = 0.45 * u
        d.ellipse([ox + wx * u - r2, oy + 2.2 * u - r2, ox + wx * u + r2, oy + 2.2 * u + r2], fill=(40, 30, 70, 255))
    g = g.rotate(-math.degrees(angle), resample=Image.BICUBIC).resize((w, w), Image.LANCZOS)
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    shadow = g.copy()
    shadow.putalpha(shadow.getchannel("A").point(lambda v: v * 0.6))
    glow = Image.new("RGBA", g.size, (255, 200, 120, 0))
    glow.putalpha(g.getchannel("A").filter(ImageFilter.GaussianBlur(size * 0.18)).point(lambda v: min(255, v * 1.4)))
    layer.alpha_composite(glow, (int(x - w / 2), int(y - w / 2)))
    layer.alpha_composite(g, (int(x - w / 2), int(y - w / 2)))
    return layer


def render(scale: float) -> Image.Image:
    s = S
    bg = background(s)
    c = s / 2
    R = s * 0.3 * scale
    cx, cy = c - s * 0.01 * scale, c - s * 0.02 * scale
    col, alpha = planet(s, cx, cy, R)
    # Soft drop shadow / glow behind the planet.
    halo = np.exp(-np.clip((np.hypot(*np.meshgrid(np.arange(s) - cx, np.arange(s) - cy)) - R) / (s * 0.06), 0, None) ** 2)
    bg += halo[..., None] * np.array([60, 50, 110]) * 0.6
    img = bg * (1 - alpha[..., None]) + col * alpha[..., None]
    base = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    a, b, tilt = R * 1.55, R * 0.42, math.radians(-18)
    width = max(6, int(s * 0.016 * scale))
    back = ring_layer(s, cx, cy, a, b, tilt, width, front=False)
    # The back half disappears behind the planet.
    pm = Image.fromarray((alpha * 255).astype(np.uint8), "L")
    back.putalpha(Image.fromarray(np.minimum(np.asarray(back.getchannel("A")), 255 - np.asarray(pm)).astype(np.uint8)))
    out = Image.alpha_composite(base, back)
    out = Image.alpha_composite(out, ring_layer(s, cx, cy, a, b, tilt, width, front=True))
    # Rover on the front of the ring, standing on it (tangent orientation).
    t = math.radians(78)
    ex, ey = a * math.cos(t), b * math.sin(t)
    ct, st = math.cos(tilt), math.sin(tilt)
    rx, ry = cx + ex * ct - ey * st, cy + ex * st + ey * ct
    dx, dy = -a * math.sin(t), b * math.cos(t)
    tx, ty = dx * ct - dy * st, dx * st + dy * ct
    ang = math.atan2(ty, tx) + math.pi
    size = s * 0.12 * scale
    nxr, nyr = -math.sin(ang), math.cos(ang)  # up from the ring
    rover = rover_glyph(s, rx - nxr * size * 0.28, ry - nyr * size * 0.28, size, ang)
    out = Image.alpha_composite(out, rover)
    return out.convert("RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    full = render(1.0)
    safe = render(0.78)  # maskable: content inside the 80 % safe zone
    full.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"), optimize=True)
    full.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"), optimize=True)
    full.resize((180, 180), Image.LANCZOS).save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)
    safe.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-maskable-512.png"), optimize=True)
    full.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, "favicon-64.png"), optimize=True)
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
