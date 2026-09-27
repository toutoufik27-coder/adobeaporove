"""Load the bible from bible/ and check the rules that span files (the "design law")."""
from __future__ import annotations

import itertools
import json
import re
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from ..colors import delta_e
from ..paths import project_root
from .models import Bible, Character, Culture, Curriculum, Format, Lexicon, World


CAPACITY_EPISODES = 60  # three months at the plan's 20 a month


class BibleError(Exception):
    """A bible file that cannot be read or does not match its model."""


@dataclass(frozen=True)
class Finding:
    level: str  # "error" | "warning"
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.level.upper():7} {self.code}: {self.message}"


def _read(path: Path, model):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise BibleError(f"{path}: {e}") from e
    try:
        return model.model_validate(data)
    except ValidationError as e:
        raise BibleError(f"{path}:\n{e}") from e


def load_bible(root: Path | None = None) -> Bible:
    b = (root or project_root()) / "bible"
    characters: dict[str, Character] = {}
    for p in sorted((b / "characters").glob("*.json")):
        c = _read(p, Character)
        if c.id != p.stem:
            raise BibleError(f"{p}: id {c.id!r} does not match the file name")
        characters[c.id] = c
    formats = {}
    for p in sorted((b / "formats").glob("*.json")):
        f = _read(p, Format)
        if f.id != p.stem:
            raise BibleError(f"{p}: id {f.id!r} does not match the file name")
        formats[f.id] = f
    lexicons = {}
    for p in sorted((b / "lexicon").glob("*.json")):
        lx = _read(p, Lexicon)
        lexicons[lx.language] = lx
    cultures = {}
    for p in sorted((b / "culture").glob("*.json")):
        cu = _read(p, Culture)
        cultures[cu.market] = cu
    return Bible(
        characters=characters,
        world=_read(b / "world.json", World),
        formats=formats,
        curriculum=_read(b / "curriculum.json", Curriculum),
        lexicons=lexicons,
        cultures=cultures,
    )


VOWELS = re.compile(r"[aeiouy]+", re.I)
MIN_COLOR_DE = 20.0      # two characters' colours must not be confusable
MIN_PITCH_GAP = 2.0      # semitones between two voices of the same pace


def check_bible(bible: Bible, month: int = 0) -> list[Finding]:
    """Rules that span the whole bible. `month` is the production month (0 = launch):
    what must be ready depends on which languages and formats are live."""
    out: list[Finding] = []
    err = lambda code, msg: out.append(Finding("error", code, msg))  # noqa: E731
    warn = lambda code, msg: out.append(Finding("warning", code, msg))  # noqa: E731
    w = bible.world
    chars = list(bible.characters.values())
    core = [c for c in chars if c.group == "core"]

    # names: unique, not banned, different first letters, two syllables
    names = [c.name for c in chars]
    for n in {n for n in names if names.count(n) > 1}:
        err("name.duplicate", f"{n} is used twice")
    banned = {n.lower() for n in w.banned_names}
    for c in chars:
        if c.name.lower() in banned:
            err("name.banned", f"{c.id} {c.name} is on the banned-name list")
        if len(VOWELS.findall(c.name)) != 2:
            warn("name.syllables", f"{c.name} is not two syllables")
    for c in chars:
        for lang, lx in bible.lexicons.items():
            if c.name.lower() in {x.lower() for x in lx.common_words}:
                warn("name.common_word", f"{c.name} is an everyday word in {lang}: '{c.name.lower()}' in dialogue will be ambiguous")
    for a, b in itertools.combinations(core, 2):
        if a.name[0].lower() == b.name[0].lower():
            err("name.initial", f"{a.name} and {b.name} start with the same letter")

    # silhouette, colour, default stage: no two core characters share one
    for a, b in itertools.combinations(core, 2):
        if a.visual.silhouette == b.visual.silhouette:
            err("look.silhouette", f"{a.name} and {b.name} share the silhouette {a.visual.silhouette}")
        de = delta_e(a.visual.primary_color, b.visual.primary_color)
        if de < MIN_COLOR_DE:
            err("look.color", f"{a.name} {a.visual.primary_color} and {b.name} {b.visual.primary_color} are {de:.1f} ΔE apart (< {MIN_COLOR_DE})")
        if a.lead_stage == b.lead_stage:
            err("story.stage", f"{a.name} and {b.name} both lead the {a.lead_stage} stage")

    # voices: two voices of the same pace need a clear pitch gap
    for a, b in itertools.combinations(core, 2):
        va, vb = a.voice, b.voice
        gap = abs(va.pitch_semitones - vb.pitch_semitones)
        if va.pace == vb.pace and gap < MIN_PITCH_GAP:
            err("voice.close", f"{a.name} and {b.name}: both {va.pace}, pitch {va.pitch_semitones:+g} and {vb.pitch_semitones:+g} ({gap:g} semitones < {MIN_PITCH_GAP:g})")

    # relationships point at someone who exists or is planned
    known = set(bible.characters) | set(w.planned_ids)
    for c in chars:
        for other in c.relationships:
            if other not in known:
                err("cast.relationship", f"{c.id} relates to unknown {other}")
            if other == c.id:
                err("cast.relationship", f"{c.id} relates to itself")

    # every live language: a lexicon, and each character's catchphrase
    live = w.active_languages(month)
    for lang in live:
        if lang not in bible.lexicons:
            err("lang.lexicon", f"no lexicon for live language {lang}")
        for c in chars:
            if lang not in c.personality.speech.catchphrase:
                err("lang.catchphrase", f"{c.name} has no {lang} catchphrase")
    for l in w.languages:
        if l.code not in live and l.code not in bible.lexicons:
            warn("lang.lexicon", f"no lexicon yet for {l.code} (live in month {l.month})")

    # sentence lengths within the hard cap of every live language
    for c in chars:
        hi = c.personality.speech.sentence_words[1]
        for lang in live:
            lx = bible.lexicons.get(lang)
            if lx and hi > lx.max_sentence_words:
                err("speech.length", f"{c.name} speaks up to {hi} words, {lang} cap is {lx.max_sentence_words}")

    # formats: quotas add up, one is live at launch, lessons point at real formats
    total = sum(f.quota for f in bible.formats.values())
    if abs(total - 1) > 1e-6:
        err("format.quota", f"format quotas add up to {total:.3f}, not 1")
    if not any(f.launch_month <= month for f in bible.formats.values()):
        err("format.live", f"no format is live in month {month}")
    ids = [l.id for l in bible.curriculum.lessons]
    for i in {i for i in ids if ids.count(i) > 1}:
        err("lesson.duplicate", f"lesson {i} is defined twice")
    for l in bible.curriculum.lessons:
        for f in l.formats:
            if f not in bible.formats:
                err("lesson.format", f"lesson {l.id} uses unknown format {f}")
    for f in bible.formats.values():
        if f.launch_month <= month and not any(f.id in l.formats for l in bible.curriculum.lessons):
            err("format.lessons", f"live format {f.id} has no lesson")

    # capacity: at every stage of the launch, the chooser can keep proposing ideas that
    # pass gate 0 (15 lessons for the one launch format run out at episode 16)
    if not any(f.level == "error" and f.code.startswith(("format.", "lesson.")) for f in out):
        from ..gates.idea import simulate
        for m in sorted({f.launch_month for f in bible.formats.values()}):
            try:
                simulate(bible, CAPACITY_EPISODES, lambda n, m=m: m)
            except ValueError as e:
                err("curriculum.capacity", f"with the formats live in month {m}, {e}")

    # places: the hub exists, something is ready at launch
    place_ids = {p.id for p in w.places}
    if w.hub not in place_ids:
        err("world.hub", f"hub {w.hub} is not a place")
    if not any(p.launch for p in w.places):
        err("world.launch", "no place is ready at launch")
    for lang in live:
        if lang not in w.rule_terms:
            err("world.rules", f"no world-rule terms for live language {lang}")
    return out
