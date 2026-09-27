import json

import pytest

from studio.bible import BibleError, check_bible, load_bible
from studio.bible.models import Character, Format

from .conftest import ROOT, with_character


def codes(findings, level="error"):
    return {f.code for f in findings if f.level == level}


def test_the_bible_loads_and_has_no_errors(bible):
    assert len(bible.characters) == 6
    findings = check_bible(bible)
    assert codes(findings) == set(), [str(f) for f in findings]


def test_mira_is_flagged_as_an_everyday_spanish_word(bible):
    msgs = [f.message for f in check_bible(bible) if f.code == "name.common_word"]
    assert any("Mira" in m and "es" in m for m in msgs)


def test_the_plans_original_voice_values_break_the_plans_own_rule(bible):
    # kids-training.html: Kiko +4, Beni +3, Mira +3, Zuzu +5, Nilo +1
    original = {"ch_01": 4, "ch_02": 3, "ch_04": 3, "ch_05": 5, "ch_06": 1}
    b = bible
    for cid, pitch in original.items():
        ch = b.characters[cid]
        b = with_character(b, cid, voice=ch.voice.model_copy(update={"pitch_semitones": pitch}))
    close = [f.message for f in check_bible(b) if f.code == "voice.close"]
    assert any("Beni" in m and "Mira" in m for m in close)
    assert any("Kiko" in m and "Zuzu" in m for m in close)


def test_two_characters_with_nearly_the_same_colour_are_rejected(bible):
    kiko = bible.characters["ch_01"]
    beni = bible.characters["ch_02"]
    vis = beni.visual.model_copy(update={"primary_color": kiko.visual.primary_color,
                                         "palette": [kiko.visual.primary_color, *beni.visual.palette[1:]]})
    assert "look.color" in codes(check_bible(with_character(bible, "ch_02", visual=vis)))


def test_two_names_with_the_same_initial_are_rejected(bible):
    assert "name.initial" in codes(check_bible(with_character(bible, "ch_02", name="Kobi")))


def test_fifteen_launch_lessons_run_out_at_episode_sixteen(bible):
    # the curriculum as first written: 15 lessons for the one launch format
    first15 = [l for l in bible.curriculum.lessons if "feelings_day" in l.formats][:15]
    others = [l for l in bible.curriculum.lessons if "feelings_day" not in l.formats]
    b = bible.model_copy(update={"curriculum": bible.curriculum.model_copy(update={"lessons": first15 + others})})
    capacity = [f.message for f in check_bible(b) if f.code == "curriculum.capacity"]
    assert capacity and "month 0" in capacity[0] and "episode 16" in capacity[0]


def test_unknown_fields_and_typos_are_rejected_on_load():
    data = json.loads((ROOT / "bible/characters/ch_01.json").read_text(encoding="utf-8"))
    data["favourite_colour"] = "blue"
    with pytest.raises(Exception, match="favourite_colour"):
        Character.model_validate(data)
    data.pop("favourite_colour")
    data["visual"]["primary_color"] = "#12345"
    with pytest.raises(Exception, match="RRGGBB"):
        Character.model_validate(data)


def test_a_format_template_must_be_contiguous_and_cover_the_duration():
    data = json.loads((ROOT / "bible/formats/feelings_day.json").read_text(encoding="utf-8"))
    data["template"][2]["start_s"] += 1
    with pytest.raises(Exception, match="must start at"):
        Format.model_validate(data)


def test_a_file_whose_id_is_not_its_name_is_refused(tmp_path):
    import shutil
    shutil.copytree(ROOT / "bible", tmp_path / "bible")
    (tmp_path / "bible/characters/ch_01.json").rename(tmp_path / "bible/characters/ch_09.json")
    with pytest.raises(BibleError):
        load_bible(tmp_path)


def test_active_languages_follow_the_launch_plan(bible):
    assert bible.world.active_languages(0) == ["en", "es"]
    assert bible.world.active_languages(8)[-1] == "ar"
    assert bible.world.primary_language == "en"
