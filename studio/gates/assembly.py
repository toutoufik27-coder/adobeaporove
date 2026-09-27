"""Gate 5: the finished video, per language, measured and not looked at.

- Flashes (photosensitive epilepsy; ITU-R BT.1702 / WCAG 2.3.1): a flash is a pair of
  opposing changes of at least 0.1 in relative luminance where the darker state is below
  0.8; more than three flashes in any one second fail. Measured per tile of a 3x3 grid,
  because a flash in a corner is as dangerous as a full-frame one and a frame average
  would dilute it.
- Loudness (YouTube normalises to about -14 LUFS): integrated -14 ± 1, true peak <= -1 dBTP.
- Cut pace for ages 3-6: shots of 3 s on average, none under 1 s.
- Words: what Whisper hears against the script, word error rate <= 0.15.
- Length: within 15 % of the format.
The measurements come from media/probe.py (ffmpeg); the gate itself is pure and tested."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..bible.models import Bible
from ..episode import Episode
from ..text import word_error_rate
from . import GateReport

FLASH_DELTA = 0.1
FLASH_DARK = 0.8
MAX_FLASHES_PER_S = 3
TARGET_LUFS, LUFS_TOL, MAX_TP = -14.0, 1.0, -1.0
MIN_AVG_SHOT, MIN_SHOT = 3.0, 1.0
MAX_WER = 0.15
LENGTH_TOL = 0.15


@dataclass(frozen=True)
class Loudness:
    i: float    # integrated, LUFS
    tp: float   # true peak, dBTP
    lra: float  # loudness range, LU


@dataclass
class Measures:
    fps: float
    duration_s: float
    tiles: list[list[float]] = field(default_factory=list)  # per frame, relative luminance of each tile
    cuts: list[float] = field(default_factory=list)  # shot boundaries, seconds
    loudness: dict[str, Loudness] = field(default_factory=dict)  # language -> track loudness
    transcripts: dict[str, str] = field(default_factory=dict)  # language -> what Whisper heard


def transitions(signal: list[float], delta: float = FLASH_DELTA) -> list[tuple[int, float]]:
    """Frames where the luminance turned by at least delta, with the darker level of the
    change. Small wiggles inside delta never count (hysteresis)."""
    out: list[tuple[int, float]] = []
    if not signal:
        return out
    direction, lo, hi, ext = 0, signal[0], signal[0], signal[0]
    for i, v in enumerate(signal):
        if direction == 0:
            lo, hi = min(lo, v), max(hi, v)
            if v - lo >= delta:
                out.append((i, lo))
                direction, ext = 1, v
            elif hi - v >= delta:
                out.append((i, v))
                direction, ext = -1, v
        elif direction == 1:  # rising: ext is the highest level since the turn
            if v > ext:
                ext = v
            elif ext - v >= delta:
                out.append((i, v))
                direction, ext = -1, v
        else:  # falling: ext is the lowest level since the turn
            if v < ext:
                ext = v
            elif v - ext >= delta:
                out.append((i, ext))
                direction, ext = 1, v
    return out


def worst_flash_second(signal: list[float], fps: float) -> tuple[float, float]:
    """(most flashes in any one-second window, start of that window in seconds)."""
    t = [i for i, dark in transitions(signal) if dark < FLASH_DARK]
    best, at, j = 0, 0.0, 0
    window = max(1, round(fps))
    for k in range(len(t)):
        while t[k] - t[j] >= window:
            j += 1
        if k - j + 1 > best:
            best, at = k - j + 1, t[j] / fps
    return best / 2, at


def check_assembly(bible: Bible, ep: Episode, m: Measures, lang: str | None = None) -> GateReport:
    lang = lang or ep.language
    r = GateReport(f"gate5:{lang}")

    if m.tiles:
        n_tiles = len(m.tiles[0])
        for k in range(n_tiles):
            flashes, at = worst_flash_second([f[k] for f in m.tiles], m.fps)
            if flashes > MAX_FLASHES_PER_S:
                r.error("flash", f"{flashes:g} flashes in one second at {at:.2f}s (tile {k}); max {MAX_FLASHES_PER_S}")
    else:
        r.error("flash.unmeasured", "no luminance measured: the flash test cannot pass without it")

    loud = m.loudness.get(lang)
    if loud is None:
        r.error("loudness.unmeasured", f"no loudness measured for the {lang} track")
    else:
        if abs(loud.i - TARGET_LUFS) > LUFS_TOL:
            r.error("loudness.integrated", f"{loud.i:.1f} LUFS, want {TARGET_LUFS:g} ± {LUFS_TOL:g}")
        if loud.tp > MAX_TP:
            r.error("loudness.peak", f"true peak {loud.tp:.1f} dBTP, max {MAX_TP:g}")
        if loud.lra > 11:
            r.warn("loudness.range", f"loudness range {loud.lra:.1f} LU: quiet lines may be lost on a phone speaker")

    bounds = [0.0] + sorted(c for c in m.cuts if 0 < c < m.duration_s) + [m.duration_s]
    shots = [b - a for a, b in zip(bounds, bounds[1:])]
    if shots:
        avg = sum(shots) / len(shots)
        if avg < MIN_AVG_SHOT:
            r.error("pace.average", f"shots last {avg:.1f}s on average; ages 3-6 need >= {MIN_AVG_SHOT:g}s")
        short = [(a, b - a) for a, b in zip(bounds, bounds[1:]) if b - a < MIN_SHOT]
        for start, length in short[:5]:
            r.error("pace.short_shot", f"a {length:.2f}s shot at {start:.2f}s (min {MIN_SHOT:g}s)")
        if len(short) > 5:
            r.error("pace.short_shot", f"and {len(short) - 5} more shots under {MIN_SHOT:g}s")

    heard = m.transcripts.get(lang)
    if heard is None:
        r.error("words.unmeasured", f"no {lang} transcript: the spoken words cannot be checked")
    else:
        wer = word_error_rate(ep.text(lang), heard)
        if wer > MAX_WER:
            r.error("words.wer", f"word error rate {wer:.0%} (max {MAX_WER:.0%}): the voice says something other than the script")

    fmt = bible.formats.get(ep.format)
    if fmt and abs(m.duration_s - fmt.duration_s) > LENGTH_TOL * fmt.duration_s:
        r.warn("length", f"{m.duration_s:.0f}s for a {fmt.duration_s}s format")
    return r
