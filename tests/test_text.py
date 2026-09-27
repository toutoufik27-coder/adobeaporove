from studio.gates.text import check_text, dub_fits, estimate_seconds

from .conftest import edit


def codes(report, level="error"):
    return [i.code for i in report.issues if i.level == level]


def test_the_pilot_passes_in_english_and_spanish(pilot_bible, pilot):
    for lang in ("en", "es"):
        r = check_text(pilot_bible, pilot, lang)
        assert r.passed, [str(i) for i in r.issues]


def test_the_pilot_is_far_too_short_for_a_six_minute_episode(bible, pilot):
    assert "structure.length" in codes(check_text(bible, pilot))


def test_the_length_estimate_is_close_to_the_pilot_format(pilot_bible, pilot):
    total = sum(estimate_seconds(pilot_bible, pilot).values())
    assert 60 <= total <= 100


def test_banned_words_match_whole_words_only(pilot_bible, pilot):
    bad = edit(pilot, "l_004", "Up, up, I will kill it!")
    assert "lexicon.banned" in codes(check_text(pilot_bible, bad))
    fine = edit(pilot, "l_004", "Up, up, what a skill!")
    assert "lexicon.banned" not in codes(check_text(pilot_bible, fine))


def test_calls_to_action_and_links_are_refused(pilot_bible, pilot):
    assert "lexicon.banned" in codes(check_text(pilot_bible, edit(pilot, "l_004", "Now subscribe, friends!")))
    assert "lexicon.pattern" in codes(check_text(pilot_bible, edit(pilot, "l_004", "Go to www.kiko.com now!")))


def test_world_rules_are_words_too(pilot_bible, pilot):
    assert "world.rule" in codes(check_text(pilot_bible, edit(pilot, "l_004", "Up it goes, near the fire!")))


def test_a_word_innocent_in_spain_is_refused_for_latin_america(pilot_bible, pilot):
    r = check_text(pilot_bible, edit(pilot, "l_007", "¡Yo lo voy a coger!", lang="es"), "es")
    assert "culture.es_latam" in codes(r)


def test_a_sentence_longer_than_the_cap_or_the_character_is_refused(pilot_bible, pilot):
    long = "Up and up and up and up and up the tower goes!"
    r = check_text(pilot_bible, edit(pilot, "l_004", long))
    assert "speech.too_long" in codes(r)
    zuzu = edit(pilot, "l_015", "Big blocks go first and small ones go on top!")  # Zuzu speaks 3-5 words
    assert "speech.character" in codes(check_text(pilot_bible, zuzu))


def test_hard_words_are_errors_unless_allowed(pilot_bible, pilot):
    assert "vocab.hard_word" in codes(check_text(pilot_bible, edit(pilot, "l_004", "Up, a magnificent tower!")))
    assert "vocab.hard_word" not in codes(check_text(pilot_bible, edit(pilot, "l_004", "Up, up, a caterpillar!")))


def test_a_dub_too_long_for_the_animation_is_refused(pilot_bible, pilot):
    long = "Kiko, lo que sientes ahora mismo se llama frustración, y es normal."
    r = check_text(pilot_bible, edit(pilot, "l_010", long, lang="es"), "es")
    assert "dub.length" in codes(r)


def test_spanish_is_compared_by_speaking_time_not_raw_syllables(pilot_bible):
    # 13 English syllables, 16 Spanish: 123 % of the syllables, 98 % of the time
    ok, ratio = dub_fits(pilot_bible, "ch_01", "Frustrated? Stop, breathe slowly, and try another way.", "en",
                         "¿Frustración? Para, respira y prueba de otra forma.", "es")
    assert ok and 0.9 < ratio < 1.1


def test_fixed_catchphrases_do_not_count_against_the_dub(pilot_bible):
    ok, _ = dub_fits(pilot_bible, "ch_04", "How do you feel now?", "en", "¿Cómo te sientes ahora?", "es")
    assert ok


def test_a_missing_translation_is_an_error(pilot_bible, pilot):
    data = pilot.model_copy(deep=True)
    del data.translations["es"]["l_003"]
    assert "dub.missing" in codes(check_text(pilot_bible, data, "es"))


def test_a_language_without_a_lexicon_cannot_pass(pilot_bible, pilot):
    assert "lexicon.missing" in codes(check_text(pilot_bible, pilot, "pt"))


def test_structure_follows_the_format_template(pilot_bible, pilot):
    data = pilot.model_copy(deep=True)
    data.beats[0], data.beats[1] = data.beats[1], data.beats[0]
    assert "structure.segments" in codes(check_text(pilot_bible, data))
    night = pilot.model_copy(deep=True)
    night.beats[2].lighting = "night"
    assert "world.rule" in codes(check_text(pilot_bible, night))


def test_a_speaker_outside_the_cast_is_refused(pilot_bible, pilot):
    data = pilot.model_copy(deep=True)
    data.cast = [c for c in data.cast if c != "ch_06"]
    assert "structure.speaker" in codes(check_text(pilot_bible, data))
