import shutil
import subprocess
import wave

import pytest

from studio.agent.config import AgentConfig
from studio.agent.images import framed, look_prompt, palette_score, render_pose, POSES
from studio.agent.lines import PASSAGES, validation_lines
from studio.agent.look_steps import _caption, install, round2_plan
from studio.agent.plan import build_plan
from studio.agent.steps import Ctx, NeedsAction
from studio.agent.voice_steps import pick_auto, pick_review, reference_argv
from studio.lora import caption_problems, trigger
from studio.text import sentences, term_regex, words
from studio.voice import pitch_argv

PIL = pytest.importorskip("PIL")
FFMPEG = shutil.which("ffmpeg")


def ctx_for(bible, tmp_path, task_id, inputs, params=None):
    plan = {t.id: t for t in build_plan(bible, AgentConfig(characters=["ch_01"]))}
    t = plan[task_id]
    return Ctx(tmp_path, bible, AgentConfig(), t, inputs, {**dict(t.params), **(params or {})}, log=lambda m: None)


def test_poses_are_openpose_skeletons():
    img = render_pose("waving")
    assert img.size == (1024, 1024) and img.getbbox() is not None
    assert framed(POSES["front"], "close_up")[10] is None     # no ankles in a close-up
    assert framed(POSES["front"], "full_body")[10] is not None
    assert POSES["back"][0] is None                           # no face from behind


def test_the_palette_score_tells_right_colours_from_wrong(tmp_path, bible):
    from PIL import Image, ImageDraw
    v = bible.characters["ch_01"].visual

    def figure(colours, name):
        img = Image.new("RGB", (512, 512), (255, 255, 255))
        d = ImageDraw.Draw(img)
        d.ellipse([180, 60, 330, 210], fill=colours[0])
        d.rectangle([170, 210, 340, 420], fill=colours[1])
        d.rectangle([190, 420, 320, 480], fill=colours[2])
        p = tmp_path / name
        img.save(p)
        return p

    right = figure([v.skin, v.primary_color, "#C9452F"], "right.png")
    wrong = figure(["#7FFF00", "#8A2BE2", "#00CED1"], "wrong.png")
    assert palette_score(right, v.palette, v.primary_color) > 0.8
    assert palette_score(wrong, v.palette, v.primary_color) < 0.2


def test_the_prompt_describes_the_character_in_words(bible):
    p = look_prompt(bible.characters["ch_01"])
    assert "girl" in p and "yellow overall" in p and "red sneakers" in p and "explorer backpack" in p
    assert "#" not in p and "curly" in p
    assert "tilted hat" in look_prompt(bible.characters["ch_05"])


def test_generated_captions_never_name_fixed_traits(bible):
    for ch in bible.characters.values():
        for (expr, angle, frame, bg, shot) in round2_plan():
            cap = f"{trigger(ch)}, {_caption('front' if angle == 'front' else angle, frame, expr, bg)}"
            assert caption_problems(ch, cap) == [], (ch.name, cap)


def test_round_two_aims_at_the_plans_mix():
    shots = [p[4] for p in round2_plan()]
    assert len(shots) == 24
    assert shots.count("full_body") >= shots.count("half_body") > shots.count("close_up") > shots.count("group") > 0
    whites = sum(p[3].startswith("plain white") for p in round2_plan())
    assert 8 <= whites <= 14


@pytest.mark.parametrize("lang", ["en", "es"])
def test_the_fifty_test_lines_obey_the_bible(bible, lang):
    lines = validation_lines(lang)
    assert len(lines) == 50 and len(set(lines)) == 50
    lx = bible.lexicons[lang]
    banned = [term_regex(t) for t in lx.banned + bible.world.rule_terms.get(lang, [])
              + [t for c in bible.cultures.values() if c.language == lang for t in c.avoid_terms]]
    for line in lines:
        assert all(len(words(s)) <= lx.max_sentence_words for s in sentences(line))
        assert not any(rx.search(line) for rx in banned), line
    assert any(l.endswith("?") for l in lines) and any(l.endswith("!") for l in lines)


def test_every_dub_reference_has_a_passage(bible):
    for ch in bible.characters.values():
        assert set(ch.voice.refs) - {"en"} <= set(PASSAGES)


def test_the_blind_pick_leaves_out_broken_candidates(bible, tmp_path):
    scores = {f"training/cand_{i:02d}_p.wav": {"wer": 0.9 if i < 2 else 0.1 + i / 100, "seconds": 4.0} for i in range(20)}
    ctx = ctx_for(bible, tmp_path, "ch_01/voice/pick", {"ch_01/voice/score": {"scores": scores}})
    assert pick_auto(ctx) == {"chosen": "training/cand_02_p.wav", "seed": 2}
    r = pick_review(ctx)
    assert len(r["labels"]) == 18 and r["hidden"] == 2 and set(r["labels"].values()) <= set(scores)


def test_install_refuses_a_lora_below_the_bar(bible, tmp_path):
    ctx = ctx_for(bible, tmp_path, "ch_01/look/install", {"ch_01/look/eval_pick": {"epoch": "e.safetensors", "correct": 21}})
    with pytest.raises(NeedsAction, match="21/32"):
        install(ctx)
    lora = tmp_path / "training/look/loras/kiko_v2-000007.safetensors"
    lora.parent.mkdir(parents=True)
    lora.write_bytes(b"weights")
    ctx = ctx_for(bible, tmp_path, "ch_01/look/install",
                  {"ch_01/look/eval_pick": {"epoch": "training/look/loras/kiko_v2-000007.safetensors", "correct": 30}})
    out = install(ctx)
    assert (tmp_path / out["lora"]).read_bytes() == b"weights" and out["lora"] == bible.characters["ch_01"].assets.lora


def _secs(p):
    with wave.open(str(p)) as w:
        return w.getnframes() / w.getframerate()


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_the_reference_is_joined_trimmed_and_capped(tmp_path):
    parts = []
    for i, hz in enumerate((300, 400, 500, 600)):
        p = tmp_path / f"p{i}.wav"
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={hz}:duration=3:sample_rate={22050 + i * 1000}",
                        "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-filter_complex",
                        "[1]atrim=0:1.5[s];[0][s]concat=n=2:v=0:a=1", str(p)], check=True)
        parts.append(p)
    out = tmp_path / "ref.wav"
    subprocess.run(reference_argv(parts, out), check=True, capture_output=True)
    assert 12 <= _secs(out) <= 15.0 + 1e-3    # 4 x 3 s of voice, pauses cut to 0.25 s, at most 15 s
    subprocess.run(reference_argv(parts[:2], out), check=True, capture_output=True)
    assert _secs(out) < 2 * 4.5 - 1           # the 1.5 s pauses are shortened


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_the_pitch_shift_really_runs(tmp_path):
    src, dst = tmp_path / "c.wav", tmp_path / "c_p.wav"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", str(src)], check=True)
    p = subprocess.run(pitch_argv(src, dst, 3), capture_output=True, text=True)
    if "No such filter" in p.stderr:
        pytest.skip("this ffmpeg has no rubberband")
    assert p.returncode == 0, p.stderr[-500:]
    with wave.open(str(dst)) as w:
        assert w.getframerate() == 24000
