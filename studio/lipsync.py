"""Mouths from Rhubarb Lip Sync, per line and per language. Rhubarb writes a TSV of
(time, shape) cues; this module cleans it the way the training lab asks and turns it into
frame keys for the mouth layer:

- a shape shorter than two frames is merged into its neighbour (the mouth does not flicker);
- every silence longer than 0.2 s is the closed rest mouth X;
- keys are offset by the line's start in the shot.

It also reads the loudness of the line every frame, which gives the head its emphasis:
a small turn (±2°) on the loudest syllables, so a character seems to stress its words."""
from __future__ import annotations

import array
import math
import wave
from dataclasses import dataclass
from pathlib import Path

SHAPES = "ABCDEFGHX"
MIN_FRAMES = 2
SILENCE_S = 0.2
SILENCE_DB = -35.0   # below the line's peak
HEAD_DEG = 2.0


@dataclass(frozen=True)
class Cue:
    t: float
    shape: str


def rhubarb_argv(wav: Path, out: Path, lang: str, dialog: Path | None = None) -> list[str]:
    """English uses the dialog text for accuracy; other languages the phonetic recogniser."""
    argv = ["rhubarb", "-f", "tsv", "--extendedShapes", "GHX"]
    if lang == "en":
        if dialog:
            argv += ["-d", str(dialog)]
    else:
        argv += ["-r", "phonetic"]
    return argv + [str(wav), "-o", str(out)]


def parse_tsv(text: str) -> list[Cue]:
    cues = []
    for n, row in enumerate(text.splitlines(), 1):
        if not row.strip():
            continue
        try:
            t, shape = row.split("\t")
            cue = Cue(float(t), shape.strip())
        except ValueError as e:
            raise ValueError(f"rhubarb tsv line {n}: {row!r}") from e
        if cue.shape not in SHAPES:
            raise ValueError(f"rhubarb tsv line {n}: unknown mouth shape {cue.shape!r}")
        if cues and cue.t < cues[-1].t:
            raise ValueError(f"rhubarb tsv line {n}: time goes backwards")
        cues.append(cue)
    return cues


def rms_per_frame(path: Path, fps: int) -> list[float]:
    """Loudness (RMS, 0..1) of a 16-bit PCM wav for every video frame."""
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"{path}: 16-bit PCM expected")
        ch, sr = w.getnchannels(), w.getframerate()
        data = array.array("h", w.readframes(w.getnframes()))
    if ch > 1:
        data = array.array("h", data[::ch])
    step = sr / fps
    out = []
    for k in range(math.ceil(len(data) / step)):
        chunk = data[round(k * step):round((k + 1) * step)]
        out.append(math.sqrt(sum(s * s for s in chunk) / len(chunk)) / 32768 if chunk else 0.0)
    return out


def silences(rms: list[float], fps: int, min_s: float = SILENCE_S, floor_db: float = SILENCE_DB) -> list[tuple[float, float]]:
    """Stretches quieter than floor_db under the line's peak, at least min_s long."""
    peak = max(rms, default=0.0)
    if peak <= 0:
        return [(0.0, len(rms) / fps)] if rms else []
    limit = peak * 10 ** (floor_db / 20)
    out, start = [], None
    for i, v in enumerate(rms + [peak]):  # the sentinel closes a trailing silence
        if v < limit and start is None:
            start = i
        elif v >= limit and start is not None:
            if (i - start) / fps >= min_s:
                out.append((start / fps, min(i, len(rms)) / fps))
            start = None
    return out


def clean(cues: list[Cue], fps: int, quiet: list[tuple[float, float]] = ()) -> list[Cue]:
    """X over every silence, then no shape shorter than MIN_FRAMES, then no repeats.
    The last cue marks the end of the line and is kept."""
    if not cues:
        return []
    end = cues[-1]
    body = list(cues[:-1])
    for a, b in quiet:
        shape_at_b = next((c.shape for c in reversed(body) if c.t <= b), "X")
        body = [c for c in body if not a <= c.t < b]
        body.append(Cue(a, "X"))
        if b < end.t:
            body.append(Cue(b, shape_at_b))
    body.sort(key=lambda c: c.t)
    min_len = MIN_FRAMES / fps - 1e-9
    changed = True
    while changed and len(body) > 1:
        changed = False
        times = [c.t for c in body[1:]] + [end.t]
        for i, (c, t_next) in enumerate(zip(body, times)):
            if t_next - c.t < min_len:
                if i == 0:  # the first shape gives its time to the next
                    body[1] = Cue(c.t, body[1].shape)
                del body[i]
                changed = True
                break
    out: list[Cue] = []
    for c in body:
        if not out or out[-1].shape != c.shape:
            out.append(c)
    return out + [Cue(end.t, "X")]


def keys(cues: list[Cue], fps: int, offset_s: float) -> list[tuple[int, str]]:
    """(frame in the shot, shape) keys for the mouth layer; one key per frame at most."""
    out: dict[int, str] = {}
    for c in cues:
        out[round((offset_s + c.t) * fps)] = c.shape
    return sorted(out.items())


def emphasis(rms: list[float], fps: int, offset_s: float, spacing_s: float = 0.35) -> list[tuple[int, float]]:
    """Head keys: a ±2° turn on loud peaks (alternating sides), back to 0 four frames later."""
    if len(rms) < 3:
        return []
    mean = sum(rms) / len(rms)
    sd = math.sqrt(sum((v - mean) ** 2 for v in rms) / len(rms))
    limit = mean + 0.8 * sd
    peaks, last = [], -10**9
    for i in range(1, len(rms) - 1):
        if rms[i] >= limit and rms[i] >= rms[i - 1] and rms[i] > rms[i + 1] and i - last >= spacing_s * fps:
            peaks.append(i)
            last = i
    base = round(offset_s * fps)
    out = []
    for n, i in enumerate(peaks):
        out.append((base + i, HEAD_DEG if n % 2 == 0 else -HEAD_DEG))
        out.append((base + i + 4, 0.0))
    return out
