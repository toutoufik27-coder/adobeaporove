from collections import Counter

from studio.episode import Idea
from studio.gates.idea import (FIRST_ROTATION, WINDOW, check_idea, choose_idea, default_roles, leads_this_cycle,
                               live_formats, simulate)
from studio.ledger import Past


def past(n, idea: Idea) -> Past:
    return Past(f"ep_{n:04d}", idea.format, idea.lesson_id, idea.value, idea.lead, f"t{n}", "")


def run(bible, n, month=0):
    history = []
    for k in range(n):
        idea = choose_idea(bible, history, month)
        history.insert(0, past(k + 1, idea))
    return history


def test_at_launch_the_one_live_format_takes_the_whole_quota(bible):
    assert live_formats(bible, 0) == {"feelings_day": 1.0}
    assert abs(sum(live_formats(bible, 8).values()) - 1) < 1e-9


def test_the_first_ten_episodes_rotate_the_lead_through_the_six(bible):
    history = run(bible, FIRST_ROTATION)
    leads = [p.lead for p in reversed(history)]
    assert sorted(leads[:6]) == sorted(c for c in bible.characters)
    assert len(set(leads[6:10])) == 4


def test_a_lead_who_already_led_this_round_is_refused(bible):
    history = run(bible, 3)
    idea = choose_idea(bible, history, 0)
    again = idea.model_copy(update={"lead": history[0].lead, "roles": default_roles(bible, history[0].lead)})
    assert "lead.rotation" in {i.code for i in check_idea(bible, again, history).errors()}


def test_rounds_are_counted_from_the_first_episode(bible):
    history = run(bible, 7)  # one full round of six, then Kiko again
    assert leads_this_cycle(bible, history) == {history[0].lead}


def test_a_lesson_is_not_repeated_within_the_window(bible):
    history = run(bible, 5)
    idea = choose_idea(bible, history, 0)
    lesson = next(l for l in bible.curriculum.lessons if l.id == history[2].lesson_id)
    repeat = idea.model_copy(update={"lesson_id": lesson.id, "value": lesson.value})
    assert "lesson.repeat" in {i.code for i in check_idea(bible, repeat, history).errors()}


def test_a_format_that_is_not_live_yet_is_refused(bible):
    lesson = next(l for l in bible.curriculum.lessons if "story_time" in l.formats)
    idea = choose_idea(bible, [], 0).model_copy(update={"format": "story_time", "lesson_id": lesson.id, "value": lesson.value})
    assert "format.not_live" in {i.code for i in check_idea(bible, idea, []).errors()}


def test_no_value_takes_more_than_its_share(bible):
    for month in (0, 8):
        history = run(bible, 100, month)
        for k in range(len(history) - WINDOW):
            top = Counter(p.value for p in history[k:k + WINDOW]).most_common(1)[0][1]
            assert top <= bible.world.max_value_share * WINDOW


def test_roles_cover_the_six_stages_and_the_lead_asks_the_question(bible):
    for lead in bible.characters:
        roles = default_roles(bible, lead)
        assert roles["question"] == lead
        assert sorted(roles.values()) == sorted(bible.characters)


def test_the_curriculum_holds_at_every_stage_of_the_launch(bible):
    for month in (0, 3, 4, 5, 6, 7, 8):
        ideas = simulate(bible, 120, lambda n, m=month: m)
        assert len(ideas) == 120
    phased = simulate(bible, 300, lambda n: n // 35)  # the plan's top rate, 35 a month
    last = Counter(i.format for i in phased[-60:])
    assert set(last) == set(bible.formats)


def test_formats_follow_their_quotas_once_all_are_live(bible):
    ideas = simulate(bible, 200, lambda n: 8)
    shares = Counter(i.format for i in ideas[-100:])
    quotas = live_formats(bible, 8)
    for f, q in quotas.items():
        assert abs(shares[f] / 100 - q) <= 0.06, (f, shares[f], q)


def test_published_numbers_decide_the_lead_after_the_first_rotation(bible):
    history = run(bible, 12)
    assert choose_idea(bible, history, 0).lead == "ch_01"  # a new round starts with Kiko
    scores = {"ch_03": (2, 71.0, 0.4), "ch_01": (2, 52.0, 0.3)}
    assert choose_idea(bible, history, 0, scores).lead == "ch_03"  # Tuka's episodes are watched longer
