"""Near-duplicates and series of similar shots within one batch (perceptual hash, mirror-aware)."""

from __future__ import annotations

import numpy as np
from PIL import Image

from ..config import Config
from ..findings import FileReport, Level

_N = 32


def _dct_matrix(n: int) -> np.ndarray:
    k = np.arange(n)[:, None]
    i = np.arange(n)[None, :]
    m = np.cos(np.pi * (2 * i + 1) * k / (2 * n)) * np.sqrt(2 / n)
    m[0] /= np.sqrt(2)
    return m


_DCT = _dct_matrix(_N)


def phash(img: Image.Image) -> tuple[int, int]:
    """64-bit perceptual hash of the image and of its mirror image."""
    small = np.asarray(img.convert("L").resize((_N, _N), Image.Resampling.LANCZOS), dtype=np.float64)

    def bits(a: np.ndarray) -> int:
        low = (_DCT @ a @ _DCT.T)[:8, :8]
        flat = (low > np.median(low)).ravel()
        return int("".join("1" if b else "0" for b in flat), 2)

    return bits(small), bits(small[:, ::-1])


def distance(a: FileReport, b: FileReport) -> int:
    assert a.phash is not None and b.phash is not None and b.phash_mirror is not None
    return min(bin(a.phash ^ b.phash).count("1"), bin(a.phash ^ b.phash_mirror).count("1"))


def _rank(r: FileReport) -> tuple:
    # Keep the file most likely to be accepted: fewest problems, then sharpest, then largest.
    worst = max((f.level for f in r.findings), default=Level.INFO)
    return (int(worst), -r.metrics.get("sharpness", 0.0), -r.megapixels, r.name)


def _close_pairs(items: list[FileReport], limit: int) -> list[tuple[int, int, int]]:
    """(i, j, distance) for every pair within limit, vectorized in blocks so 10,000 files stay fast."""
    hashes = np.array([r.phash for r in items], dtype=np.uint64)
    mirrors = np.array([r.phash_mirror for r in items], dtype=np.uint64)
    pairs = []
    for start in range(0, len(items), 1024):
        block = hashes[start : start + 1024, None]
        d = np.minimum(np.bitwise_count(block ^ hashes[None, :]), np.bitwise_count(block ^ mirrors[None, :]))
        for i, j in zip(*np.nonzero(d <= limit), strict=True):
            if j > i + start:
                pairs.append((int(i + start), int(j), int(d[i, j])))
    return pairs


def check_similarity(reports: list[FileReport], config: Config) -> None:
    sim = config.similarity
    items = [r for r in reports if r.phash is not None and r.phash_mirror is not None]
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    near: dict[int, set[int]] = {i: set() for i in range(len(items))}
    for i, j, d in _close_pairs(items, max(sim.similar_distance, sim.near_duplicate_distance)):
        if d <= sim.similar_distance:
            parent[find(i)] = find(j)
        if d <= sim.near_duplicate_distance:
            near[i].add(j)
            near[j].add(i)

    groups: dict[int, list[int]] = {}
    for i in range(len(items)):
        groups.setdefault(find(i), []).append(i)

    for members in groups.values():
        if len(members) < 2:
            continue
        ordered = sorted(members, key=lambda i: _rank(items[i]))
        kept: list[int] = []
        for i in ordered:
            twin = next((k for k in kept if k in near[i]), None)
            if twin is not None:
                items[i].add("similar.duplicate", "similar", Level.REVIEW,
                             "نسخة شبه مطابقة لصورة أخرى في الدفعة؛ أرسل واحدة فقط",
                             f"تشبه {items[twin].name}")
            elif len(kept) >= sim.max_similar:
                items[i].add("similar.series", "similar", Level.REVIEW,
                             f"جزء من مجموعة من {len(members)} صور متشابهة، والأفضل ألا تتجاوز {sim.max_similar}",
                             "المختارة: " + "، ".join(items[k].name for k in kept))
            else:
                kept.append(i)
