import math
import shutil
import struct
import subprocess
import wave

import pytest

from studio.lipsync import rms_per_frame, wav_info, wav_seconds
from studio.voice import speak_line
from studio.voice_quality import (LINE_LUFS, OUT_RATE, ROUNDS, TAKES, defects, expected_seconds, finish_line, match_names,
                                  pitch_filter, voice_clashes)

FFMPEG = shutil.which("ffmpeg")
NAMES = ["Kiko", "Beni", "Tuka", "Mira", "Zuzu", "Nilo"]


def write(path, pieces, sr=24000):
    """pieces: (seconds, hz, amplitude); hz 0 is silence. A voice-like tone with harmonics."""
    frames = bytearray()
    for secs, hz, amp in pieces:
        for i in range(int(secs * sr)):
            t = i / sr
            v = 0.0 if not hz else amp * (math.sin(2 * math.pi * hz * t) + 0.5 * math.sin(4 * math.pi * hz * t)
                                          + 0.25 * math.sin(6 * math.pi * hz * t)) / 1.75
            frames += struct.pack("<h", max(-32767, min(32767, int(v * 32767))))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(frames))
    return path


def test_pitch_moves_the_formants_only_part_of_the_way():
    f = pitch_filter(5)
    assert f.count("rubberband") == 2 and "pitchq=quality" in f
    assert pitch_filter(0) == "anull"


def test_names_are_matched_by_sound_not_by_spelling():
    assert match_names("Zoo zoo, look! Keeko and Benny.", NAMES) == "zuzu look kiko and beni"
    assert match_names("the mirror by the zoo, take a look", NAMES) == "the mirror by the zoo take a look"


def test_a_clean_take_has_no_defects(tmp_path):
    text = "Look at the red ball!"
    want = expected_seconds(text, "en", "fast")
    p = write(tmp_path / "ok.wav", [(0.1, 0, 0), (want, 220, 0.5), (0.25, 0, 0)])
    assert defects(p, text, "en", "fast") == []


@pytest.mark.parametrize("pieces, found", [
    ([(0.1, 0, 0), (0.6, 220, 0.5), (1.0, 0, 0), (0.6, 220, 0.5), (0.2, 0, 0)], "gap inside"),
    ([(0.1, 0, 0), (1.2, 220, 1.4), (0.2, 0, 0)], "clipping"),
    ([(0.1, 0, 0), (1.2, 220, 0.5)], "cut off"),
    ([(0.1, 0, 0), (0.3, 220, 0.5), (0.2, 0, 0)], "skipped or invented"),
    ([(0.1, 0, 0), (4.0, 220, 0.5), (0.2, 0, 0)], "skipped or invented"),
    ([(1.5, 0, 0)], "silent"),
])
def test_measurable_defects_are_named(tmp_path, pieces, found):
    p = write(tmp_path / "bad.wav", pieces)
    assert any(found in d for d in defects(p, "Look at the red ball!", "en", "fast")), defects(p, "Look at the red ball!", "en", "fast")


class Script:
    """A fake voice: the n-th take of each line has the similarity and defects given."""

    def __init__(self, sims, flaws=()):
        self.sims, self.flaws, self.seen = sims, dict(flaws), []

    def synth(self, text, lang, ref, ex, cfg, seed, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text)
        self.seen.append(seed)
        return 1.5

    def similarity(self, ref, wav):
        return self.sims[len(self.seen) - 1]

    def check(self, path, text, lang, pace):
        return self.flaws.get(len(self.seen) - 1, [])


def test_the_best_take_wins(tmp_path, bible):
    kiko = bible.characters["ch_01"]
    s = Script([0.62, 0.86, 0.91], flaws={1: ["a 0.9s gap inside the line"]})
    r = speak_line("l_001", "Hi, friends!", "en", kiko, tmp_path / "ref.wav", tmp_path / "ref.wav", tmp_path / "l_001.wav",
                   s.synth, s.similarity, lambda p, l: p.read_text(), 1000, NAMES, s.check, finish=None)
    assert r.passed and r.seed == 1002 and r.takes == TAKES and r.similarity == 0.91


def test_a_line_that_never_passes_goes_to_a_person_with_its_best_take(tmp_path, bible):
    kiko = bible.characters["ch_01"]
    sims = [0.60, 0.70, 0.66, 0.72, 0.64, 0.68]
    s = Script(sims)
    enhanced = []

    def enhance(src, dst):
        enhanced.append(src)
        shutil.copy(src, dst)
        return dst

    r = speak_line("l_002", "Wait, Zuzu!", "en", kiko, tmp_path / "r.wav", tmp_path / "r.wav", tmp_path / "l_002.wav",
                   s.synth, s.similarity, lambda p, l: "wait zoo zoo", 1000, NAMES, s.check, finish=None, enhance=enhance)
    assert not r.passed and r.takes == TAKES * ROUNDS and r.similarity == 0.72 and r.wer == 0.0
    assert enhanced and enhanced[0].name == "l_002_t1003.wav"


def test_voices_too_close_are_reported():
    clash = voice_clashes({"Beni": (310.0, "slow"), "Mira": (330.0, "slow"), "Kiko": (320.0, "fast")})
    assert len(clash) == 1 and "Beni and Mira" in clash[0]


np = pytest.importorskip("numpy")


def test_pitch_is_measured(tmp_path):
    from studio.voice_quality import f0_median
    for hz in (180, 260, 340):
        p = write(tmp_path / f"t{hz}.wav", [(0.2, 0, 0), (1.5, hz, 0.5), (0.2, 0, 0)])
        assert f0_median(p) == pytest.approx(hz, rel=0.03)
    assert f0_median(write(tmp_path / "s.wav", [(1.0, 0, 0)])) is None


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_the_two_stage_pitch_shift_lands_on_the_right_pitch(tmp_path):
    from studio.voice import pitch_argv
    from studio.voice_quality import f0_median
    src = write(tmp_path / "c.wav", [(0.2, 0, 0), (2.0, 200, 0.5), (0.2, 0, 0)])
    dst = tmp_path / "c_p.wav"
    subprocess.run(pitch_argv(src, dst, 4), check=True, capture_output=True)
    assert f0_median(dst) == pytest.approx(200 * 2 ** (4 / 12), rel=0.04)


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_every_finished_line_is_studio_format_at_the_same_loudness(tmp_path):
    from studio.media.mix import parse_loudnorm
    from studio.voice_quality import measure_argv
    quiet = write(tmp_path / "quiet.wav", [(0.5, 0, 0), (1.5, 240, 0.05), (0.6, 0, 0)])
    loud = write(tmp_path / "loud.wav", [(0.2, 0, 0), (1.5, 240, 0.8), (0.2, 0, 0)])
    levels = []
    for src in (quiet, loud):
        out = finish_line(src, tmp_path / f"{src.stem}_final.wav")
        sr, width, _, _ = wav_info(out)
        assert sr == OUT_RATE and width == 3
        secs = wav_seconds(out)
        assert 1.5 < secs < 1.8  # the long silences are trimmed, a short margin kept
        levels.append(parse_loudnorm(subprocess.run(measure_argv(out), capture_output=True, text=True).stderr)["input_i"])
    assert all(abs(l - LINE_LUFS) < 1.5 for l in levels) and abs(levels[0] - levels[1]) < 1.0


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_24_bit_files_written_by_ffmpeg_can_be_read_back(tmp_path):
    src = write(tmp_path / "a.wav", [(1.0, 300, 0.5)])
    out = tmp_path / "b.wav"
    subprocess.run([FFMPEG, "-v", "error", "-i", str(src), "-ar", "48000", "-c:a", "pcm_s24le", str(out)], check=True)
    assert out.read_bytes()[20:22] == b"\xfe\xff"      # WAVE_FORMAT_EXTENSIBLE, what Python 3.11's wave refuses
    assert wav_seconds(out) == pytest.approx(1.0, abs=0.01)
    assert len(rms_per_frame(out, 24)) == 24


def test_short_lines_and_written_pauses_are_not_defects(tmp_path):
    oops = write(tmp_path / "oops.wav", [(0.1, 0, 0), (0.45, 260, 0.5), (0.2, 0, 0)])
    assert defects(oops, "Oops!", "en", "fast") == []
    wait = write(tmp_path / "wait.wav", [(0.1, 0, 0), (0.5, 220, 0.5), (0.9, 0, 0), (0.7, 220, 0.5), (0.2, 0, 0)])
    assert defects(wait, "Wait… let's think.", "en", "slow") == []
    assert any("gap" in d for d in defects(wait, "Wait let's think", "en", "slow"))
