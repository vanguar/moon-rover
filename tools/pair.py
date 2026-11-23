"""Side-by-side comparison image: NASA reference photo | game screenshot (same size)."""
import sys

from PIL import Image, ImageDraw

ref, game, out, label, note = sys.argv[1:6]
a = Image.open(ref).convert("RGB")
b = Image.open(game).convert("RGB")
H = 700
a = a.resize((round(a.width * H / a.height), H), Image.LANCZOS)
b = b.resize((round(b.width * H / b.height), H), Image.LANCZOS)
im = Image.new("RGB", (a.width + b.width + 12, H + 34), (20, 20, 20))
im.paste(a, (0, 34))
im.paste(b, (a.width + 12, 34))
d = ImageDraw.Draw(im)
d.text((8, 10), f"NASA {label} (public domain)", fill=(230, 230, 230))
d.text((a.width + 20, 10), f"game  {note}", fill=(230, 230, 230))
im.save(out, quality=85)
