from __future__ import annotations

from imagegen import natural_rgb
from PIL import Image, ImageEnhance, ImageOps

from quality_guard.checks.similarity import check_similarity, phash
from quality_guard.checks.vector import check_vector
from quality_guard.config import Config
from quality_guard.findings import FileReport, Level


def hashed(name: str, img: Image.Image) -> FileReport:
    report = FileReport(path=name, name=name, kind="jpeg", size_bytes=0, width=img.width, height=img.height)
    report.phash, report.phash_mirror = phash(img)
    return report


def test_near_duplicates_and_mirrors_are_caught(photo):
    reports = [
        hashed("a.jpg", photo),
        hashed("a-copy.jpg", ImageEnhance.Brightness(photo).enhance(1.1)),
        hashed("a-flipped.jpg", ImageOps.mirror(photo)),
        hashed("other.jpg", Image.fromarray(natural_rgb(900, 1200, seed=7))),
    ]
    check_similarity(reports, Config())
    flagged = {r.name for r in reports if any(f.rule == "similar.duplicate" for f in r.findings)}
    assert len(flagged) == 2
    assert "other.jpg" not in flagged
    assert all(f.level == Level.REVIEW for r in reports for f in r.findings)


def test_series_beyond_three_goes_to_review(photo):
    base = photo.resize((1200, 900))
    variants = [ImageEnhance.Contrast(base).enhance(1 + 0.08 * i).rotate(i * 0.6) for i in range(5)]
    config = Config()
    config.similarity.near_duplicate_distance = 0
    reports = [hashed(f"s{i}.jpg", v) for i, v in enumerate(variants)]
    check_similarity(reports, config)
    series = [r for r in reports if any(f.rule == "similar.series" for f in r.findings)]
    assert len(series) == 2


def test_different_images_are_left_alone():
    reports = [hashed(f"{i}.jpg", Image.fromarray(natural_rgb(600, 800, seed=i))) for i in range(6)]
    check_similarity(reports, Config())
    assert all(r.findings == [] for r in reports)


def vector_report(kind: str, data: bytes) -> FileReport:
    report = FileReport(path="x", name=f"x.{kind}", kind=kind, size_bytes=len(data))
    check_vector(report, data, Config())
    return report


def svg(width: str, height: str, body: str = "<rect width='10' height='10'/>") -> bytes:
    return f"<svg xmlns='http://www.w3.org/2000/svg' width='{width}' height='{height}'>{body}</svg>".encode()


def test_svg_artboard_and_live_text():
    assert vector_report("svg", svg("5000", "3000")).findings == []
    small = vector_report("svg", svg("1000px", "800px"))
    assert {f.rule: f.level for f in small.findings} == {"tech.vector_small": Level.REJECT}
    texty = vector_report("svg", svg("5000", "3000", "<text>Hello</text>"))
    assert {f.rule for f in texty.findings} == {"vector.live_text"}
    viewbox = b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 6000 4000'></svg>"
    assert vector_report("svg", viewbox).megapixels == 24.0


def test_eps_bounding_box_and_fonts():
    eps = b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 1200 800\n%%DocumentFonts: Helvetica\n"
    r = {f.rule for f in vector_report("eps", eps).findings}
    assert r == {"tech.vector_small", "vector.live_text"}
    big = b"%!PS-Adobe-3.0 EPSF-3.0\n%%HiResBoundingBox: 0 0 5000.5 3000\n%%DocumentFonts: (atend)\n"
    assert vector_report("eps", big).findings == []


def test_ai_file_reads_pdf_mediabox():
    ai = b"%PDF-1.6\n1 0 obj << /Type /Page /MediaBox [0 0 5000 3200] >> endobj\n"
    assert vector_report("ai", ai).findings == []
    unknown = vector_report("ai", b"%PDF-1.6\nstream compressed...")
    assert {f.rule for f in unknown.findings} == {"tech.vector_size_unknown"}
