from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from quality_guard.checks.quality import check_borders, check_exposure, check_quality
from quality_guard.config import Config
from quality_guard.findings import FileReport, Level


def run_quality(img: Image.Image) -> FileReport:
    report = FileReport(path="x", name="x.jpg", kind="jpeg", size_bytes=0)
    check_quality(report, np.asarray(img.convert("L")), Config())
    return report


def levels(report: FileReport, rule: str) -> set[Level]:
    return {f.level for f in report.findings if f.rule == rule}


def test_sharp_photo_has_no_quality_findings(photo):
    report = run_quality(photo)
    assert report.findings == []
    assert report.metrics["sharpness"] > 0.9


def test_heavy_blur_is_rejected(photo):
    report = run_quality(photo.filter(ImageFilter.GaussianBlur(3)))
    assert levels(report, "quality.soft") == {Level.REJECT}


def test_three_times_upscale_is_flagged(photo):
    small = photo.resize((600, 450), Image.Resampling.LANCZOS)
    report = run_quality(small.resize(photo.size, Image.Resampling.BICUBIC))
    assert levels(report, "quality.soft"), report.metrics


def test_mild_blur_goes_to_review_not_reject(photo):
    report = run_quality(photo.filter(ImageFilter.GaussianBlur(1.6)))
    assert levels(report, "quality.soft") == {Level.REVIEW}


def smooth_scene() -> Image.Image:
    """A sky-like gradient with a detailed subject, so noise shows in flat areas."""
    h, w = 1800, 2400
    y = np.linspace(90, 200, h)[:, None].repeat(w, axis=1)
    rgb = np.stack([y * 0.6, y * 0.8, y], axis=-1)
    img = Image.fromarray(rgb.astype(np.uint8))
    draw = ImageDraw.Draw(img)
    for i in range(0, 900, 30):
        draw.line((800 + i, 900, 800 + i, 1700), fill=(20, 20, 20), width=6)
    return img


def add_noise(img: Image.Image, sigma: float) -> Image.Image:
    a = np.asarray(img).astype(np.float32)
    rng = np.random.default_rng(1)
    return Image.fromarray(np.clip(a + rng.normal(0, sigma, a.shape), 0, 255).astype(np.uint8))


def test_noise_levels():
    clean = run_quality(add_noise(smooth_scene(), 1.5))
    assert not levels(clean, "quality.noise")
    assert clean.metrics["noise"] < 1.5
    # Per-channel sigma 8 is about 5.4 in luminance; 16 is about 10.7.
    assert levels(run_quality(add_noise(smooth_scene(), 8)), "quality.noise") == {Level.REVIEW}
    assert levels(run_quality(add_noise(smooth_scene(), 16)), "quality.noise") == {Level.REJECT}


def test_noise_does_not_look_like_sharpness_loss(photo):
    report = run_quality(add_noise(photo, 6))
    assert "quality.soft" not in {f.rule for f in report.findings}


def exposure_report(rgb: np.ndarray) -> FileReport:
    report = FileReport(path="x", name="x.jpg", kind="jpeg", size_bytes=0)
    check_exposure(report, rgb, Config())
    return report


def test_blown_highlights_flagged_but_white_studio_background_is_fine(photo):
    blown = np.asarray(photo.resize((1200, 900))).copy()
    blown[150:750, 200:1000] = 255
    assert {f.rule for f in exposure_report(blown).findings} == {"quality.highlights"}

    studio = np.full((900, 1200, 3), 255, np.uint8)
    studio[250:650, 400:800] = np.asarray(photo.resize((400, 400)))
    assert exposure_report(studio).findings == []


def border_report(img: Image.Image) -> FileReport:
    report = FileReport(path="x", name="x.jpg", kind="jpeg", size_bytes=0)
    check_borders(report, np.asarray(img.resize((1200, 900))))
    return report


def test_added_frame_and_letterbox_flagged(photo):
    framed = Image.new("RGB", (2480, 1880), (255, 255, 255))
    framed.paste(photo, (40, 40))
    assert {f.rule for f in border_report(framed).findings} == {"overlay.border"}

    letterbox = photo.copy()
    ImageDraw.Draw(letterbox).rectangle((0, 0, 2400, 120), fill=(0, 0, 0))
    ImageDraw.Draw(letterbox).rectangle((0, 1680, 2400, 1800), fill=(0, 0, 0))
    assert {f.rule for f in border_report(letterbox).findings} == {"overlay.border"}


def test_sky_gradient_is_not_a_frame():
    assert border_report(smooth_scene()).findings == []
    assert border_report(smooth_scene().rotate(180)).findings == []
