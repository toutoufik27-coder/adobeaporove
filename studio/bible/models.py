"""The bible as typed data. A file that does not match these models is rejected on load,
so a typo in a colour, a missing catchphrase or an unknown field is found before any
episode is written. Mutable numbers (appearances, view metrics) are not here: they live
in the ledger, so the bible stays a reviewed, versioned source of truth."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..colors import HEX

Lang = Literal["en", "es", "pt", "fr", "de", "hi", "ru", "ar", "id", "ms"]
Pace = Literal["slow", "moderate", "fast"]
Stage = Literal["question", "rush", "caution", "failed_try", "emotion", "discovery", "solution"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


def _hex(v: str) -> str:
    if not HEX.match(v):
        raise ValueError(f"not a #RRGGBB colour: {v!r}")
    return v.upper()


# ---------------------------------------------------------------- characters
class Hair(Strict):
    style: str
    color: str

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        return _hex(v)


class Visual(Strict):
    silhouette: str = Field(description="silhouette class; no two characters share one")
    head_body_ratio: str
    primary_color: str = Field(description="the character's colour; distinct from every other")
    hair: Hair
    skin: str
    outfit_fixed: dict[str, str]
    signature: str = Field(description="the item that never leaves the character")
    palette: list[str] = Field(min_length=2)
    symmetric: bool = Field(description="false: training images are never mirrored")

    @field_validator("primary_color", "skin")
    @classmethod
    def _one(cls, v: str) -> str:
        return _hex(v)

    @field_validator("palette")
    @classmethod
    def _many(cls, v: list[str]) -> list[str]:
        return [_hex(c) for c in v]

    @model_validator(mode="after")
    def _primary_in_palette(self) -> "Visual":
        if self.primary_color not in self.palette:
            raise ValueError("primary_color must be one of the palette colours")
        return self


class Speech(Strict):
    sentence_words: tuple[int, int] = Field(description="usual sentence length, words (min, max)")
    vocabulary_grade: int = Field(ge=0, le=3)
    tone: str
    style: str = Field(description="how the character talks, e.g. ends_with_question")
    catchphrase: dict[str, str]

    @field_validator("sentence_words")
    @classmethod
    def _range(cls, v: tuple[int, int]) -> tuple[int, int]:
        if not 1 <= v[0] <= v[1] <= 12:
            raise ValueError("sentence_words must be 1 <= min <= max <= 12 for ages 3-6")
        return v


class Personality(Strict):
    traits: list[str] = Field(min_length=1)
    speech: Speech
    never_does: list[str] = Field(min_length=1)


class Voice(Strict):
    """How the synthetic voice is made (level 0) and spoken (level 1). The recipe file that
    records the chosen seed is the proof of the voice's origin."""
    parler_description: str
    pitch_semitones: float = Field(ge=-3, le=5, description="rubberband shift; above +5 sounds like a chipmunk")
    pace: Pace
    exaggeration: float = Field(ge=0, le=2)
    cfg_weight: float = Field(ge=0, le=1)
    refs: dict[str, str] = Field(default_factory=dict, description="language -> reference wav")
    recipe: str | None = None


class MotionStyle(Strict):
    speed: float = Field(gt=0.5, lt=2)
    bounce: float = Field(gt=0, lt=2)


class Assets(Strict):
    rig: str
    mouths: str
    turnaround: str
    lora: str


class Character(Strict):
    id: str = Field(pattern=r"^ch_\d{2}$")
    name: str
    pronunciation: str
    group: Literal["core", "companion", "mentor", "circle", "visitor"]
    archetype: str
    role: str
    age_apparent: int = Field(ge=3, le=9)
    domain: str
    lead_stage: Stage = Field(description="the episode stage this character leads by default")
    visual: Visual
    personality: Personality
    relationships: dict[str, str] = Field(default_factory=dict)
    voice: Voice
    motion_style: MotionStyle
    assets: Assets


# ---------------------------------------------------------------- world
class Place(Strict):
    id: str
    name: str
    angles: int = Field(ge=1)
    lighting: list[str] = Field(min_length=1)
    launch: bool


class LanguagePlan(Strict):
    code: Lang
    order: int
    month: int = Field(ge=0, description="production month it goes live (0 = launch)")
    primary: bool = False


class World(Strict):
    hub: str
    places: list[Place]
    rules: list[str] = Field(description="safety by design: situations that never exist in this world")
    rule_terms: dict[str, list[str]] = Field(description="language -> words that break the world rules")
    languages: list[LanguagePlan]
    planned_ids: list[str] = Field(default_factory=list, description="cast ids not in the bible yet (companions…)")
    banned_names: list[str] = Field(description="names never used for a character")
    max_value_share: float = Field(gt=0, le=1)
    lesson_repeat_window: int = Field(ge=1)
    fps: int = 24

    @model_validator(mode="after")
    def _one_primary(self) -> "World":
        if sum(1 for l in self.languages if l.primary) != 1:
            raise ValueError("exactly one primary language")
        return self

    def active_languages(self, month: int) -> list[str]:
        return [l.code for l in sorted(self.languages, key=lambda l: l.order) if l.month <= month]

    @property
    def primary_language(self) -> str:
        return next(l.code for l in self.languages if l.primary)


# ---------------------------------------------------------------- formats
class Segment(Strict):
    id: str
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    purpose: str


class Format(Strict):
    id: str
    name: str
    content: str
    duration_s: int = Field(gt=0)
    quota: float = Field(gt=0, le=1, description="share of all episodes")
    launch_month: int = Field(ge=0)
    template: list[Segment] = Field(min_length=1)

    @model_validator(mode="after")
    def _contiguous(self) -> "Format":
        t = 0.0
        for s in self.template:
            if abs(s.start_s - t) > 1e-6 or s.end_s <= s.start_s:
                raise ValueError(f"{self.id}: segment {s.id} must start at {t} and end after it starts")
            t = s.end_s
        if abs(t - self.duration_s) > 1e-6:
            raise ValueError(f"{self.id}: segments end at {t}s, format lasts {self.duration_s}s")
        return self


# ---------------------------------------------------------------- curriculum
class Lesson(Strict):
    id: str
    value: str = Field(description="the one explicit educational value (mandatory)")
    goal: str
    formats: list[str] = Field(min_length=1)


class Curriculum(Strict):
    lessons: list[Lesson]


# ---------------------------------------------------------------- lexicon and culture
class Lexicon(Strict):
    language: Lang
    banned: list[str] = Field(description="words or phrases; matched on word boundaries, case-insensitive")
    banned_patterns: list[str] = Field(default_factory=list, description="regular expressions")
    max_syllables: int = Field(ge=2, le=6, description="longer words need the allow-list")
    allowed_long_words: list[str] = Field(default_factory=list)
    max_sentence_words: int = Field(ge=4, le=15, description="hard cap for any sentence, any character")
    common_words: list[str] = Field(default_factory=list, description="everyday words a name must not be (Mira = 'look!' in Spanish)")


class Culture(Strict):
    market: str
    language: Lang
    avoid_terms: list[str] = Field(default_factory=list, description="innocent elsewhere, not here")
    notes: list[str] = Field(default_factory=list, description="context given to the reviewers")


class Bible(BaseModel):
    model_config = ConfigDict(frozen=True)
    characters: dict[str, Character]
    world: World
    formats: dict[str, Format]
    curriculum: Curriculum
    lexicons: dict[str, Lexicon]
    cultures: dict[str, Culture]
