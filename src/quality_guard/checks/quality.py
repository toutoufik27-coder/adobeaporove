"""Image quality at 100%: focus and upscaling, noise, exposure, added borders.

Sharpness compares neighbouring detail bands on full-resolution tiles. The fine ratio is what a 1px
blur removes against what a 2px blur removes; the coarse ratio is the 1-2px band against the 2-4px
band. Both ignore contrast, so a low-contrast photo and a punchy one score alike. Blur and upscaling
empty the finest band first: mild softness shows in the fine ratio, heavy blur in the coarse one.
Scores are the 90th percentile over tiles with visible structure, so a sharp subject on a soft
background still counts as sharp.
"""

from __future__ import annotations

import numpy as np

from ..config import Config
from ..findings import FileReport, Level
from ..imaging import band_filter_noise_gain, blur, immerkaer_noise, tiles

_FINE_GAIN = band_filter_noise_gain(1.0, None)
_MID_GAIN = band_filter_noise_gain(1.0, 2.0)
_MARGIN = 12  # drop tile borders touched by padding (the widest blur reaches 12px)


def measure(gray: np.ndarray, config: Config, alpha: np.ndarray | None = None) -> dict[str, float]:
    """Sharpness and noise from full-resolution tiles. Tiles with any transparency are ignored."""
    q = config.quality
    stack, coords = tiles(gray, q.tile_size, q.max_tiles)
    if alpha is not None:
        keep = [i for i, (y, x) in enumerate(coords)
                if alpha[y : y + q.tile_size, x : x + q.tile_size].min() == 255]
        stack, coords = stack[keep], [coords[i] for i in keep]
    n = len(stack)
    out: dict[str, float] = {"tiles": float(n)}
    if n == 0 or min(stack.shape[1:]) <= 4 * _MARGIN:
        return out
    noise_per_tile = np.empty(n, dtype=np.float32)
    fine = np.empty(n, dtype=np.float32)
    mid = np.empty(n, dtype=np.float32)
    coarse = np.empty(n, dtype=np.float32)
    c = slice(_MARGIN, -_MARGIN)
    for start in range(0, n, 32):  # chunks keep memory flat on 100 MP files
        chunk = stack[start : start + 32].astype(np.float32)
        b1 = blur(chunk, 1.0)
        b2 = blur(chunk, 2.0)
        b4 = blur(chunk, 4.0)
        k = len(chunk)
        noise_per_tile[start : start + k] = immerkaer_noise(chunk)
        fine[start : start + k] = (chunk - b1)[:, c, c].reshape(k, -1).var(axis=1)
        mid[start : start + k] = (b1 - b2)[:, c, c].reshape(k, -1).var(axis=1)
        coarse[start : start + k] = (b2 - b4)[:, c, c].reshape(k, -1).var(axis=1)

    # Noise: judged where the picture is flat, which is where viewers see it.
    structure = np.sqrt(np.maximum(mid - noise_per_tile**2 * _MID_GAIN, 0))
    flat = (structure < 1.5) & (np.sqrt(coarse) < 1.5)
    if flat.sum() >= max(3, 0.03 * n):
        out["noise"] = float(np.median(noise_per_tile[flat]))
    noise = out.get("noise", float(np.percentile(noise_per_tile, 10)))

    # Center of the most detailed tile: usually the subject, and the crop Claude inspects at 100%.
    best = int(np.argmax(structure + np.sqrt(coarse)))
    out["detail_y"] = float(coords[best][0] + stack.shape[1] / 2)
    out["detail_x"] = float(coords[best][1] + stack.shape[2] / 2)

    mid_c = np.maximum(mid - noise**2 * _MID_GAIN, 1e-6)
    textured = structure > 2.0
    if textured.sum() >= 3:
        fine_c = np.maximum(fine - noise**2 * _FINE_GAIN, 0)
        out["sharpness"] = float(np.percentile(np.sqrt(fine_c[textured] / mid_c[textured]), 90))
    shaped = np.sqrt(coarse) > 3.0
    if shaped.sum() >= 3:
        out["coarse_sharpness"] = float(np.percentile(np.sqrt(mid_c[shaped] / coarse[shaped]), 90))
    return out


def check_quality(report: FileReport, gray: np.ndarray, config: Config, alpha: np.ndarray | None = None) -> None:
    q = config.quality
    m = measure(gray, config, alpha)
    keys = ("sharpness", "coarse_sharpness", "noise", "detail_x", "detail_y")
    report.metrics.update({k: v for k, v in m.items() if k in keys})

    fine, coarse, noise = m.get("sharpness"), m.get("coarse_sharpness"), m.get("noise")
    reject = (fine is not None and fine < q.sharpness_reject) or (
        coarse is not None and coarse < q.coarse_sharpness_reject)
    review = (fine is not None and fine < q.sharpness_review) or (
        coarse is not None and coarse < q.coarse_sharpness_review)
    parts = []
    if fine is not None:
        parts.append(f"الحدة الدقيقة {fine:.2f} (الحادة 0.70 فأكثر)")
    if coarse is not None:
        parts.append(f"الحدة العامة {coarse:.2f} (الحادة 0.60 فأكثر)")
    detail = "، ".join(parts)
    # Heavy noise makes the sharpness estimate unreliable, so it never rejects on its own then.
    noisy = noise is not None and noise >= q.noise_review
    if reject and not noisy:
        report.add("quality.soft", "quality", Level.REJECT,
                   "الصورة ضبابية بتكبير 100%: تركيز خاطئ أو اهتزاز أو تكبير مصطنع للدقة", detail)
    elif reject or review:
        report.add("quality.soft", "quality", Level.REVIEW,
                   "الصورة لينة بتكبير 100%؛ افحص التركيز، وقد تكون مكبّرة من دقة أقل", detail)

    if noise is not None:
        detail = f"ضوضاء {noise:.1f} في المناطق الملساء (المقبول أقل من {q.noise_review:g})"
        if noise >= q.noise_reject:
            report.add("quality.noise", "quality", Level.REJECT,
                       "ضوضاء (noise) واضحة في المناطق الملساء", detail)
        elif noise >= q.noise_review:
            report.add("quality.noise", "quality", Level.REVIEW,
                       "ضوضاء (noise) ملحوظة في المناطق الملساء بتكبير 100%", detail)


def check_exposure(report: FileReport, rgb_small: np.ndarray, config: Config) -> None:
    q = config.quality
    y = rgb_small.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    h, w = y.shape
    ring = max(2, round(min(h, w) * 0.02))
    border = np.concatenate([y[:ring].ravel(), y[-ring:].ravel(), y[:, :ring].ravel(), y[:, -ring:].ravel()])
    white_bg = (border >= 245).mean() > 0.6
    black_bg = (border <= 10).mean() > 0.6
    highlights = float((y >= 253).mean())
    shadows = float((y <= 2).mean())
    mean = float(y.mean())
    report.metrics.update({"clipped_highlights": highlights, "clipped_shadows": shadows, "brightness": mean})

    if not white_bg:
        if highlights > q.highlight_clip_review:
            report.add("quality.highlights", "quality", Level.REVIEW,
                       "مناطق بيضاء محترقة بلا تفاصيل (إضاءة زائدة)", f"{highlights:.0%} من الصورة")
        elif mean > 225:
            report.add("quality.bright", "quality", Level.REVIEW, "الصورة ساطعة جداً (تعريض زائد)", f"متوسط السطوع {mean:.0f}/255")
    if not black_bg:
        if shadows > q.shadow_clip_review:
            report.add("quality.shadows", "quality", Level.REVIEW,
                       "مناطق سوداء بلا تفاصيل (ظلام يُفقد التفاصيل)", f"{shadows:.0%} من الصورة")
        elif mean < 35:
            report.add("quality.dark", "quality", Level.REVIEW, "الصورة مظلمة جداً (تعريض ناقص)", f"متوسط السطوع {mean:.0f}/255")


def check_borders(report: FileReport, rgb_small: np.ndarray) -> None:
    """Flat bars of constant thickness on two opposite sides: an added frame or letterbox."""
    sides = {
        "top": rgb_small,
        "bottom": rgb_small[::-1],
        "left": rgb_small.transpose(1, 0, 2),
        "right": rgb_small.transpose(1, 0, 2)[::-1],
    }
    bars = {name: _bar_thickness(arr) / arr.shape[0] for name, arr in sides.items()}
    found = [n for n, share in bars.items() if share]
    if ("top" in found and "bottom" in found) or ("left" in found and "right" in found):
        names = {"top": "أعلى", "bottom": "أسفل", "left": "يسار", "right": "يمين"}
        report.add("overlay.border", "overlays", Level.REVIEW,
                   "يبدو أن حول الصورة إطاراً أو أشرطة مضافة؛ Adobe يرفض الإطارات والحدود",
                   "سماكة تقريبية: " + "، ".join(f"{names[n]} {bars[n]:.1%}" for n in found))


def _bar_thickness(arr: np.ndarray, tol: int = 12) -> int:
    """Thickness in pixels of a flat bar along the first rows of arr (H x W x 3), or 0."""
    h, w = arr.shape[:2]
    max_t = max(3, int(h * 0.12))
    strip = arr[:max_t].astype(np.int16)
    ref = np.median(strip[0], axis=0)
    diff = np.abs(strip - ref).max(axis=2)
    if (diff[0] <= tol).mean() < 0.98:
        return 0
    inside = diff <= tol
    thickness = np.where(inside.all(axis=0), max_t, inside.argmin(axis=0))
    t = int(np.median(thickness))
    if t < 2 or t >= max_t - 1:
        return 0
    if (np.abs(thickness - t) <= 1).mean() < 0.9:
        return 0
    # A real frame ends in a hard edge; a sky gradient only drifts past the tolerance.
    edge = diff[min(t + 1, max_t - 1)]
    if np.median(edge) < 3 * tol:
        return 0
    return t
