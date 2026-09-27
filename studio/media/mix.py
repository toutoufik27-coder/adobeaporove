"""ffmpeg commands for the sound and the final picture. Only argv lists are built here
(tested without ffmpeg); media/run.py executes them.

One change from the plan's mix_audio.py: loudnorm is not applied per shot. Normalising
every shot to -14 LUFS makes a quiet shot as loud as a busy one and pumps the music from
shot to shot. Shots are mixed at their natural level, joined, and the whole episode is
normalised once in two passes (measure, then a linear gain), which keeps the relative
levels the mix intended."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

RATE = 48000
TARGET = {"I": -14.0, "TP": -1.5, "LRA": 11.0}
ISO639_2 = {"en": "eng", "es": "spa", "pt": "por", "fr": "fra", "de": "deu", "hi": "hin",
            "ru": "rus", "ar": "ara", "id": "ind", "ms": "msa"}


@dataclass(frozen=True)
class Clip:
    path: Path
    start: float          # seconds in the shot
    tempo: float = 1.0    # rung 3 of the dub ladder: faster, same pitch
    gain_db: float = 0.0


def _place(i: int, c: Clip, label: str) -> str:
    chain = [f"aformat=sample_rates={RATE}:channel_layouts=stereo"]
    if abs(c.tempo - 1) > 1e-6:
        if not 0.5 <= c.tempo <= 2:
            raise ValueError(f"atempo {c.tempo} out of range")
        chain.append(f"atempo={c.tempo:.3f}")
    if c.gain_db:
        chain.append(f"volume={c.gain_db:g}dB")
    chain.append(f"adelay=delays={round(c.start * 1000)}:all=1")
    return f"[{i}:a]{','.join(chain)}[{label}]"


def shot_mix_argv(voices: list[Clip], out: Path, duration: float, music: Path | None = None,
                  music_db: float = -18.0, sfx: list[Clip] = ()) -> list[str]:
    """Voices at their times, effects, and music that ducks under speech (sidechain)."""
    if not voices and music is None and not sfx:
        raise ValueError("a shot needs at least one sound")
    inputs, graph, finals = [], [], []
    for i, c in enumerate(voices):
        inputs += ["-i", str(c.path)]
        graph.append(_place(i, c, f"v{i}"))
    n = len(voices)
    if n:
        joined = "".join(f"[v{i}]" for i in range(n))
        speech = f"{joined}amix=inputs={n}:normalize=0:duration=longest" if n > 1 else f"{joined}anull"
        if music is not None:
            graph.append(f"{speech},asplit=2[speech][key]")
        else:
            graph.append(f"{speech}[speech]")
        finals.append("[speech]")
    for j, c in enumerate(sfx):
        inputs += ["-i", str(c.path)]
        graph.append(_place(n + j, c, f"s{j}"))
        finals.append(f"[s{j}]")
    if music is not None:
        m = n + len(sfx)
        inputs += ["-stream_loop", "-1", "-i", str(music)]
        graph.append(f"[{m}:a]aformat=sample_rates={RATE}:channel_layouts=stereo,volume={music_db:g}dB,"
                     f"atrim=0:{duration:.3f}[bed]")
        if n:
            graph.append("[bed][key]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[music]")
            finals.append("[music]")
        else:
            finals.append("[bed]")
    mix = f"{''.join(finals)}amix=inputs={len(finals)}:normalize=0:duration=longest" if len(finals) > 1 else f"{finals[0]}anull"
    graph.append(f"{mix},apad,atrim=0:{duration:.3f}[out]")
    return ["ffmpeg", "-hide_banner", "-y", *inputs, "-filter_complex", ";".join(graph),
            "-map", "[out]", "-ar", str(RATE), "-c:a", "pcm_s16le", str(out)]


def concat_argv(list_file: Path, out: Path) -> list[str]:
    return ["ffmpeg", "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(out)]


def concat_list(paths: list[Path]) -> str:
    return "".join("file '" + str(p).replace("'", "'\\''") + "'\n" for p in paths)


def loudnorm_measure_argv(audio: Path) -> list[str]:
    t = TARGET
    return ["ffmpeg", "-hide_banner", "-nostats", "-i", str(audio), "-af",
            f"loudnorm=I={t['I']}:TP={t['TP']}:LRA={t['LRA']}:print_format=json", "-f", "null", "-"]


def parse_loudnorm(stderr: str) -> dict[str, float]:
    """The JSON block loudnorm prints at the end of its run."""
    blocks = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not blocks:
        raise ValueError("no loudnorm measurement in the ffmpeg output")
    data = json.loads(blocks[-1])
    return {k: float(v) for k, v in data.items() if k != "normalization_type"}


def loudnorm_apply_argv(audio: Path, out: Path, measured: dict[str, float]) -> list[str]:
    t, m = TARGET, measured
    af = (f"loudnorm=I={t['I']}:TP={t['TP']}:LRA={t['LRA']}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
          f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}"
          f":linear=true:print_format=json")
    return ["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(audio), "-af", af, "-ar", str(RATE), "-c:a", "pcm_s16le", str(out)]


def compose_argv(body: Path, mouth: Path, out: Path, fps: int = 24) -> list[str]:
    """The body (with background) once, the language's mouth layer over it."""
    return ["ffmpeg", "-hide_banner", "-y", "-i", str(body), "-i", str(mouth), "-filter_complex",
            "[0:v][1:v]overlay=format=auto,format=yuv420p[v]", "-map", "[v]", "-r", str(fps),
            "-c:v", "libx264", "-crf", "18", "-preset", "slow", str(out)]


def mux_argv(video: Path, tracks: dict[str, Path], out: Path, subtitles: dict[str, Path] | None = None) -> list[str]:
    """One picture, one audio track per language (the first is the default), optional subtitles."""
    subtitles = subtitles or {}
    argv = ["ffmpeg", "-hide_banner", "-y", "-i", str(video)]
    for p in tracks.values():
        argv += ["-i", str(p)]
    for p in subtitles.values():
        argv += ["-i", str(p)]
    argv += ["-map", "0:v"]
    for k in range(len(tracks)):
        argv += ["-map", f"{k + 1}:a"]
    for k in range(len(subtitles)):
        argv += ["-map", f"{len(tracks) + k + 1}:s"]
    argv += ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text"]
    for k, lang in enumerate(tracks):
        argv += [f"-metadata:s:a:{k}", f"language={ISO639_2.get(lang, lang)}",
                 f"-disposition:a:{k}", "default" if k == 0 else "0"]
    for k, lang in enumerate(subtitles):
        argv += [f"-metadata:s:s:{k}", f"language={ISO639_2.get(lang, lang)}"]
    return argv + ["-movflags", "+faststart", str(out)]
