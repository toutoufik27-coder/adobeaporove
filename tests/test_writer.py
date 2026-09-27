import json

import pytest

from studio.ledger import Ledger
from studio.llm import FakeLLM
from studio.writer import (Draft, DraftBeat, DraftLine, Review, ReviewFinding, TLine, Translation, WriteFailed,
                           brief, write_episode)

CLEAN = Review(findings=[], summary="fine")


def draft_from(ep, replace=None):
    replace = replace or {}
    return Draft(title=ep.title, logline=ep.logline, beats=[
        DraftBeat(segment=b.segment, place=b.place, lighting=b.lighting, lines=[
            DraftLine(speaker=l.speaker, text=replace.get(l.id, l.text), emotion=l.emotion, action=l.action, hold_s=l.hold_s)
            for l in b.lines]) for b in ep.beats])


def translation(ep, lang="es", replace=None):
    replace = replace or {}
    return Translation(lines=[TLine(id=i, text=replace.get(i, t)) for i, t in ep.translations[lang].items()])


def test_draft_revise_review_translate_save(pilot_bible, pilot, pilot_idea, tmp_path):
    llm = FakeLLM([
        draft_from(pilot, {"l_004": "Up, up, I will kill it!"}),     # gate 1 refuses
        draft_from(pilot),                                           # the revision passes
        CLEAN, CLEAN,                                                # gates 2 and 3
        translation(pilot, replace={"l_010": "Kiko, lo que sientes ahora mismo se llama frustración, y es normal."}),
        translation(pilot),                                          # the corrected dub
    ])
    ledger = Ledger()
    res = write_episode(pilot_bible, ledger, llm, 0, pilot_idea, out_dir=tmp_path, log=lambda m: None)
    assert res.passed and res.rounds == 2
    assert res.episode.translations["es"]["l_010"] == pilot.translations["es"]["l_010"]
    assert [c[2] for c in llm.calls] == ["Draft", "Draft", "Review", "Review", "Translation", "Translation"]
    assert "kill" in llm.calls[1][1]                       # the revision is told what was wrong
    assert "dub.length" in llm.calls[5][1]
    assert "independent child-safety reviewer" in llm.calls[3][0]
    assert "Lesson:" not in llm.calls[3][1]                 # gate 3 never sees the brief
    saved = json.loads(res.path.read_text())
    assert saved["status"] == "gated" and saved["lead"] == "ch_01"
    assert ledger.count() == 1 and ledger.recent(1)[0].lesson_id == "feel_frustrated_tower"
    assert all(r["passed"] for r in json.loads((res.path.parent / "gates.json").read_text()))


def test_a_behaviour_error_sends_the_script_back(pilot_bible, pilot, pilot_idea):
    bad = Review(findings=[ReviewFinding(line_id="l_002", severity="error", code="out-of-character",
                                         message="Zuzu never pushes in front of friends")], summary="one break")
    llm = FakeLLM([draft_from(pilot), bad, CLEAN, draft_from(pilot), CLEAN, CLEAN, translation(pilot)])
    res = write_episode(pilot_bible, Ledger(), llm, 0, pilot_idea, log=lambda m: None)
    assert res.passed and res.rounds == 2
    assert "Zuzu never pushes" in llm.calls[3][1]


def test_a_script_that_never_passes_is_kept_for_review_and_not_recorded(pilot_bible, pilot, pilot_idea, tmp_path):
    bad = draft_from(pilot, {"l_004": "Now subscribe, friends!"})
    ledger = Ledger()
    with pytest.raises(WriteFailed, match="still fails after 3 rounds") as e:
        write_episode(pilot_bible, ledger, FakeLLM([bad, bad, bad]), 0, pilot_idea, out_dir=tmp_path, log=lambda m: None)
    assert e.value.result.path.parent.name == "_rejected" and e.value.result.path.exists()
    assert ledger.count() == 0


def test_code_chooses_the_idea_when_none_is_given(pilot_bible, pilot):
    ledger = Ledger()
    llm = FakeLLM([draft_from(pilot), CLEAN, CLEAN, translation(pilot)])
    res = write_episode(pilot_bible, ledger, llm, 0, log=lambda m: None)
    assert res.episode.lesson_id == pilot_bible.curriculum.lessons[0].id and res.episode.lead == "ch_01"


def test_the_brief_carries_the_plan(pilot_bible, pilot_idea):
    text = brief(pilot_bible, pilot_idea, "en")
    assert "failed_try: Tuka (ch_03)" in text and "catchphrase" in text
    assert "opener" in text and "recap" in text and "calming_down" in text


def test_gate_zero_refuses_before_any_call(pilot_bible, pilot_idea):
    llm = FakeLLM([])
    with pytest.raises(WriteFailed, match="gate 0"):
        write_episode(pilot_bible, Ledger(), llm, 0, pilot_idea.model_copy(update={"format": "story_time"}), log=lambda m: None)
    assert llm.calls == []
