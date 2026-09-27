import pytest

from studio.timing import GAP_S, LEAD_IN_S, MAX_SHOT_S, MAX_TEMPO, TAIL_S, build_timeline, fit_dub, fit_line


def lengths_for(ep, seconds=1.5):
    return {l.id: seconds for l in ep.lines()}


def test_the_audio_sets_the_shot_length(pilot):
    tl = build_timeline(pilot, lengths_for(pilot))
    first = tl.shots[0]
    assert first.lines[0].start == LEAD_IN_S
    assert first.duration == pytest.approx(LEAD_IN_S + 1.5 + TAIL_S)
    assert tl.duration == pytest.approx(sum(s.duration for s in tl.shots))
    assert [s.start for s in tl.shots] == sorted(s.start for s in tl.shots)


def test_lines_follow_each_other_with_the_reserve_and_the_hold(pilot):
    tl = build_timeline(pilot, lengths_for(pilot))
    for s in tl.shots:
        for a, b in zip(s.lines, s.lines[1:]):
            assert b.start == pytest.approx(a.end + GAP_S + a.hold)
        assert s.duration <= MAX_SHOT_S + 8 or len(s.lines) == 1


def test_a_beat_is_cut_into_shots_at_line_boundaries(pilot):
    tl = build_timeline(pilot, lengths_for(pilot, 3.0))
    help_shots = [s for s in tl.shots if s.segment == "help"]
    assert len(help_shots) > 1
    assert sum(len(s.lines) for s in help_shots) == 6


def test_missing_audio_is_an_error(pilot):
    with pytest.raises(ValueError, match="generate the voice first"):
        build_timeline(pilot, {})


def test_the_four_rungs_of_the_dub_ladder():
    assert fit_line(1.3, 1.2).rung == 1
    assert fit_line(1.3, 1.6).rung == 2               # eats the 0.4 s reserve
    f = fit_line(1.3, 1.3 + GAP_S + 0.1)
    assert f.rung == 3 and 1 < f.tempo <= MAX_TEMPO   # a little faster, same pitch
    assert (1.3 + GAP_S + 0.1) / f.tempo <= 1.3 + GAP_S
    assert fit_line(1.3, 2.5).rung == 4               # re-render that shot


def test_the_plans_example_fits_on_the_second_rung():
    # "¡Vamos a descubrirlo!" takes 1.6 s instead of 1.3 s
    assert fit_line(1.3, 1.6).rung == 2


def test_a_dub_keeps_the_body_timing_unless_a_shot_must_be_rerendered(pilot):
    tl = build_timeline(pilot, lengths_for(pilot))
    es = lengths_for(pilot, 1.7)
    dub, fits = fit_dub(tl, "es", es)
    assert dub.rerender == [] and [s.duration for s in dub.shots] == [s.duration for s in tl.shots]
    victim = tl.shots[3].lines[0].line_id
    es[victim] = 4.0
    dub, fits = fit_dub(tl, "es", es)
    assert dub.rerender == [tl.shots[3].id]
    assert dub.shots[3].duration > tl.shots[3].duration
    assert dub.shots[4].start > tl.shots[4].start       # later shots move
    assert dub.shots[2].start == tl.shots[2].start      # earlier ones do not
    assert {f.rung for f in fits if f.line_id == victim} == {4}
