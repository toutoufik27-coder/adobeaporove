"""Small numpy image helpers, kept free of scipy/opencv so the tool installs anywhere."""

from __future__ import annotations

import math

import numpy as np
from PIL import Image

# Rec. 601 luma weights; stock sites judge brightness the way viewers see it, not per channel.
_LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)


def luminance(rgb: np.ndarray) -> np.ndarray:
    """uint8 HxWx3 -> float32 HxW in 0..255."""
    return rgb.astype(np.float32) @ _LUMA


def gaussian_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(math.ceil(3 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float32)
    k = np.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum()


def blur(stack: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur over the last two axes of a float32 array (works on a stack of tiles)."""
    k = gaussian_kernel(sigma)
    r = len(k) // 2
    pad = [(0, 0)] * (stack.ndim - 2) + [(r, r), (r, r)]
    p = np.pad(stack, pad, mode="reflect")
    h, w = stack.shape[-2:]
    rows = np.zeros(p.shape[:-1] + (w,), dtype=np.float32)
    for i, weight in enumerate(k):
        rows += weight * p[..., i : i + w]
    out = np.zeros(stack.shape, dtype=np.float32)
    for i, weight in enumerate(k):
        out += weight * rows[..., i : i + h, :]
    return out


def tiles(gray: np.ndarray, size: int, max_tiles: int) -> tuple[np.ndarray, list[tuple[int, int]]]:
    """Cut a grayscale image into non-overlapping size x size tiles, evenly thinned to at most max_tiles.

    Returns an (N, size, size) array of the input dtype and each tile's top-left (y, x). Images smaller than one
    tile yield a single cropped tile.
    """
    h, w = gray.shape
    if h < size or w < size:
        s = min(h, w)
        return gray[:s, :s][None].copy(), [(0, 0)]
    ny, nx = h // size, w // size
    coords = [(y, x) for y in range(ny) for x in range(nx)]
    if len(coords) > max_tiles:
        pick = np.linspace(0, len(coords) - 1, max_tiles).round().astype(int)
        coords = [coords[i] for i in pick]
    out = np.empty((len(coords), size, size), dtype=gray.dtype)
    for n, (y, x) in enumerate(coords):
        out[n] = gray[y * size : (y + 1) * size, x * size : (x + 1) * size]
    return out, [(y * size, x * size) for y, x in coords]


def band_filter_noise_gain(sigma_a: float, sigma_b: float | None) -> float:
    """Variance a unit white-noise field keeps after the band filter (G_a - G_b) or (identity - G_a).

    Used to subtract the noise contribution from measured band energies.
    """
    size = 41
    impulse = np.zeros((1, size, size), dtype=np.float32)
    impulse[0, size // 2, size // 2] = 1.0
    low_a = blur(impulse, sigma_a)
    if sigma_b is None:
        response = impulse - low_a
    else:
        response = low_a - blur(impulse, sigma_b)
    return float((response**2).sum())


def immerkaer_noise(stack: np.ndarray) -> np.ndarray:
    """Per-tile noise standard deviation (J. Immerkaer, 1996). Input (N, H, W) float32."""
    s = stack
    lap = (
        s[:, :-2, :-2] - 2 * s[:, :-2, 1:-1] + s[:, :-2, 2:]
        - 2 * s[:, 1:-1, :-2] + 4 * s[:, 1:-1, 1:-1] - 2 * s[:, 1:-1, 2:]
        + s[:, 2:, :-2] - 2 * s[:, 2:, 1:-1] + s[:, 2:, 2:]
    )
    h, w = s.shape[1:]
    return np.abs(lap).sum(axis=(1, 2)) * math.sqrt(math.pi / 2) / (6 * (w - 2) * (h - 2))


def downscale(img: Image.Image, max_side: int) -> Image.Image:
    """Return a copy no larger than max_side on its long edge (never upscales)."""
    w, h = img.size
    scale = max_side / max(w, h)
    if scale >= 1:
        return img.copy()
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
