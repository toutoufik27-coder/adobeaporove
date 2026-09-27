"""Audio first: the voice is generated and measured, then every shot is timed from its
lines. The body is rendered once on the primary language's timing; each dub is fitted
to it by the four-rung ladder of the training lab:

  1. the translation is written within ±15 % of the original (gate 1) and fits as is;
  2. a longer line eats the 0.4 s of silence reserved after every line;
  3. still too long: speed the audio up by at most 8 %, pitch unchanged (atempo);
  4. still too long: re-render the body of that one shot on the dub's timing.

Times inside a shot are relative to the shot; shots follow each other."""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field, replace

from .episode import Episode

GAP_S = 0.4        # silence after every line: the dub reserve (rung 2)
LEAD_IN_S = 0.6    # a breath before the first line of a shot
TAIL_S = 0.8       # and after the last one, for the reaction
MAX_TEMPO = 1.08   # rung 3
MAX_SHOT_S = 8.0   # a shot is cut at a line boundary once it would run longer


@dataclass(frozen=True)
class LineTime:
    line_id: str
    speaker: str
    start: float      # seconds from the shot start
    length: float     # audio length, seconds
    tempo: float = 1.0
    hold: float = 0.0  # wordless action after the line

    @property
    def end(self) -> float:
        return self.start + self.length / self.tempo


@dataclass(frozen=True)
class Shot:
    id: str
    beat: int
    segment: str
    place: str
    lighting: str
    lines: tuple[LineTime, ...]
    duration: float
    start: float = 0.0  # seconds from the episode start

    @property
    def speakers(self) -> list[str]:
        return list(dict.fromkeys(l.speaker for l in self.lines))


@dataclass
class Timeline:
    episode: str
    language: str
    fps: int
    shots: list[Shot]
    rerender: list[str] = field(default_factory=list)  # shots whose body follows this language

    @property
    def duration(self) -> float:
        return sum(s.duration for s in self.shots)

    def frame(self, t: float) -> int:
        return round(t * self.fps)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def _layout(lengths: list[tuple[str, str, float, float]]) -> tuple[tuple[LineTime, ...], float]:
    """(line id, speaker, audio length, hold after it) -> line times and the shot length."""
    t, out, hold = LEAD_IN_S, [], 0.0
    for lid, speaker, length, hold in lengths:
        out.append(LineTime(lid, speaker, round(t, 3), length, hold=hold))
        t += length + GAP_S + hold
    return tuple(out), round(t - GAP_S - hold + max(TAIL_S, hold), 3)


def build_timeline(ep: Episode, lengths: dict[str, float], fps: int = 24) -> Timeline:
    """The primary-language timeline from the measured length of every line's audio."""
    missing = [l.id for l in ep.lines() if l.id not in lengths]
    if missing:
        raise ValueError(f"no audio length for {', '.join(missing)}: generate the voice first")
    shots: list[Shot] = []
    for bi, beat in enumerate(ep.beats):
        groups: list[list[tuple[str, str, float, float]]] = [[]]
        for line in beat.lines:
            group, length = groups[-1], lengths[line.id]
            projected = LEAD_IN_S + sum(g[2] + GAP_S + g[3] for g in group) + length + max(TAIL_S, line.hold_s)
            if group and projected > MAX_SHOT_S:
                groups.append([])
            groups[-1].append((line.id, line.speaker, length, line.hold_s))
        for group in groups:
            if group:
                lines, dur = _layout(group)
                shots.append(Shot(f"sh_{len(shots) + 1:03d}", bi, beat.segment, beat.place, beat.lighting, lines, dur))
    return Timeline(ep.id, ep.language, fps, _starts(shots))


def _starts(shots: list[Shot]) -> list[Shot]:
    t, out = 0.0, []
    for s in shots:
        out.append(replace(s, start=round(t, 3)))
        t += s.duration
    return out


@dataclass(frozen=True)
class Fit:
    line_id: str
    rung: int          # 1 fits, 2 uses the gap, 3 tempo, 4 re-render the shot
    tempo: float
    over_s: float      # how much longer than the original line


def fit_line(original: float, dub: float) -> Fit:
    if dub <= original:
        return Fit("", 1, 1.0, 0.0)
    over = dub - original
    room = original + GAP_S
    if dub <= room:
        return Fit("", 2, 1.0, over)
    tempo = dub / room
    if tempo <= MAX_TEMPO:
        return Fit("", 3, math.ceil(tempo * 1000 - 1e-9) / 1000, over)  # rounded up: never overrun the room
    return Fit("", 4, 1.0, over)


def fit_dub(tl: Timeline, language: str, lengths: dict[str, float]) -> tuple[Timeline, list[Fit]]:
    """The dub's timeline: the primary shots kept where the ladder fits every line, shots
    re-laid on the dub's lengths (rung 4) where it does not."""
    fits: list[Fit] = []
    shots: list[Shot] = []
    rerender: list[str] = []
    for s in tl.shots:
        shot_fits = []
        for lt in s.lines:
            if lt.line_id not in lengths:
                raise ValueError(f"no {language} audio length for {lt.line_id}")
            shot_fits.append(replace(fit_line(lt.length, lengths[lt.line_id]), line_id=lt.line_id))
        fits += shot_fits
        if any(f.rung == 4 for f in shot_fits):
            lines, dur = _layout([(lt.line_id, lt.speaker, lengths[lt.line_id], lt.hold) for lt in s.lines])
            shots.append(replace(s, lines=lines, duration=dur))
            rerender.append(s.id)
        else:
            lines = tuple(replace(lt, length=lengths[lt.line_id], tempo=f.tempo) for lt, f in zip(s.lines, shot_fits))
            shots.append(replace(s, lines=lines))
    return Timeline(tl.episode, language, tl.fps, _starts(shots), rerender), fits
