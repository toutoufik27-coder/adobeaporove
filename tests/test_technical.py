from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageCms, ImageDraw

from quality_guard.checks.metadata import Blocklist
from quality_guard.config import Config
from quality_guard.findings import Level, Verdict
from quality_guard.icc import parse_icc
from quality_guard.scanner import analyze_file

BLOCKLIST = Blocklist.load()


def analyze(path: Path, config: Config | None = None):
    return analyze_file(path, config or Config(), None, BLOCKLIST)


def rules(report, level: Level | None = None) -> set[str]:
    return {f.rule for f in report.findings if level is None or f.level == level}


def fake_icc(description: str, color_space: bytes = b"RGB ") -> bytes:
    text = description.encode("ascii") + b"\0"
    tag = b"desc" + b"\0" * 4 + struct.pack(">I", len(text)) + text
    offset = 128 + 4 + 12
    header = bytearray(128)
    header[16:20] = color_space
    header[36:40] = b"acsp"
    body = struct.pack(">I", 1) + struct.pack(">4sII", b"desc", offset, len(tag)) + tag
    data = bytes(header) + body
    return struct.pack(">I", len(data)) + data[4:]


def test_clean_photo_passes(tmp_path, photo):
    photo.save(tmp_path / "good.jpg", quality=95)
    report = analyze(tmp_path / "good.jpg")
    assert report.verdict == Verdict.PASS, report.findings
    assert report.metrics["sharpness"] > 0.7
    assert report.metrics["jpeg_quality"] >= 90


def test_srgb_profile_passes_and_adobe_rgb_is_rejected(tmp_path, photo):
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    photo.save(tmp_path / "srgb.jpg", quality=95, icc_profile=srgb)
    assert "tech.color_space" not in rules(analyze(tmp_path / "srgb.jpg"))

    photo.save(tmp_path / "adobe.jpg", quality=95, icc_profile=fake_icc("Adobe RGB (1998)"))
    report = analyze(tmp_path / "adobe.jpg")
    assert "tech.color_space" in rules(report, Level.REJECT)
    assert report.verdict == Verdict.REJECT


def test_icc_parser_reads_v2_description():
    info = parse_icc(fake_icc("sRGB IEC61966-2.1"))
    assert info is not None and info.is_srgb and info.color_space == "RGB"
    assert parse_icc(fake_icc("ProPhoto RGB")).family == "ProPhoto RGB"


def test_cmyk_rejected(tmp_path, photo):
    photo.convert("CMYK").save(tmp_path / "cmyk.jpg", quality=95)
    assert "tech.cmyk" in rules(analyze(tmp_path / "cmyk.jpg"), Level.REJECT)


def test_low_resolution_rejected(tmp_path, photo):
    photo.resize((1200, 900)).save(tmp_path / "small.jpg", quality=95)
    report = analyze(tmp_path / "small.jpg")
    assert "tech.resolution_low" in rules(report, Level.REJECT)


def test_file_size_limit(tmp_path, photo):
    config = Config()
    config.technical.max_file_mb = 0.1
    photo.save(tmp_path / "big.jpg", quality=95)
    assert "tech.file_size" in rules(analyze(tmp_path / "big.jpg", config), Level.REJECT)


@pytest.mark.parametrize(("quality", "level"), [(30, Level.REJECT), (65, Level.REVIEW)])
def test_jpeg_compression(tmp_path, photo, quality, level):
    photo.save(tmp_path / "q.jpg", quality=quality)
    report = analyze(tmp_path / "q.jpg")
    assert any(f.rule == "tech.jpeg_quality" and f.level == level for f in report.findings)


def test_wrong_extension_and_unsupported_format(tmp_path, photo):
    photo.save(tmp_path / "actually-png.jpg", format="PNG")
    assert "tech.mismatch" in rules(analyze(tmp_path / "actually-png.jpg"), Level.REJECT)
    photo.save(tmp_path / "photo.webp")
    assert "tech.format" in rules(analyze(tmp_path / "photo.webp"), Level.REJECT)


def test_truncated_file_rejected(tmp_path, photo):
    photo.save(tmp_path / "full.jpg", quality=95)
    data = (tmp_path / "full.jpg").read_bytes()
    (tmp_path / "cut.jpg").write_bytes(data[: len(data) // 2])
    assert "tech.corrupt" in rules(analyze(tmp_path / "cut.jpg"), Level.REJECT)


def cutout(size=(2400, 1800), box=(300, 200, 2100, 1600)) -> Image.Image:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse(box, fill=(200, 60, 40, 255))
    return img


def test_png_with_real_transparency_passes(tmp_path):
    cutout().save(tmp_path / "object.png")
    report = analyze(tmp_path / "object.png")
    assert not rules(report, Level.REJECT), report.findings


def test_png_without_transparency_rejected(tmp_path, photo):
    photo.save(tmp_path / "opaque.png")
    assert "tech.png_opaque" in rules(analyze(tmp_path / "opaque.png"), Level.REJECT)


def test_png_small_object_in_big_canvas_rejected(tmp_path):
    cutout(box=(1000, 800, 1400, 1100)).save(tmp_path / "tiny.png")
    assert "tech.png_margins" in rules(analyze(tmp_path / "tiny.png"), Level.REJECT)


def test_png_loose_crop_needs_review(tmp_path):
    cutout(box=(600, 150, 2300, 1650)).save(tmp_path / "loose.png")
    report = analyze(tmp_path / "loose.png")
    assert "tech.png_margins" in rules(report, Level.REVIEW)


def checkerboard(size=(2400, 1800), square=16) -> Image.Image:
    ys, xs = np.indices(size[::-1])
    board = ((ys // square + xs // square) % 2).astype(bool)
    rgb = np.where(board[..., None], 255, 204).astype(np.uint8).repeat(3, axis=2)
    img = Image.fromarray(rgb)
    ImageDraw.Draw(img).ellipse((500, 300, 1900, 1500), fill=(30, 120, 200))
    return img


def test_painted_checkerboard_rejected_in_png_and_flagged_in_jpeg(tmp_path):
    img = checkerboard()
    img.save(tmp_path / "fake.png")
    assert "tech.fake_transparency" in rules(analyze(tmp_path / "fake.png"), Level.REJECT)
    img.save(tmp_path / "fake.jpg", quality=97)
    assert "tech.fake_transparency" in rules(analyze(tmp_path / "fake.jpg"), Level.REVIEW)


def test_grayscale_needs_review(tmp_path, photo):
    photo.convert("L").save(tmp_path / "bw.jpg", quality=95)
    assert "tech.grayscale" in rules(analyze(tmp_path / "bw.jpg"), Level.REVIEW)


def test_oversized_image_rejected_from_header_without_decoding(tmp_path):
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    ihdr = struct.pack(">IIBBBBB", 12000, 9000, 8, 2, 0, 0, 0)  # 108 MP RGB, no pixel data
    (tmp_path / "huge.png").write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b""))
    report = analyze(tmp_path / "huge.png")
    assert rules(report) == {"tech.resolution_high"}
