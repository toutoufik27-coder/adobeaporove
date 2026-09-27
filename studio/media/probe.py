"""Measurements of a finished video for gate 5, with ffmpeg. The parsers are pure and
tested; `measure` runs the commands.

Luminance: the video is scaled to a 3x3 grid (one tile is about 11 % of the screen, the
area the flash guidelines care about) and read as grey bytes, which are linearised with
the sRGB curve to relative luminance. It is an approximation of the Harding test, not a
certified one: for a broadcaster's certificate, run the real tool on the final file."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from ..gates.assembly import Loudness, Measures
from .mix import loudnorm_measure_argv, parse_loudnorm

GRID = 3


def srgb_to_linear(v: float) -> float:
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def tiles_argv(video: Path, fps: int) -> list[str]:
    return ["ffmpeg", "-v", "error", "-i", str(video), "-vf",
            f"fps={fps},scale={GRID}:{GRID}:flags=area,format=gray", "-f", "rawvideo", "-"]


def parse_tiles(raw: bytes) -> list[list[float]]:
    n = GRID * GRID
    if len(raw) % n:
        raise ValueError(f"{len(raw)} bytes is not a whole number of {GRID}x{GRID} frames")
    lut = [srgb_to_linear(i / 255) for i in range(256)]
    return [[lut[b] for b in raw[i:i + n]] for i in range(0, len(raw), n)]


def scenes_argv(video: Path, threshold: float = 0.3) -> list[str]:
    return ["ffmpeg", "-hide_banner", "-nostats", "-i", str(video), "-vf",
            f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"]


def parse_scenes(stderr: str) -> list[float]:
    return [float(t) for t in re.findall(r"\bpts_time:\s*([0-9.]+)", stderr)]


def duration_argv(path: Path) -> list[str]:
    return ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]


def _run(argv: list[str]) -> subprocess.CompletedProcess:
    p = subprocess.run(argv, capture_output=True)
    if p.returncode:
        raise RuntimeError(f"{argv[0]} failed ({p.returncode}): {p.stderr.decode(errors='replace')[-2000:]}")
    return p


def measure(video: Path, tracks: dict[str, Path], transcripts: dict[str, str], fps: int = 24) -> Measures:
    """Everything gate 5 needs; transcripts come from Whisper (voice/whisper step)."""
    tiles = parse_tiles(_run(tiles_argv(video, fps)).stdout)
    cuts = parse_scenes(_run(scenes_argv(video)).stderr.decode(errors="replace"))
    duration = float(_run(duration_argv(video)).stdout.decode().strip())
    loud = {}
    for lang, wav in tracks.items():
        m = parse_loudnorm(_run(loudnorm_measure_argv(wav)).stderr.decode(errors="replace"))
        loud[lang] = Loudness(m["input_i"], m["input_tp"], m["input_lra"])
    return Measures(fps=fps, duration_s=duration, tiles=tiles, cuts=cuts, loudness=loud, transcripts=transcripts)
