import shutil
import subprocess
from pathlib import Path

import pytest

from studio.media.mix import (Clip, compose_argv, concat_list, loudnorm_apply_argv, loudnorm_measure_argv, mux_argv,
                              parse_loudnorm, shot_mix_argv)
from studio.media.probe import parse_scenes, parse_tiles, srgb_to_linear

LOUDNORM_OUT = """[Parsed_loudnorm_0 @ 0x55] 
{
\t"input_i" : "-22.47",
\t"input_tp" : "-4.10",
\t"input_lra" : "5.20",
\t"input_thresh" : "-32.80",
\t"output_i" : "-14.02",
\t"output_tp" : "-1.50",
\t"output_lra" : "4.90",
\t"output_thresh" : "-24.30",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.02"
}
"""


def graph(argv):
    return argv[argv.index("-filter_complex") + 1]


def test_voices_are_placed_at_their_times_and_music_ducks_under_them():
    argv = shot_mix_argv([Clip(Path("s14_l1.wav"), 2.4), Clip(Path("s14_l2.wav"), 4.1, tempo=1.05)],
                         Path("sh_014_es.wav"), 6.2, music=Path("music.wav"))
    g = graph(argv)
    assert "adelay=delays=2400:all=1" in g and "adelay=delays=4100:all=1" in g
    assert "atempo=1.050" in g
    assert "sidechaincompress=threshold=0.05:ratio=8" in g
    assert "loudnorm" not in g  # the episode is normalised once, not each shot
    assert g.endswith("apad,atrim=0:6.200[out]")
    assert argv[argv.index("-stream_loop") + 3] == "music.wav"


def test_a_shot_with_one_voice_and_no_music():
    g = graph(shot_mix_argv([Clip(Path("a.wav"), 0.6)], Path("o.wav"), 2.0))
    assert "[v0]anull[speech]" in g and "sidechain" not in g


def test_loudnorm_two_passes():
    m = parse_loudnorm("noise\n" + LOUDNORM_OUT)
    assert m["input_i"] == -22.47 and m["target_offset"] == 0.02
    af = loudnorm_apply_argv(Path("ep.wav"), Path("ep_norm.wav"), m)
    af = af[af.index("-af") + 1]
    assert "measured_I=-22.47" in af and "linear=true" in af and "I=-14.0" in af
    assert "print_format=json" in " ".join(loudnorm_measure_argv(Path("ep.wav")))
    with pytest.raises(ValueError):
        parse_loudnorm("no json here")


def test_one_picture_many_languages():
    argv = mux_argv(Path("v.mp4"), {"en": Path("en.wav"), "es": Path("es.wav")}, Path("out.mp4"))
    assert argv.count("-map") == 3
    assert "language=eng" in argv and "language=spa" in argv
    assert argv[argv.index("-disposition:a:0") + 1] == "default"


def test_the_mouth_layer_goes_over_the_body():
    g = graph(compose_argv(Path("body.mov"), Path("mouth_es.mov"), Path("o.mp4")))
    assert g.startswith("[0:v][1:v]overlay")


def test_concat_lists_quote_paths():
    assert concat_list([Path("a b.mp4"), Path("it's.mp4")]) == "file 'a b.mp4'\nfile 'it'\\''s.mp4'\n"


def test_probe_parsers():
    tiles = parse_tiles(bytes([0] * 9 + [255] * 9))
    assert tiles[0][0] == 0.0 and tiles[1][8] == pytest.approx(1.0)
    assert srgb_to_linear(0.5) == pytest.approx(0.214, abs=1e-3)
    with pytest.raises(ValueError):
        parse_tiles(b"\x00" * 10)
    assert parse_scenes("[Parsed_showinfo_1] n:0 pts:1 pts_time:4.2 x\n n:1 pts_time:9.75 ") == [4.2, 9.75]


FFMPEG = shutil.which("ffmpeg")


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_the_mix_really_runs_in_ffmpeg(tmp_path):
    def tone(name, seconds, hz):
        p = tmp_path / name
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={hz}:duration={seconds}", str(p)], check=True)
        return p
    v1, v2, music = tone("l1.wav", 1.3, 440), tone("l2.wav", 1.0, 660), tone("m.wav", 3.0, 220)
    out = tmp_path / "shot.wav"
    argv = shot_mix_argv([Clip(v1, 0.6), Clip(v2, 2.3, tempo=1.05)], out, 4.0, music=music)
    subprocess.run(argv, check=True, capture_output=True)
    m = parse_loudnorm(subprocess.run(loudnorm_measure_argv(out), capture_output=True, text=True).stderr)
    assert m["input_i"] < 0
    norm = tmp_path / "norm.wav"
    subprocess.run(loudnorm_apply_argv(out, norm, m), check=True, capture_output=True)
    m2 = parse_loudnorm(subprocess.run(loudnorm_measure_argv(norm), capture_output=True, text=True).stderr)
    assert abs(m2["input_i"] + 14) < 1.5


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_flashes_and_cuts_are_measured_from_a_real_video(tmp_path):
    from studio.gates.assembly import worst_flash_second
    from studio.media.probe import scenes_argv, tiles_argv
    flicker = tmp_path / "flicker.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=24:d=2", "-vf",
                    "geq=lum='if(mod(floor(T*10),2),235,16)':cb=128:cr=128,format=yuv420p", str(flicker)], check=True)
    tiles = parse_tiles(subprocess.run(tiles_argv(flicker, 24), capture_output=True, check=True).stdout)
    assert len(tiles) == 48
    assert worst_flash_second([t[4] for t in tiles], 24)[0] > 3

    cut = tmp_path / "cut.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x36:r=24:d=1", "-f", "lavfi", "-i",
                    "color=c=blue:s=64x36:r=24:d=1", "-filter_complex", "[0][1]concat=n=2:v=1[v]", "-map", "[v]",
                    "-pix_fmt", "yuv420p", str(cut)], check=True)
    stderr = subprocess.run(scenes_argv(cut), capture_output=True, text=True).stderr
    assert [round(t, 2) for t in parse_scenes(stderr)] == [1.0]


@pytest.mark.skipif(not FFMPEG, reason="ffmpeg is not installed")
def test_compose_and_mux_really_run(tmp_path):
    body, mouth, wav_en, wav_es = (tmp_path / n for n in ("body.mov", "mouth.mov", "en.wav", "es.wav"))
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=64x36:r=24:d=1", "-c:v", "qtrle", str(body)], check=True)
    subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=black@0.0:s=64x36:r=24:d=1,format=rgba",
                    "-c:v", "qtrle", str(mouth)], check=True)
    for p in (wav_en, wav_es):
        subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", str(p)], check=True)
    shot = tmp_path / "shot.mp4"
    subprocess.run(compose_argv(body, mouth, shot), check=True, capture_output=True)
    out = tmp_path / "ep.mp4"
    subprocess.run(mux_argv(shot, {"en": wav_en, "es": wav_es}, out), check=True, capture_output=True)
    info = subprocess.run([FFMPEG, "-hide_banner", "-i", str(out)], capture_output=True, text=True).stderr
    assert info.count("Audio: aac") == 2 and "(spa)" in info
