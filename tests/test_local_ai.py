"""The local detectors, run for real when EasyOCR / OpenCV are installed (CPU is fine, just slower)."""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont

from quality_guard.checks.metadata import Blocklist
from quality_guard.config import Config
from quality_guard.findings import FileReport, Level, Metadata

pytest.importorskip("easyocr")
pytest.importorskip("cv2")
skimage_data = pytest.importorskip("skimage.data")

from quality_guard.checks.local_ai import LocalAI  # noqa: E402


@pytest.fixture(scope="module")
def detector():
    return LocalAI(Config(), Blocklist.load(), use_gpu=False)


def report_for(path, **meta) -> FileReport:
    r = FileReport(path=str(path), name=path.name, kind="jpeg", size_bytes=0)
    r.metadata = Metadata(**meta)
    return r


def test_reads_brand_names_and_date_stamps(tmp_path, detector):
    img = Image.new("RGB", (2400, 1600), (70, 110, 160))
    draw = ImageDraw.Draw(img)
    draw.text((300, 500), "NIKE STORE", fill="white", font=ImageFont.load_default(size=160))
    draw.text((1850, 1500), "2023-08-14", fill=(250, 200, 60), font=ImageFont.load_default(size=56))
    img.save(tmp_path / "t.jpg", quality=95)
    report = report_for(tmp_path / "t.jpg")
    detector.analyze(tmp_path / "t.jpg", report)
    rules = {f.rule: f.level for f in report.findings}
    assert rules.get("local.text_brand") == Level.REVIEW
    assert rules.get("local.date_stamp") == Level.REVIEW
    assert report.local_checked


def test_faces_need_a_release_unless_listed_or_generated(tmp_path, detector):
    Image.fromarray(skimage_data.astronaut()).resize((1536, 1536)).save(tmp_path / "p.jpg", quality=95)
    photo = report_for(tmp_path / "p.jpg")
    detector.analyze(tmp_path / "p.jpg", photo)
    assert {f.rule: f.level for f in photo.findings}.get("local.faces") == Level.REVIEW

    released = report_for(tmp_path / "p.jpg", releases="release.pdf")
    detector.analyze(tmp_path / "p.jpg", released)
    assert not [f for f in released.findings if f.level > Level.INFO]

    generated = report_for(tmp_path / "p.jpg", ai_generated=True)
    detector.analyze(tmp_path / "p.jpg", generated)
    assert {f.rule: f.level for f in generated.findings}.get("local.faces_ai") == Level.INFO
