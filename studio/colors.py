"""Colour arithmetic for the palette checks (sRGB hex -> CIE Lab, ΔE 1976)."""
from __future__ import annotations

import math
import re

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    if not HEX.match(h):
        raise ValueError(f"not a #RRGGBB colour: {h!r}")
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def rgb_to_lab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    def lin(v: float) -> float:
        v /= 255.0
        return ((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92

    r, g, b = (lin(c) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t: float) -> float:
        return math.copysign(abs(t) ** (1 / 3), t) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(a: str, b: str) -> float:
    la, lb = rgb_to_lab(hex_to_rgb(a)), rgb_to_lab(hex_to_rgb(b))
    return math.dist(la, lb)
