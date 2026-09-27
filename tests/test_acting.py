import json
import shutil

import pytest

from studio.acting import (GESTURE_LEAD_FRAMES, REACTION_DELAY_S, ActingPlan, Beat, LineActing, Reaction, check_acting,
                           direct, director_prompt, director_system, repair, word_times)
from studio.llm import FakeLLM
from studio.performance import shot_plan
from studio.timing import build_timeline

from .conftest import FIXTURES, ROOT


def plain(ep):
    return {l.id: LineActing(line_id=l.id) for l in ep.lines()}


def directed(ep):
    """A director's plan: Kiko's gesture lands on "tallest", Mira looks at Kiko and
    worries, Zuzu reacts to the tower with surprise, the camera pushes in on the breath."""
    p = plain(ep)
    p["l_001"] = LineActing(line_id="l_001", beats=[
        Beat(word=0, eyes="happy", look="camera"),
        Beat(word=7, action="jump", hands="open"),
    ], listeners=[Reaction(character="ch_05", word=8, action="surprise", eyes="wide")])
    p["l_010"] = LineActing(line_id="l_010", beats=[Beat(word=0, look="ch_01", brows="worried")], camera="push_in")
    p["l_011"] = LineActing(line_id="l_011", beats=[Beat(word=3, action="idle_breathe", eyes="closed")], hold_action="idle_breathe")
    return ActingPlan(lines=list(p.values()))


def codes(r, level="error"):
    return {i.code for i in r.issues if i.level == level}


def test_a_good_plan_passes(pilot_bible, pilot):
    r = check_acting(pilot_bible, pilot, directed(pilot))
    assert r.passed, [str(i) for i in r.issues]


def test_the_gesture_lands_on_its_word_and_the_listener_reacts_after_it(pilot_bible, pilot):
    tl = build_timeline(pilot, {l.id: 3.0 for l in pilot.lines()}, 24)
    shots = shot_plan(pilot_bible, pilot, tl, directed(pilot))
    first = shots[0]
    lt = tl.shots[0].lines[0]
    words = word_times(pilot.lines()[0].text, "en", lt.start, lt.end)
    kiko = next(c for c in first["cast"] if c["ch"] == "ch_01")
    jump = next(k for k in kiko["track"] if k.get("action") == "jump")
    assert jump["t"] == round(words[7].start - GESTURE_LEAD_FRAMES / 24, 3) and jump["word"] == 7
    assert kiko["face"][0] == {"t": words[0].start, "line": "l_001", "word": 0, "eyes": "happy", "look": "camera"}
    assert kiko["principles"]["anticipation_frames"] >= 2
    zuzu = next(c for c in first["cast"] if c["ch"] == "ch_05")  # Zuzu answers Kiko: on screen as the listener
    react = next(k for k in zuzu["track"] if k.get("action") == "surprise")
    assert react["t"] == round(words[8].start + REACTION_DELAY_S, 3)
    assert not any(k.get("action") == "listen_nod" and k.get("look_at") == "ch_01" for k in zuzu["track"])
    help_shot = next(s for s in shots if any(l["id"] == "l_010" for l in s["lines"]))
    assert help_shot["camera"] and help_shot["camera"][0]["move"] == "push_in"


def test_without_a_plan_the_default_performance_stays(pilot_bible, pilot):
    tl = build_timeline(pilot, {l.id: 2.0 for l in pilot.lines()}, 24)
    shots = shot_plan(pilot_bible, pilot, tl)
    assert all(s["camera"] == [] for s in shots)
    assert any(k.get("action") == "listen_nod" for s in shots for c in s["cast"] for k in c["track"])


def test_impossible_choices_are_errors(pilot_bible, pilot):
    p = plain(pilot)
    p["l_001"] = LineActing(line_id="l_001", beats=[Beat(word=40, action="wave"), Beat(word=1, look="ch_01")],
                            listeners=[Reaction(character="ch_01", word=0), Reaction(character="ch_09", word=0)])
    p["l_003"] = LineActing(line_id="l_003", beats=[Beat(word=0, eyes="happy")])  # Beni is worried
    got = codes(check_acting(pilot_bible, pilot, ActingPlan(lines=list(p.values()))))
    assert {"acting.word", "acting.look", "acting.listener", "acting.feeling"} <= got


def test_missing_lines_are_errors_and_repair_fills_them(pilot_bible, pilot):
    plan = ActingPlan(lines=[LineActing(line_id="l_001", beats=[Beat(word=99, action="wave"), Beat(word=2, look="ch_01")])])
    assert "acting.missing" in codes(check_acting(pilot_bible, pilot, plan))
    fixed = repair(pilot_bible, pilot, plan)
    assert check_acting(pilot_bible, pilot, fixed).passed
    first = fixed.lines[0]
    assert len(first.beats) == 1 and first.beats[0].look is None  # the bad word dropped, the self-look cleared


def test_repeats_and_fidgeting_are_warnings(pilot_bible, pilot):
    p = plain(pilot)
    p["l_006"] = LineActing(line_id="l_006", beats=[Beat(word=0, action="shake_head")])
    p["l_009"] = LineActing(line_id="l_009", beats=[Beat(word=0, action="shake_head")])
    p["l_004"] = LineActing(line_id="l_004", beats=[Beat(word=i, action="jump") for i in range(5)])
    warns = codes(check_acting(pilot_bible, pilot, ActingPlan(lines=list(p.values()))), "warning")
    assert {"acting.repeat", "acting.busy"} <= warns


def test_the_director_is_told_what_was_wrong(pilot_bible, pilot):
    bad = plain(pilot)
    bad["l_003"] = LineActing(line_id="l_003", beats=[Beat(word=0, eyes="happy")])
    llm = FakeLLM([ActingPlan(lines=list(bad.values())), directed(pilot)])
    plan, report = direct(pilot_bible, pilot, llm)
    assert report.passed and len(llm.calls) == 2
    assert "contradict a worried line" in llm.calls[1][1]
    assert plan.lines[0].beats[1].action == "jump"


def test_a_plan_that_stays_wrong_is_repaired_not_fatal(pilot_bible, pilot):
    bad = ActingPlan(lines=[LineActing(line_id="l_001", beats=[Beat(word=50, action="wave")])])
    plan, report = direct(pilot_bible, pilot, FakeLLM([bad, bad]))
    assert "acting.repaired" in codes(report, "warning")
    assert len(plan.lines) == len(pilot.lines()) and check_acting(pilot_bible, pilot, plan).passed


def test_words_are_numbered_for_the_director(pilot_bible, pilot):
    prompt = director_prompt(pilot_bible, pilot)
    assert "7:tallest" in prompt and "l_011" in prompt and "[then 3s without words]" in prompt
    system = director_system(pilot_bible, pilot)
    assert "stressed word" in system and "Zuzu" in system and "thumbs_up" in system


def test_word_times_share_the_line_by_syllables(pilot):
    text = pilot.lines()[0].text
    w = word_times(text, "en", 0.6, 3.6)
    assert w[0].start == 0.6 and w[-1].end == pytest.approx(3.6, abs=0.01)
    assert all(a.end <= b.start + 1e-6 for a, b in zip(w, w[1:]))
    tallest, the = w[7], w[6]
    assert tallest.end - tallest.start > the.end - the.start  # two syllables take longer than one


def test_plan_command_uses_the_acting_file(tmp_path, pilot_bible, pilot):
    from studio.acting import save
    from studio.cli import main
    ep = tmp_path / "episode.json"
    shutil.copy(FIXTURES / "pilot.json", ep)
    save(directed(pilot), tmp_path / "acting.json")
    (tmp_path / "lengths.json").write_text(json.dumps({l.id: 2.5 for l in pilot.lines()}))
    assert main(["--root", str(ROOT), "plan", str(ep), str(tmp_path / "lengths.json")]) == 0
    plan = json.loads((tmp_path / "shots.json").read_text())
    assert plan["acting"] and any(s["camera"] for s in plan["shots"])
