"""Low-precision ephemerides for the lunar sky at the Apollo 15 site.

- Sun: Astronomical Almanac low-precision formula (~0.01 deg).
- Moon (geocentric, to get the Earth's direction from the Moon): AA low-precision
  series (~0.3 deg), includes optical librations naturally.
- Moon orientation: IAU WGCCRE model (alpha0, delta0, W), periodic terms omitted (~1-3 deg).

Local frame of the game: +x east, +y up, -z north.
"""
import math
from datetime import datetime, timezone

import numpy as np

D2R = math.pi / 180.0


def julian_day(dt: datetime) -> float:
    return dt.timestamp() / 86400.0 + 2440587.5


def ecl_to_eq(lon_deg, lat_deg, eps_deg=23.4393):
    l, b, e = lon_deg * D2R, lat_deg * D2R, eps_deg * D2R
    x = math.cos(b) * math.cos(l)
    y = math.cos(b) * math.sin(l) * math.cos(e) - math.sin(b) * math.sin(e)
    z = math.cos(b) * math.sin(l) * math.sin(e) + math.sin(b) * math.cos(e)
    return np.array([x, y, z])


def sun_dir_icrf(d):
    L = 280.460 + 0.9856474 * d
    g = (357.528 + 0.9856003 * d) * D2R
    lam = L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)
    return ecl_to_eq(lam, 0.0)


def moon_geocentric_icrf_km(d):
    T = d / 36525.0
    s = lambda a, b: math.sin((a + b * T) * D2R)
    c = lambda a, b: math.cos((a + b * T) * D2R)
    lam = (218.32 + 481267.881 * T + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36)
           + 0.66 * s(235.7, 890534.22) + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05)
           - 0.11 * s(186.5, 966404.03))
    beta = 5.13 * s(93.3, 483202.03) + 0.28 * s(228.2, 960400.89) - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21)
    par = (0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36)
           + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74))
    r = 6378.14 / math.sin(par * D2R)
    return ecl_to_eq(lam, beta) * r


def moon_body_rotation(d):
    """Matrix taking ICRF vectors into the Moon's body-fixed (mean Earth/polar axis) frame."""
    T = d / 36525.0
    a0 = (269.9949 + 0.0031 * T) * D2R
    d0 = (66.5392 + 0.0130 * T) * D2R
    W = (38.3213 + 13.17635815 * d) * D2R

    def rz(t):
        return np.array([[math.cos(t), math.sin(t), 0], [-math.sin(t), math.cos(t), 0], [0, 0, 1]])

    def rx(t):
        return np.array([[1, 0, 0], [0, math.cos(t), math.sin(t)], [0, -math.sin(t), math.cos(t)]])

    return rz(W) @ rx(math.pi / 2 - d0) @ rz(math.pi / 2 + a0)


def enu_basis(lat_deg, lon_deg):
    f, l = lat_deg * D2R, lon_deg * D2R
    up = np.array([math.cos(f) * math.cos(l), math.cos(f) * math.sin(l), math.sin(f)])
    east = np.array([-math.sin(l), math.cos(l), 0.0])
    north = np.cross(up, east)
    return east, north, up


class LunarSky:
    def __init__(self, when: datetime, lat_deg: float, lon_deg: float):
        self.d = julian_day(when) - 2451545.0
        self.R = moon_body_rotation(self.d)
        self.e, self.n, self.u = enu_basis(lat_deg, lon_deg)

    def to_game(self, v_icrf):
        """ICRF unit vector(s) -> game frame (x east, y up, z south). Accepts (3,) or (N,3)."""
        b = np.asarray(v_icrf) @ self.R.T
        x = b @ self.e
        y = b @ self.u
        z = -(b @ self.n)
        return np.stack([x, y, z], axis=-1)

    @staticmethod
    def az_el(v):
        x, y, z = v
        return (math.degrees(math.atan2(x, -z)) % 360, math.degrees(math.asin(max(-1, min(1, y)))))

    def sun(self):
        return self.to_game(sun_dir_icrf(self.d))

    def earth(self):
        m = moon_geocentric_icrf_km(self.d)
        return self.to_game(-m / np.linalg.norm(m))


APOLLO15_LANDING = datetime(1971, 7, 30, 22, 16, 29, tzinfo=timezone.utc)


if __name__ == "__main__":
    sky = LunarSky(APOLLO15_LANDING, 26.13224, 3.63400)
    print("sun   az/el", sky.az_el(sky.sun()))
    print("earth az/el", sky.az_el(sky.earth()))
