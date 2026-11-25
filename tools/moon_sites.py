"""Lunar game sites: where each one's data lives and what it is built from.

Used by prepare_far.py, prepare_sky.py and prepare_moon_site.py (`--site <id>`);
the Apollo 15 terrain itself is built by prepare_terrain.py (its DTM is a narrow strip
merged with SLDEM2015 - a different recipe).
"""
import os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "raw_data")

SITES = {
    "apollo15": {
        "out": os.path.join(ROOT, "public", "data"),
        # LM Falcon (LROC, Wagner et al. 2017).
        "lm": (26.13224, 3.63400),
        # Start of EVA-1 (Scott and Irwin drive the LRV for the first time).
        "epoch": datetime(1971, 7, 31, 13, 13, 0, tzinfo=timezone.utc),
        # SLDEM2015 tile 00N-30N 000-045E, 512 px/deg: rows fetched by an HTTP range request.
        "sldem": (os.path.join(RAW, "sldem_512_rows_1470_2500.bin"), 1470, 1030),
    },
    "apollo17": {
        "out": os.path.join(ROOT, "public", "data", "apollo17"),
        # LM Challenger (Haase et al. 2018 control points; LROC: 20.1911 N, 30.7723 E).
        "lm": (20.19091, 30.77168),
        # Start of EVA-1, 11 Dec 1972 23:54:49 UTC (Cernan and Schmitt).
        "epoch": datetime(1972, 12, 11, 23, 54, 49, tzinfo=timezone.utc),
        "sldem": (os.path.join(RAW, "apollo17", "sldem_512_rows_4480_5560.bin"), 4480, 1080),
    },
}


def site_arg(default="apollo15"):
    """The --site <id> command-line argument (or the default)."""
    import sys

    a = sys.argv
    sid = a[a.index("--site") + 1] if "--site" in a else default
    if sid not in SITES:
        raise SystemExit(f"unknown site {sid!r}; known: {', '.join(SITES)}")
    return sid, SITES[sid]
