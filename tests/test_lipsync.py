import math
import struct
import wave

from studio.lipsync import Cue, clean, emphasis, keys, parse_tsv, rhubarb_argv, rms_per_frame, silences

# the example in the training lab, "Let's find out!"
TSV = "0.00\tX\n0.07\tH\n0.16\tC\n0.30\tB\n0.52\tG\n0.64\tD\n0.90\tE\n1.22\tX\n"


def test_parse_the_rhubarb_table():
    cues = parse_tsv(TSV)
    assert cues[1] == Cue(0.07, "H") and cues[-1] == Cue(1.22, "X")


def test_bad_rows_are_errors():
    import pytest
    with pytest.raises(ValueError, match="unknown mouth shape"):
        parse_tsv("0.00\tQ\n")
    with pytest.raises(ValueError, match="backwards"):
        parse_tsv("0.50\tA\n0.20\tB\n")


def test_keys_are_offset_by_the_line_start_in_the_shot():
    # the line starts at 2.4 s in shot sh_014: X at 2.40, H at 2.47 ...
    k = dict(keys(parse_tsv(TSV), 24, 2.4))
    assert k[round(2.40 * 24)] == "X" and k[round(2.47 * 24)] == "H" and k[round(3.62 * 24)] == "X"


def test_shapes_shorter_than_two_frames_are_merged():
    cues = [Cue(0.0, "X"), Cue(0.10, "B"), Cue(0.13, "C"), Cue(0.40, "D"), Cue(0.80, "X")]
    out = clean(cues, 24)
    assert "B" not in [c.shape for c in out]  # 0.03 s = less than one frame
    assert out[-1] == Cue(0.80, "X")
    durations = [b.t - a.t for a, b in zip(out, out[1:])]
    assert min(durations) >= 2 / 24 - 1e-9


def test_every_silence_over_a_fifth_of_a_second_closes_the_mouth():
    cues = [Cue(0.0, "C"), Cue(0.5, "D"), Cue(1.5, "X")]
    out = clean(cues, 24, [(0.6, 1.0)])
    assert Cue(0.6, "X") in out and Cue(1.0, "D") in out


def write_wav(path, seconds, loud_ranges, sr=16000):
    frames = []
    for i in range(int(seconds * sr)):
        t = i / sr
        amp = 0.6 if any(a <= t < b for a, b in loud_ranges) else 0.0005
        frames.append(struct.pack("<h", int(amp * 32767 * math.sin(2 * math.pi * 220 * t))))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(frames))


def test_silences_are_found_in_the_audio(tmp_path):
    p = tmp_path / "line.wav"
    write_wav(p, 1.5, [(0.0, 0.5), (0.9, 1.5)])
    rms = rms_per_frame(p, 24)
    assert len(rms) == 36
    (a, b), = silences(rms, 24)
    assert abs(a - 0.5) < 0.05 and abs(b - 0.9) < 0.05


def test_the_head_turns_on_loud_peaks_alternating_sides():
    rms = [0.1] * 48
    for i in (6, 20, 34):
        rms[i] = 0.9
    k = emphasis(rms, 24, 2.4)
    turns = [d for _, d in k if d]
    assert turns == [2.0, -2.0, 2.0]
    assert k[0][0] == round(2.4 * 24) + 6


def test_english_uses_the_dialog_other_languages_the_phonetic_recogniser(tmp_path):
    en = rhubarb_argv(tmp_path / "a.wav", tmp_path / "a.tsv", "en", tmp_path / "a.txt")
    es = rhubarb_argv(tmp_path / "a.wav", tmp_path / "a.tsv", "es")
    assert "-d" in en and "phonetic" not in en
    assert es[es.index("-r") + 1] == "phonetic" and "--extendedShapes" in es
