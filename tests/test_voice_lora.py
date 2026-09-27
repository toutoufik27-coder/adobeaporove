import json
import re

import pytest

from studio.lora import (build_dataset, caption_problems, check_mix, eval_prompts, fixed_words, kohya_argv,
                         repeats_for, trigger)
from studio.voice import pitch_argv, pitch_ratio, ref_for, voice_episode
from studio.voice_quality import ROUNDS, TAKES


def test_pitch_follows_the_plan_and_stops_at_plus_five():
    assert pitch_ratio(4) == pytest.approx(1.26, abs=0.001)  # the plan's example
    af = pitch_argv("a.wav", "b.wav", 3)[6]
    ratios = [float(x) for x in re.findall(r"rubberband=pitch=([0-9.]+)", af)]
    assert len(ratios) == 2 and ratios[0] * ratios[1] == pytest.approx(2 ** (3 / 12), abs=1e-4)
    assert "formant=shifted" in af and "formant=preserved" in af  # only part of the shift moves the formants
    with pytest.raises(ValueError, match="chipmunk"):
        pitch_ratio(6)


def test_an_emotional_reference_is_used_when_it_exists(tmp_path, bible):
    kiko = bible.characters["ch_01"]
    base = tmp_path / kiko.voice.refs["en"]
    base.parent.mkdir(parents=True)
    base.write_bytes(b"")
    assert ref_for(tmp_path, kiko, "en", "happy") == base
    (base.parent / "kiko_happy.wav").write_bytes(b"")
    assert ref_for(tmp_path, kiko, "en", "happy").name == "kiko_happy.wav"
    with pytest.raises(ValueError, match="no pt reference"):
        ref_for(tmp_path, kiko, "pt")


def fakes(bad_lines=(), always_bad=()):
    tries = {}

    def synth(text, lang, ref, ex, cfg, seed, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(f"{text}|{seed}")
        return 0.06 * len(text)

    def similarity(ref, wav):
        lid = wav.stem.split("_t")[0]
        tries[lid] = tries.get(lid, 0) + 1
        if lid in always_bad or (lid in bad_lines and tries[lid] == 1):
            return 0.6
        return 0.86

    def transcribe(wav, lang):
        return wav.read_text().split("|")[0]

    return synth, similarity, transcribe, tries


def test_each_line_keeps_its_best_take_and_flags_what_never_passes(tmp_path, bible, pilot):
    synth, sim, heard, tries = fakes(bad_lines={"l_003"}, always_bad={"l_005"})
    report = voice_episode(tmp_path, bible, pilot, "en", tmp_path / "audio/en", synth, sim, heard, log=lambda m: None,
                           check=lambda *a: [], finish=None)
    by_id = {r["line_id"]: r for r in report["lines"]}
    assert by_id["l_003"]["takes"] == TAKES and by_id["l_003"]["passed"]  # one bad take of three: still one round
    assert by_id["l_005"]["takes"] == TAKES * ROUNDS and not by_id["l_005"]["passed"]
    assert report["flagged"] == ["l_005"] and not report["rvc_advised"]
    lengths = json.loads((tmp_path / "audio/en/lengths.json").read_text())
    assert set(lengths) == {l.id for l in pilot.lines()}


def test_rvc_is_advised_when_the_voice_keeps_drifting(tmp_path, bible, pilot):
    ids = [l.id for l in pilot.lines()]
    synth, sim, heard, _ = fakes(always_bad=set(ids[:5]))
    report = voice_episode(tmp_path, bible, pilot, "es", tmp_path / "audio/es", synth, sim, heard, log=lambda m: None,
                           check=lambda *a: [], finish=None)
    assert report["rvc_advised"]


def test_trigger_words_and_fixed_traits(bible):
    kiko, zuzu = bible.characters["ch_01"], bible.characters["ch_05"]
    assert trigger(kiko) == "kikoch01"
    assert {"backpack", "overall", "sneakers"} <= fixed_words(kiko)
    assert caption_problems(kiko, "kikoch01, jumping, arms up, park background") == []
    assert caption_problems(kiko, "kikoch01, yellow flowers, park background") == []
    assert any("backpack" in p for p in caption_problems(kiko, "kikoch01, waving, with her backpack"))
    assert "--flip_aug" in kohya_argv(kiko, "d", "o", "v2", "base.safetensors")
    assert "--flip_aug" not in kohya_argv(zuzu, "d", "o", "v2", "base.safetensors")  # the tilted hat


def test_repeats_reach_the_safe_steps():
    assert repeats_for(30) == 10          # 30 x 10 x 10 / 2 = 1500, the plan's example
    for n in range(12, 41):
        steps = n * repeats_for(n) * 10 / 2
        assert 1500 <= steps <= 2500


def test_the_dataset_mix_is_checked_before_training():
    shots = ["full_body"] * 12 + ["half_body"] * 9 + ["close_up"] * 6 + ["group"] * 3
    assert check_mix(shots, ["white", "scene"] * 15) == []
    problems = check_mix(["close_up"] * 30, ["white"] * 30)
    assert any("full_body" in p for p in problems) and any("white" in p for p in problems)


def test_the_dataset_folder_is_what_kohya_reads(tmp_path, bible):
    kiko = bible.characters["ch_01"]
    img = tmp_path / "src.png"
    img.write_bytes(b"png")
    items = [(img, "full body, waving, garden background")] * 30
    root = build_dataset(kiko, items, tmp_path / "dataset", "v2")
    folder = root / "10_kikoch01 character"
    assert (folder / "0030.png").exists()
    assert (folder / "0001.txt").read_text().startswith("kikoch01, full body")
    with pytest.raises(ValueError, match="captions to fix"):
        build_dataset(kiko, [(img, "waving with the explorer backpack")], tmp_path / "d2", "v1")


def test_the_evaluation_grid_is_fixed(bible):
    p = eval_prompts(bible.characters["ch_04"])
    assert len(p) == 8 and all(x.startswith("mirach04, ") for x in p)
