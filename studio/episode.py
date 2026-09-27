"""episode.json: what the writer produces and every later step reads. Line ids are
assigned by code, never by the model, so they stay stable across revisions and dubs."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Emotion = Literal["neutral", "happy", "excited", "curious", "surprised", "sad", "worried",
                  "frustrated", "proud", "calm", "sorry", "shy", "scared_mild"]

# the motion library (training lab, section 4): made once on the shared skeleton
MOTIONS = (
    "idle_breathe", "blink", "look_around",
    "walk", "run", "jump", "hop_in_place", "sit_down", "stand_up", "turn",
    "wave", "point", "clap", "shrug", "thumbs_up", "hands_on_hips", "think_chin",
    "happy_bounce", "sad_slump", "surprise", "scared_step_back", "proud", "shy",
    "talk_gesture_a", "talk_gesture_b", "listen_nod", "shake_head",
)
Motion = Literal[MOTIONS]  # type: ignore[valid-type]

# Mira's scarf: feeling -> colour name (the rig maps names to material colours)
SCARF = {"curious": "yellow", "sad": "blue", "happy": "pink", "calm": "green", "worried": "grey",
         "frustrated": "orange", "proud": "purple", "excited": "pink", "surprised": "yellow"}


class Line(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^l_\d{3}$")
    speaker: str
    text: str = Field(min_length=1)
    emotion: Emotion = "neutral"
    action: Motion | None = None
    hold_s: float = Field(0.0, ge=0, le=8, description="wordless action or reaction after the line, seconds")


class Beat(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segment: str
    place: str
    lighting: str = "morning"
    lines: list[Line]


class Episode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^ep_\d{4}$")
    format: str
    lesson_id: str
    value: str
    title: str
    logline: str
    lead: str
    roles: dict[str, str] = Field(description="episode stage -> character id")
    cast: list[str]
    language: str
    beats: list[Beat]
    translations: dict[str, dict[str, str]] = Field(default_factory=dict, description="language -> line id -> text")
    status: Literal["draft", "gated", "approved", "rendered", "published"] = "draft"

    def lines(self) -> list[Line]:
        return [l for b in self.beats for l in b.lines]

    def text(self, lang: str | None = None) -> str:
        if lang is None or lang == self.language:
            return "\n".join(l.text for l in self.lines())
        tr = self.translations.get(lang, {})
        return "\n".join(tr.get(l.id, "") for l in self.lines())

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.model_dump_json(indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Episode":
        return cls.model_validate(json.loads(path.read_text(encoding="utf-8")))


class Idea(BaseModel):
    """What gate 0 checks, chosen before any text is written."""
    model_config = ConfigDict(extra="forbid")
    format: str
    lesson_id: str
    value: str
    lead: str
    roles: dict[str, str]
    cast: list[str]
    place: str
    month: int = 0
