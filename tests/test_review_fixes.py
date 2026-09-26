"""Regression tests for the issues found in the code review."""

from __future__ import annotations

import struct

import numpy as np
import pytest
from PIL import Image

from quality_guard.checks.metadata import Blocklist
from quality_guard.checks.similarity import check_similarity, phash
from quality_guard.checks.vector import check_vector
from quality_guard.config import Config, ConfigError, load_config
from quality_guard.findings import FileReport, Level, Verdict
from quality_guard.hardware import Hardware
from quality_guard.icc import parse_icc
from quality_guard.pipeline import exclusions
from quality_guard.scanner import analyze_file, collect_files, scan
from quality_guard.sorter import sort_files

BLOCKLIST = Blocklist.load()


def icc_with_primaries(description: str, primaries) -> bytes:
    text = description.encode("ascii") + b"\0"
    tags = [(b"desc", b"desc" + b"\0" * 4 + struct.pack(">I", len(text)) + text)]
    for sig, xyz in zip((b"rXYZ", b"gXYZ", b"bXYZ"), primaries, strict=True):
        tags.append((sig, b"XYZ " + b"\0" * 4 + struct.pack(">iii", *(round(v * 65536) for v in xyz))))
    offset = 128 + 4 + 12 * len(tags)
    table, body = b"", b""
    for sig, data in tags:
        table += struct.pack(">4sII", sig, offset + len(body), len(data))
        body += data
    header = bytearray(128)
    header[16:20] = b"RGB "
    data = bytes(header) + struct.pack(">I", len(tags)) + table + body
    return struct.pack(">I", len(data)) + data[4:]


SRGB = ((0.4361, 0.2225, 0.0139), (0.3851, 0.7169, 0.0971), (0.1431, 0.0606, 0.7141))
P3 = ((0.5151, 0.2412, -0.0011), (0.2920, 0.6922, 0.0419), (0.1571, 0.0666, 0.7841))
ODD = ((0.5, 0.25, 0.02), (0.3, 0.7, 0.1), (0.15, 0.05, 0.75))


def color_rules(tmp_path, photo, profile: bytes) -> dict[str, Level]:
    photo.save(tmp_path / "c.jpg", quality=95, icc_profile=profile)
    report = analyze_file(tmp_path / "c.jpg", Config(), None, BLOCKLIST)
    return {f.rule: f.level for f in report.findings if f.rule.startswith("tech.color")}


def test_color_profile_is_judged_by_its_primaries(tmp_path, photo):
    assert parse_icc(icc_with_primaries("c2", SRGB)).is_srgb
    assert color_rules(tmp_path, photo, icc_with_primaries("c2", SRGB)) == {}
    assert color_rules(tmp_path, photo, icc_with_primaries("My monitor", P3)) == {"tech.color_space": Level.REJECT}
    assert color_rules(tmp_path, photo, icc_with_primaries("Calibrated", ODD)) == {
        "tech.color_space_unknown": Level.REVIEW}


def test_checkerboard_inside_a_real_cutout_only_needs_review(tmp_path):
    ys, xs = np.indices((1800, 2400))
    board = np.where(((ys // 16 + xs // 16) % 2)[..., None] == 0, 255, 204).astype(np.uint8).repeat(3, axis=2)
    rgba = np.dstack([board, np.full((1800, 2400), 255, np.uint8)])
    rgba[600:1200, 800:1600, 3] = 0  # a real transparent hole in the middle
    Image.fromarray(rgba, "RGBA").save(tmp_path / "tiles.png")
    report = analyze_file(tmp_path / "tiles.png", Config(), None, BLOCKLIST)
    assert {f.rule: f.level for f in report.findings}.get("tech.fake_transparency") == Level.REVIEW


def test_eps_fonts_are_checked_even_without_a_bounding_box():
    report = FileReport(path="x", name="x.eps", kind="eps", size_bytes=10)
    check_vector(report, b"%!PS-Adobe-3.0 EPSF-3.0\n%%DocumentFonts: Helvetica\n", Config())
    assert {f.rule for f in report.findings} == {"vector.live_text", "tech.vector_size_unknown"}


def test_ai_file_with_compressed_page_dictionary():
    import zlib

    body = zlib.compress(b"<< /Type /Page /MediaBox [0 0 6000 4000] >>")
    data = b"%PDF-1.6\n5 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n" + body + b"\nendstream\n"
    report = FileReport(path="x", name="x.ai", kind="ai", size_bytes=len(data))
    check_vector(report, data, Config())
    assert (report.width, report.height) == (6000, 4000)
    assert report.findings == []


def test_missing_extra_blocklist_is_a_config_error(tmp_path):
    cfg = tmp_path / "c.toml"
    cfg.write_text('[metadata]\nextra_blocklist = "brands.txt"\n', encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(cfg)
    (tmp_path / "brands.txt").write_text("[custom]\nacme\n", encoding="utf-8")
    assert load_config(cfg).metadata.extra_blocklist == "brands.txt"


def test_output_inside_the_input_folder_does_not_hide_the_images(tmp_path, photo):
    photo.save(tmp_path / "a.jpg", quality=90)
    (tmp_path / "pass").mkdir()
    photo.save(tmp_path / "pass" / "old-copy.jpg", quality=90)
    files = collect_files(tmp_path, recursive=True, exclude=exclusions(tmp_path, tmp_path))
    assert [f.name for f in files] == ["a.jpg"]


def test_csv_names_match_renamed_copies(tmp_path, photo):
    for sub in ("a", "b"):
        (tmp_path / "in" / sub).mkdir(parents=True)
        photo.save(tmp_path / "in" / sub / "IMG_1.jpg", quality=95)
    (tmp_path / "in" / "meta.csv").write_text(
        'Filename,Title,Keywords,Category,Releases\nIMG_1.jpg,Shapes,"abstract, shapes, color, art, pattern",8,\n',
        encoding="utf-8")
    config = Config()
    config.local_ai.enabled = False
    result = scan(tmp_path / "in", config, recursive=True, csv_path=tmp_path / "in" / "meta.csv", jobs=1)
    for r in result.reports:  # the twins are near-duplicates; force both into the same pile
        r.override = Verdict.PASS
    sort_files(result, tmp_path / "out")
    rows = (tmp_path / "out" / "pass" / "adobe-stock-metadata.csv").read_text(encoding="utf-8").splitlines()
    assert sorted(line.split(",")[0] for line in rows[1:]) == ["IMG_1 (2).jpg", "IMG_1.jpg"]


def test_vectorized_similarity_matches_bruteforce():
    rng = np.random.default_rng(3)
    reports = []
    base = rng.integers(0, 255, (64, 64, 3), dtype=np.uint8)
    for i in range(40):
        noisy = np.clip(base.astype(int) + rng.integers(-40, 40, base.shape) * (i % 3), 0, 255).astype(np.uint8)
        img = Image.fromarray(noisy if i < 20 else rng.integers(0, 255, (64, 64, 3), dtype=np.uint8))
        r = FileReport(path=str(i), name=f"{i:02}.jpg", kind="jpeg", size_bytes=0)
        r.phash, r.phash_mirror = phash(img)
        reports.append(r)
    check_similarity(reports, Config())
    flagged = {r.name for r in reports if r.findings}
    assert flagged and all(int(n[:2]) < 20 for n in flagged)


@pytest.mark.parametrize(("cores", "ram", "jobs"), [(16, 64, 15), (8, 8, 5), (4, 16, 3), (2, 0, 1), (64, 256, 32)])
def test_worker_count_follows_cores_and_memory(cores, ram, jobs):
    assert Hardware(cores=cores, ram_gb=ram, gpu="", gpu_ram_gb=0).auto_jobs() == jobs


def test_override_changes_the_verdict():
    r = FileReport(path="x", name="x.jpg", kind="jpeg", size_bytes=0)
    r.add("quality.soft", "quality", Level.REJECT, "soft")
    assert r.verdict == Verdict.REJECT
    r.override = Verdict.PASS
    assert r.verdict == Verdict.PASS and r.computed_verdict == Verdict.REJECT


def test_exif_rotated_photo_thumbnail_is_upright(tmp_path, photo):
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise for display
    photo.save(tmp_path / "r.jpg", quality=90, exif=exif)
    report = analyze_file(tmp_path / "r.jpg", Config(), None, BLOCKLIST)
    import io

    thumb = Image.open(io.BytesIO(report.thumbnail))
    assert thumb.height > thumb.width
