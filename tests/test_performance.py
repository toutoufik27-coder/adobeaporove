from studio.performance import GESTURE_LEAD_FRAMES, blinks, shot_plan
from studio.timing import build_timeline


def plan(bible, ep):
    tl = build_timeline(ep, {l.id: 1.5 for l in ep.lines()}, 24)
    return tl, shot_plan(bible, ep, tl)


def test_every_shot_has_its_speakers_and_someone_to_talk_to(pilot_bible, pilot):
    tl, shots = plan(pilot_bible, pilot)
    assert len(shots) == len(tl.shots)
    for s, sh in zip(shots, tl.shots):
        on = [c["ch"] for c in s["cast"]]
        assert set(sh.speakers) <= set(on) and len(on) >= 2


def test_the_hand_leads_the_voice_by_four_frames(pilot_bible, pilot):
    tl, shots = plan(pilot_bible, pilot)
    line = tl.shots[0].lines[0]
    kiko = next(c for c in shots[0]["cast"] if c["ch"] == "ch_01")
    gesture = next(k for k in kiko["track"] if k.get("line") == line.line_id)
    assert gesture["t"] == round(line.start - GESTURE_LEAD_FRAMES / 24, 3)
    assert gesture["action"] == "wave"


def test_listeners_nod_and_look_at_the_speaker(pilot_bible, pilot):
    _, shots = plan(pilot_bible, pilot)
    nods = [k for s in shots for c in s["cast"] for k in c["track"] if k["action"] == "listen_nod" and "line" not in k]
    assert nods and all("look_at" in k for k in nods)


def test_brows_rise_on_questions(pilot_bible, pilot):
    _, shots = plan(pilot_bible, pilot)
    mira_q = [c for s in shots for c in s["cast"] if c["ch"] == "ch_04" and c["brows"]]
    assert mira_q  # "How do you feel now?"


def test_miras_scarf_follows_her_feeling(pilot_bible, pilot):
    _, shots = plan(pilot_bible, pilot)
    scarves = [k for s in shots for c in s["cast"] if c["ch"] == "ch_04" for k in c.get("scarf", [])]
    assert {"color": "green", "blend_s": 0.5} .items() <= next(k for k in scarves if k["color"] == "green").items()
    assert all("scarf" not in c for s in shots for c in s["cast"] if c["ch"] != "ch_04")


def test_blinks_are_random_but_repeatable():
    a = blinks(20.0, 42, [3.0])
    assert a == blinks(20.0, 42, [3.0]) and a != blinks(20.0, 43, [3.0])
    gaps = [y - x for x, y in zip(a, a[1:])]
    assert all(g >= 0.4 for g in gaps) and 3.0 in a


def test_motion_style_comes_from_the_bible(pilot_bible, pilot):
    _, shots = plan(pilot_bible, pilot)
    zuzu = next(c for s in shots for c in s["cast"] if c["ch"] == "ch_05")
    assert zuzu["speed"] == pilot_bible.characters["ch_05"].motion_style.speed
