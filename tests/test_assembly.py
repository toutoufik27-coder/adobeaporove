from studio.gates.assembly import Loudness, Measures, check_assembly, transitions, worst_flash_second


def flicker(hz, fps=24, seconds=2, lo=0.05, hi=0.9):
    half = fps / hz / 2
    return [hi if int(i / half) % 2 else lo for i in range(fps * seconds)]


def good(pilot, **over):
    m = dict(fps=24, duration_s=80.0, tiles=[[0.4] * 9 for _ in range(48)], cuts=[8.0, 16.0, 30.0, 45.0, 60.0],
             loudness={"en": Loudness(-14.2, -1.6, 7.0)}, transcripts={"en": pilot.text()})
    m.update(over)
    return Measures(**m)


def codes(r):
    return {i.code for i in r.errors()}


def test_five_flashes_a_second_fail_and_two_pass():
    assert worst_flash_second(flicker(5), 24)[0] > 3
    assert worst_flash_second(flicker(2), 24)[0] <= 3


def test_small_wiggles_and_bright_only_changes_are_not_flashes():
    wiggle = [0.5 + (0.04 if i % 2 else 0) for i in range(48)]
    assert transitions(wiggle) == []
    bright = flicker(6, lo=0.82, hi=0.95)  # the darker state is above 0.8
    assert worst_flash_second(bright, 24)[0] == 0


def test_a_flash_in_one_corner_is_caught(pilot_bible, pilot):
    corner = flicker(6)
    tiles = [[0.4] * 8 + [corner[i]] for i in range(48)]
    assert "flash" in codes(check_assembly(pilot_bible, pilot, good(pilot, tiles=tiles)))


def test_a_clean_video_passes(pilot_bible, pilot):
    r = check_assembly(pilot_bible, pilot, good(pilot))
    assert r.passed, [str(i) for i in r.issues]


def test_loudness_off_target_or_a_hot_peak_fails(pilot_bible, pilot):
    assert "loudness.integrated" in codes(check_assembly(pilot_bible, pilot, good(pilot, loudness={"en": Loudness(-18, -3, 6)})))
    assert "loudness.peak" in codes(check_assembly(pilot_bible, pilot, good(pilot, loudness={"en": Loudness(-14, -0.2, 6)})))


def test_cutting_too_fast_for_small_children_fails(pilot_bible, pilot):
    fast = [i * 1.5 for i in range(1, 53)]
    got = codes(check_assembly(pilot_bible, pilot, good(pilot, cuts=fast)))
    assert "pace.average" in got
    assert "pace.short_shot" in codes(check_assembly(pilot_bible, pilot, good(pilot, cuts=[8.0, 8.5, 30.0])))


def test_a_voice_that_says_other_words_fails(pilot_bible, pilot):
    lines = pilot.text().splitlines()
    few = pilot.text().replace("tower", "flower").replace("blocks", "rocks")
    assert "words.wer" not in codes(check_assembly(pilot_bible, pilot, good(pilot, transcripts={"en": few})))
    half = "\n".join(lines[: len(lines) // 2])  # half of the lines never made it into the track
    assert "words.wer" in codes(check_assembly(pilot_bible, pilot, good(pilot, transcripts={"en": half})))


def test_missing_measurements_never_pass(pilot_bible, pilot):
    r = check_assembly(pilot_bible, pilot, Measures(fps=24, duration_s=80.0), "es")
    assert {"flash.unmeasured", "loudness.unmeasured", "words.unmeasured"} <= codes(r)
