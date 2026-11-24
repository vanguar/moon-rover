"""Heightmap file format of the game: heightmap.bin (lossless, ~1/3 smaller than a 16-bit PNG).

Layout: b"HM16", uint32 LE width, uint32 LE height, then one zlib stream of
2 * width * height bytes: the low bytes, then the high bytes of every residual.

Residual = value - prediction, wrapped to int16 and zigzag-coded to uint16.
Prediction: the planar predictor W + N - NW (left neighbour on the first row,
upper one in the first column, 0 for the first pixel). The DTM is smooth, so the
residuals are small and the two byte planes deflate far better than the PNG's
interleaved, per-row filtered bytes. Decoded by src/terrain/heightmap.ts.
"""
import os
import struct
import zlib

import numpy as np

MAGIC = b"HM16"
FILE = "heightmap.bin"


def encode(q: np.ndarray) -> bytes:
    assert q.dtype == np.uint16 and q.ndim == 2
    h, w = q.shape
    a = q.astype(np.int64)
    p = np.zeros_like(a)
    p[0, 1:] = a[0, :-1]
    p[1:, 0] = a[:-1, 0]
    p[1:, 1:] = a[1:, :-1] + a[:-1, 1:] - a[:-1, :-1]
    r = ((a - p) & 0xFFFF).astype(np.uint16).view(np.int16).astype(np.int64)
    z = ((r << 1) ^ (r >> 15)) & 0xFFFF
    planes = (z & 0xFF).astype(np.uint8).tobytes() + (z >> 8).astype(np.uint8).tobytes()
    return MAGIC + struct.pack("<II", w, h) + zlib.compress(planes, 9)


def decode(buf: bytes) -> np.ndarray:
    if buf[:4] != MAGIC:
        raise ValueError("not a heightmap.bin file")
    w, h = struct.unpack("<II", buf[4:12])
    planes = np.frombuffer(zlib.decompress(buf[12:]), dtype=np.uint8)
    z = planes[: w * h].astype(np.int64) | (planes[w * h :].astype(np.int64) << 8)
    r = (z >> 1) ^ -(z & 1)
    # value = residual + W + N - NW is a 2-D prefix sum of the residuals (mod 2^16).
    return (np.cumsum(np.cumsum(r.reshape(h, w), axis=0), axis=1) & 0xFFFF).astype(np.uint16)


def save(out_dir: str, q: np.ndarray) -> None:
    with open(os.path.join(out_dir, FILE), "wb") as f:
        f.write(encode(q))


def load(data_dir: str) -> np.ndarray:
    """Raw 16-bit heights (metres = minHeight + value * heightStep, see terrain.json)."""
    with open(os.path.join(data_dir, FILE), "rb") as f:
        return decode(f.read())


if __name__ == "__main__":
    # Convert an existing 16-bit PNG: python tools/heightmap_io.py public/data/heightmap.png
    import sys

    from PIL import Image

    for png in sys.argv[1:]:
        q = np.asarray(Image.open(png)).astype(np.uint16)
        out = os.path.dirname(png)
        save(out, q)
        assert np.array_equal(load(out), q), "round trip failed"
        print(f"{png}: {os.path.getsize(png)} -> {os.path.getsize(os.path.join(out, FILE))} bytes, lossless")
