import json
from pathlib import Path

import pytest

from studio.bible import load_bible
from studio.episode import Episode, Idea

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).parent / "fixtures"


def scaled(bible, fid: str, seconds: int):
    """The same format, shortened: the pilot is a short scene, not a 6-minute episode."""
    f = bible.formats[fid]
    k = seconds / f.duration_s
    tpl = [s.model_copy(update={"start_s": round(s.start_s * k, 3), "end_s": round(s.end_s * k, 3)}) for s in f.template]
    tpl[-1] = tpl[-1].model_copy(update={"end_s": float(seconds)})
    return bible.model_copy(update={"formats": {**bible.formats, fid: f.model_copy(update={"duration_s": seconds, "template": tpl})}})


def with_character(bible, cid: str, **update):
    ch = bible.characters[cid]
    return bible.model_copy(update={"characters": {**bible.characters, cid: ch.model_copy(update=update)}})


@pytest.fixture(scope="session")
def bible():
    return load_bible(ROOT)


@pytest.fixture(scope="session")
def pilot_bible(bible):
    return scaled(bible, "feelings_day", 80)


@pytest.fixture
def pilot() -> Episode:
    return Episode.model_validate(json.loads((FIXTURES / "pilot.json").read_text(encoding="utf-8")))


@pytest.fixture
def pilot_idea(pilot) -> Idea:
    return Idea(format=pilot.format, lesson_id=pilot.lesson_id, value=pilot.value, lead=pilot.lead,
                roles=pilot.roles, cast=pilot.cast, place="workshop", month=0)


def edit(ep: Episode, line_id: str, text: str | None = None, lang: str | None = None) -> Episode:
    """A copy of the episode with one line (or one translated line) replaced."""
    data = json.loads(ep.model_dump_json())
    if lang:
        data["translations"][lang][line_id] = text
    else:
        for b in data["beats"]:
            for l in b["lines"]:
                if l["id"] == line_id:
                    l["text"] = text
    return Episode.model_validate(data)
