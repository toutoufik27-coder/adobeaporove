"""The acting director. Claude reads the whole scene, as a director would, and writes an
acting plan for every line: on which word the gesture lands, where the eyes go, when the
face changes in the middle of a sentence, how each listener reacts, when the camera moves
in. Code then checks every choice against what the puppets can actually do, repairs what
it cannot use, and times each change to the word it belongs to, on the audio-first
timeline. Claude decides; code verifies and executes.

The puppet vocabulary below is what the rigs must be drawn with (training lab, section 4,
extended): six eye shapes, four brows, the nine mouths in three moods, three head angles,
five hand poses, and the 27 motions of the library."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .bible.models import Bible
from .episode import MOTIONS, Episode, Motion
from .gates import GateReport
from .gates.text import LANG_RATE, RATE
from .llm import LLM
from .text import syllables, words

Eyes = Literal["open", "half", "happy", "wide", "sad", "closed"]
Brows = Literal["normal", "raised", "worried", "angry_mild"]
Mood = Literal["neutral", "happy", "sad"]
Head = Literal["front", "three_quarter", "side"]
Hands = Literal["relaxed", "open", "fist", "point", "thumbs_up"]
Camera = Literal["hold", "push_in", "pull_out", "close_up", "wide"]
DIRECTIONS = ("camera", "up", "down", "left", "right")

# a feeling and the eyes that contradict it: a sad line with laughing eyes reads as mockery
CLASH = {"sad": {"happy"}, "sorry": {"happy"}, "worried": {"happy"}, "scared_mild": {"happy", "closed"},
         "happy": {"sad"}, "excited": {"sad", "half"}, "proud": {"sad"}}

GESTURE_LEAD_FRAMES = 4   # the hand leads the voice
REACTION_DELAY_S = 0.25   # a listener reacts after hearing the word
MAX_BEATS_PER_WORD = 1 / 3


# ---------------------------------------------------------------- what Claude returns
class Beat(BaseModel):
    word: int = Field(description="index of the word (0-based, as numbered in the script) where this change lands")
    action: Motion | None = Field(None, description="a motion from the library, or null to keep the body")
    eyes: Eyes | None = None
    brows: Brows | None = None
    mouth: Mood | None = Field(None, description="the mood of the mouth shapes from this word on")
    head: Head | None = None
    hands: Hands | None = None
    look: str | None = Field(None, description="a character id in the scene, or camera/up/down/left/right")


class Reaction(BaseModel):
    character: str = Field(description="a listener in the scene (character id), never the speaker")
    word: int = Field(description="the speaker's word that triggers the reaction")
    action: Motion | None = None
    eyes: Eyes | None = None
    brows: Brows | None = None
    look: str | None = None


class LineActing(BaseModel):
    line_id: str
    beats: list[Beat] = Field(default_factory=list, description="1-3 changes; the first on the stressed word")
    listeners: list[Reaction] = Field(default_factory=list)
    camera: Camera = "hold"
    hold_action: Motion | None = Field(None, description="what the speaker does during the wordless hold after the line")


class ActingPlan(BaseModel):
    lines: list[LineActing]


# ---------------------------------------------------------------- the brief
def _numbered(text: str) -> str:
    return " ".join(f"{i}:{w}" for i, w in enumerate(words(text)))


def director_system(bible: Bible, ep: Episode) -> str:
    chars = []
    for cid in ep.cast:
        c = bible.characters[cid]
        chars.append(f"- {cid} {c.name}: {', '.join(c.personality.traits)}; moves "
                     f"{'fast and bouncy' if c.motion_style.speed > 1.1 else 'slow and calm' if c.motion_style.speed < 0.9 else 'normally'}; "
                     f"never: {'; '.join(c.personality.never_does)}")
    return (
        "You are the acting director of Kiko & Friends, a cut-out puppet cartoon for children aged 3-6. "
        "For every line, plan the performance like a good animation director:\n"
        "- the main gesture lands on the stressed word, not on the first word;\n"
        "- the face can change inside a line when the thought changes (a smile turning into worry);\n"
        "- the speaker looks at whoever they talk to; a question to the audience looks at the camera;\n"
        "- listeners react to what they hear (surprise, a laugh, worry, a nod), each in character;\n"
        "- vary: the same speaker does not repeat the same gesture on consecutive lines;\n"
        "- fewer, clearer changes beat many small ones: at most 3 beats on a line;\n"
        "- push in (or close-up) only on the emotional turn of the episode, once or twice;\n"
        "- small children copy what they see: nothing rough, nothing unsafe.\n\n"
        "Characters in the scene:\n" + "\n".join(chars) + "\n\n"
        f"Motions: {', '.join(MOTIONS)}.\nEyes: open, half, happy, wide, sad, closed. Brows: normal, raised, worried, "
        "angry_mild. Mouth mood: neutral, happy, sad. Head: front, three_quarter, side. Hands: relaxed, open, fist, "
        "point, thumbs_up. Look: a character id or camera/up/down/left/right. Camera: hold, push_in, pull_out, close_up, wide."
    )


def director_prompt(bible: Bible, ep: Episode) -> str:
    names = {c.id: c.name for c in bible.characters.values()}
    rows = []
    for b in ep.beats:
        rows.append(f"[{b.segment} · {b.place}]")
        for l in b.lines:
            hold = f" [then {l.hold_s:g}s without words]" if l.hold_s else ""
            rows.append(f"{l.id} {names.get(l.speaker, l.speaker)} ({l.speaker}) [{l.emotion}]: {_numbered(l.text)}{hold}")
    return ("Plan the acting of this scene. Words are numbered; use those numbers. One entry per line id.\n\n"
            + "\n".join(rows))


# ---------------------------------------------------------------- checking and repairing
def _look_ok(look: str | None, cast: list[str], me: str) -> bool:
    return look is None or look in DIRECTIONS or (look in cast and look != me)


def check_acting(bible: Bible, ep: Episode, plan: ActingPlan) -> GateReport:
    r = GateReport("acting")
    lines = {l.id: l for l in ep.lines()}
    seen = set()
    last_gesture: dict[str, str] = {}
    close = 0
    for la in plan.lines:
        line = lines.get(la.line_id)
        if not line:
            r.error("acting.line", f"no line {la.line_id} in the episode")
            continue
        seen.add(la.line_id)
        n = len(words(line.text))
        for b in la.beats:
            if not 0 <= b.word < n:
                r.error("acting.word", f"word {b.word} does not exist (the line has {n} words)", la.line_id)
            if not _look_ok(b.look, ep.cast, line.speaker):
                r.error("acting.look", f"{line.speaker} cannot look at {b.look}", la.line_id)
            if b.eyes in CLASH.get(line.emotion, set()):
                r.error("acting.feeling", f"{b.eyes} eyes contradict a {line.emotion} line", la.line_id)
        for x in la.listeners:
            if x.character not in ep.cast or x.character == line.speaker:
                r.error("acting.listener", f"{x.character} is not a listener in this scene", la.line_id)
            if not 0 <= x.word < n:
                r.error("acting.word", f"reaction on word {x.word}, the line has {n} words", la.line_id)
            if not _look_ok(x.look, ep.cast, x.character):
                r.error("acting.look", f"{x.character} cannot look at {x.look}", la.line_id)
        if len(la.beats) > max(1, round(n * MAX_BEATS_PER_WORD)) + 1:
            r.warn("acting.busy", f"{len(la.beats)} changes on {n} words: the puppet will fidget", la.line_id)
        main = next((b.action for b in la.beats if b.action), None)
        if main and last_gesture.get(line.speaker) == main:
            r.warn("acting.repeat", f"{line.speaker} does {main} on two lines in a row", la.line_id)
        if main:
            last_gesture[line.speaker] = main
        close += la.camera in ("push_in", "close_up")
    for lid in lines:
        if lid not in seen:
            r.error("acting.missing", "no acting for this line", lid)
    if close > max(2, len(lines) // 8):
        r.warn("acting.camera", f"{close} camera moves in: keep them for the emotional turn")
    return r


def repair(bible: Bible, ep: Episode, plan: ActingPlan) -> ActingPlan:
    """What is left after the last round: invalid choices dropped, missing lines given the
    default performance. Acting never stops an episode; it degrades to the rules."""
    lines = {l.id: l for l in ep.lines()}
    by_id = {la.line_id: la for la in plan.lines if la.line_id in lines}
    out = []
    for lid, line in lines.items():
        la = by_id.get(lid) or LineActing(line_id=lid)
        n = len(words(line.text))
        beats = [b.model_copy(update={"look": b.look if _look_ok(b.look, ep.cast, line.speaker) else None,
                                      "eyes": None if b.eyes in CLASH.get(line.emotion, set()) else b.eyes})
                 for b in la.beats if 0 <= b.word < n][:3]
        listeners = [x.model_copy(update={"look": x.look if _look_ok(x.look, ep.cast, x.character) else None})
                     for x in la.listeners if x.character in ep.cast and x.character != line.speaker and 0 <= x.word < n]
        out.append(la.model_copy(update={"beats": beats, "listeners": listeners}))
    return ActingPlan(lines=out)


def direct(bible: Bible, ep: Episode, llm: LLM, rounds: int = 2) -> tuple[ActingPlan, GateReport]:
    system, prompt = director_system(bible, ep), director_prompt(bible, ep)
    plan = llm.ask(system, prompt, ActingPlan)
    for rnd in range(rounds):
        report = check_acting(bible, ep, plan)
        if report.passed or rnd == rounds - 1:
            break
        issues = "\n".join(f"- {i}" for i in report.errors())
        plan = llm.ask(system, f"{prompt}\n\nYour last plan had these problems; send the whole plan again, fixed:\n{issues}",
                       ActingPlan)
    report = check_acting(bible, ep, plan)
    if not report.passed:
        plan = repair(bible, ep, plan)
        report.warn("acting.repaired", "invalid choices were dropped and missing lines use the default performance")
    return plan, report


def save(plan: ActingPlan, path: Path) -> None:
    path.write_text(plan.model_dump_json(indent=2, exclude_none=True) + "\n", encoding="utf-8")


def load(path: Path) -> ActingPlan:
    return ActingPlan.model_validate(json.loads(path.read_text(encoding="utf-8")))


# ---------------------------------------------------------------- timing to the word
@dataclass(frozen=True)
class WordTime:
    word: str
    start: float
    end: float


def word_times(text: str, lang: str, start: float, end: float) -> list[WordTime]:
    """Where each word falls inside the line: shared out by syllables, with a small pause
    after punctuation. A forced alignment of the audio can replace it later; the plan
    only needs the word index."""
    ws = words(text)
    if not ws:
        return []
    weights = []
    rest = text
    for w in ws:
        i = rest.find(w)
        after = rest[i + len(w): i + len(w) + 2] if i >= 0 else ""
        rest = rest[i + len(w):] if i >= 0 else rest
        weights.append(syllables(w, lang) + (0.8 if any(p in after for p in ",.!?…;:") else 0.0))
    total = sum(weights)
    out, t = [], start
    for w, k in zip(ws, weights):
        d = (end - start) * k / total
        out.append(WordTime(w, round(t, 3), round(t + d, 3)))
        t += d
    return out


def expected_rate(lang: str, pace: str) -> float:
    return RATE[pace] * LANG_RATE.get(lang, 1.1)
