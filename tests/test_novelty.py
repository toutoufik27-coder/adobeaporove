from studio.gates.novelty import check_novelty, similarity
from studio.ledger import Past


def past(ep, id_="ep_0100", title="Another Day"):
    return Past(id_, ep.format, ep.lesson_id, ep.value, ep.lead, title, ep.text())


def test_a_new_script_passes(pilot_bible, pilot):
    other = "The garden is full of snails today.\nWhere are they going so slowly?\nMaybe home for lunch."
    r = check_novelty(pilot_bible, pilot, [Past("ep_0100", "why", "x", "curiosity", "ch_02", "Snails", other)])
    assert r.passed, [str(i) for i in r.issues]


def test_the_same_script_again_is_refused(pilot_bible, pilot):
    r = check_novelty(pilot_bible, pilot.model_copy(update={"id": "ep_0101", "title": "New Title"}), [past(pilot)])
    assert "novelty.repeat" in [i.code for i in r.errors()]


def test_the_same_title_is_refused(pilot_bible, pilot):
    r = check_novelty(pilot_bible, pilot.model_copy(update={"id": "ep_0101"}), [Past("ep_0100", "", "", "", "", pilot.title, "hello")])
    assert "novelty.title" in [i.code for i in r.errors()]


def test_catchphrases_and_names_do_not_make_scripts_similar(pilot_bible):
    a = "Let's find out! Kiko and Beni look at the moon.\nHow do you feel now?"
    b = "Let's find out! Kiko and Beni count red apples.\nHow do you feel now?"
    assert similarity(pilot_bible, a, b, "en") == 0.0
