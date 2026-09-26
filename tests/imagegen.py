from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw


def natural_rgb(h: int, w: int, seed: int = 0) -> np.ndarray:
    """A photo-like test image: 1/f noise (the spectrum of natural scenes) plus hard-edged shapes."""
    rng = np.random.default_rng(seed)
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    f = np.sqrt(fx**2 + fy**2)
    f[0, 0] = 1.0
    channels = []
    shared = rng.random(f.shape)
    for _ in range(3):
        phase = 0.8 * shared + 0.2 * rng.random(f.shape)
        field = np.fft.irfft2(np.exp(2j * np.pi * phase) / f, s=(h, w))
        field = (field - field.mean()) / field.std()
        channels.append(field)
    img = np.stack(channels, axis=-1) * 38 + 128
    pil = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(pil)
    for _ in range(40):
        x0, y0 = int(rng.integers(0, w - 50)), int(rng.integers(0, h - 50))
        x1, y1 = x0 + int(rng.integers(20, 400)), y0 + int(rng.integers(20, 400))
        color = tuple(int(v) for v in rng.integers(0, 255, 3))
        (draw.ellipse if rng.random() < 0.5 else draw.rectangle)((x0, y0, x1, y1), fill=color)
    return np.asarray(pil)
