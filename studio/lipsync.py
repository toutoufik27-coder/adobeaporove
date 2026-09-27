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
import struct
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


def wav_info(path: Path) -> tuple[int, int, int, bytes]:
    """(sample rate, bytes per sample, channels, PCM bytes) of an integer-PCM wav, the plain
    header and WAVE_FORMAT_EXTENSIBLE alike: ffmpeg writes 24-bit files with the latter,
    which Python's wave module reads only from 3.12 on."""
    data = Path(path).read_bytes()
    if data[:4] not in (b"RIFF", b"RF64") or data[8:12] != b"WAVE":
        raise ValueError(f"{path}: not a wav file")
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], int.from_bytes(data[pos + 4:pos + 8], "little")
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            tag, ch, sr = struct.unpack_from("<HHI", body)
            bits = struct.unpack_from("<H", body, 14)[0]
            if tag == 0xFFFE and len(body) >= 26:  # extensible: the real format is the SubFormat GUID
                tag = struct.unpack_from("<H", body, 24)[0]
            fmt = (tag, ch, sr, bits)
        elif cid == b"data":
            pcm = data[pos + 8:] if size in (0, 0xFFFFFFFF) or pos + 8 + size > len(data) else body
            break
        pos += 8 + size + (size & 1)
    if not fmt or pcm is None:
        raise ValueError(f"{path}: no fmt or data chunk")
    tag, ch, sr, bits = fmt
    if tag != 1:
        raise ValueError(f"{path}: not integer PCM (format {tag})")
    return sr, bits // 8, ch, pcm


def wav_seconds(path: Path) -> float:
    sr, width, ch, pcm = wav_info(path)
    return len(pcm) / (width * ch * sr)


def read_pcm(path: Path) -> tuple[list[float], int]:
    """Mono samples in -1..1 of a 16, 24 or 32-bit PCM wav (first channel), and the rate."""
    sr, width, ch, raw = wav_info(path)
    if width == 2:
        data = array.array("h", raw[: len(raw) - len(raw) % 2])
        return [v / 32768 for v in data[::ch]], sr
    if width not in (3, 4):
        raise ValueError(f"{path}: {8 * width}-bit PCM is not supported")
    full = float(1 << (8 * width - 1))
    step = width * ch
    return [int.from_bytes(raw[i:i + width], "little", signed=True) / full for i in range(0, len(raw) - step + 1, step)], sr


def rms_per_frame(path: Path, fps: int) -> list[float]:
    """Loudness (RMS, 0..1) of a PCM wav for every video frame (16, 24 or 32-bit)."""
    data, sr = read_pcm(path)
    step = sr / fps
    out = []
    for k in range(math.ceil(len(data) / step)):
        chunk = data[round(k * step):round((k + 1) * step)]
        out.append(math.sqrt(sum(s * s for s in chunk) / len(chunk)) if chunk else 0.0)
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
