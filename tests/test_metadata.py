from __future__ import annotations

from PIL import Image, PngImagePlugin

from quality_guard.checks.metadata import Blocklist, check_metadata, normalize
from quality_guard.config import Config
from quality_guard.findings import FileReport, Level, Metadata
from quality_guard.metadata_io import find_adobe_csv, read_adobe_csv, read_embedded, read_head

BLOCKLIST = Blocklist.load()

XMP = """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
 Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Fresh lemons on a wooden table</rdf:li></rdf:Alt></dc:title>
<dc:subject><rdf:Bag><rdf:li>lemon</rdf:li><rdf:li>citrus</rdf:li><rdf:li>fruit</rdf:li></rdf:Bag></dc:subject>
</rdf:Description></rdf:RDF></x:xmpmeta>"""


def found(text: str) -> set[tuple[str, str]]:
    return set(BLOCKLIST.find(text))


def test_blocklist_matches_whole_names_only():
    assert found("Nike running shoes") == {("nike", "brand")}
    assert found("Coca Cola bottle") == {("coca cola", "brand")}
    assert found("burger from McDonald's") == {("mcdonalds", "brand")}
    assert found("two iPhones on a desk") == {("iphone", "brand")}
    assert found("painting in the style of Vincent van Gogh") == {("vincent van gogh", "artist")}
    assert found("fresh apple on a table, galaxy sky, windows") == set()
    assert found("portrait with rembrandt lighting") == set()
    assert found("rembrandt style portrait") == {("rembrandt", "artist")}
    assert found("sonyericsson") == set()


def test_normalize_strips_accents_and_punctuation():
    assert normalize("Nescafé — Crème-Brûlée!") == "nescafe creme brulee"


def report_with(title: str = "", keywords: list[str] | None = None, **meta) -> FileReport:
    report = FileReport(path="x", name="x.jpg", kind="jpeg", size_bytes=0)
    report.metadata = Metadata(title=title, keywords=keywords or [], **meta)
    check_metadata(report, Config(), BLOCKLIST)
    return report


def rules(report: FileReport) -> dict[str, Level]:
    return {f.rule: f.level for f in report.findings}


def test_clean_metadata_has_no_problems():
    report = report_with("Fresh lemons on a wooden kitchen table", ["lemon", "citrus", "fruit", "kitchen", "table", "fresh"])
    assert report.findings == []


def test_brand_in_keywords_is_rejected():
    report = report_with("Running shoes", ["shoes", "sport", "adidas", "run", "fitness"])
    assert rules(report)["meta.blocked.brand"] == Level.REJECT


def test_restricted_landmark_check_only_asks_for_review():
    report = report_with("Empire State Building at dusk", ["city", "skyline", "new york", "dusk", "tower"])
    assert rules(report)["meta.blocked.landmark_check"] == Level.REVIEW


def test_title_and_keyword_rules():
    r = rules(report_with("x" * 90, ["a"] * 3))
    assert r["meta.title_length"] == Level.INFO
    assert r["meta.keywords_few"] == Level.INFO
    assert r["meta.keywords_dupes"] == Level.INFO
    assert rules(report_with("x" * 210))["meta.title_long"] == Level.REVIEW
    assert rules(report_with("t", [f"k{i}" for i in range(55)]))["meta.keywords_many"] == Level.INFO


def test_mixed_languages_and_personal_info():
    assert rules(report_with("ليمون طازج", ["lemon", "fruit", "fresh", "food", "citrus"]))["meta.mixed_language"] == Level.REVIEW
    assert rules(report_with("Lemons, call +1 555 123 4567"))["meta.personal_info"] == Level.REVIEW
    assert rules(report_with("Lemons", ["www.mysite.com"]))["meta.personal_info"] == Level.REVIEW


def test_ai_prompt_with_artist_name_is_rejected():
    report = report_with("Castle", ["castle"] * 1, ai_generated=True, ai_evidence="test",
                         prompt="epic castle, trending on artstation, by Greg Rutkowski")
    r = rules(report)
    assert r["ai.prompt_blocked.artist"] == Level.REJECT
    assert r["ai.flag_reminder"] == Level.INFO


def test_reads_xmp_title_keywords_and_ai_source(tmp_path, photo):
    photo.save(tmp_path / "x.jpg", quality=90, xmp=XMP.encode())
    path = tmp_path / "x.jpg"
    with Image.open(path) as img:
        meta = read_embedded(path, img, read_head(path))
    assert meta.title == "Fresh lemons on a wooden table"
    assert meta.keywords == ["lemon", "citrus", "fruit"]
    assert meta.ai_generated and "IPTC" in meta.ai_evidence


def test_reads_stable_diffusion_png_prompt(tmp_path):
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", "a cozy cabin, by Thomas Kinkade\nNegative prompt: blurry\nSteps: 30")
    Image.new("RGBA", (64, 64)).save(tmp_path / "sd.png", pnginfo=info)
    path = tmp_path / "sd.png"
    with Image.open(path) as img:
        meta = read_embedded(path, img, read_head(path))
    assert meta.ai_generated
    assert meta.prompt == "a cozy cabin, by Thomas Kinkade"


def test_reads_adobe_csv(tmp_path):
    (tmp_path / "meta.csv").write_text(
        "Filename,Title,Keywords,Category,Releases\nIMG_1.JPG,Lemons,\"lemon, fruit\",7,\n", encoding="utf-8-sig"
    )
    (tmp_path / "notes.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    csv_path = find_adobe_csv(tmp_path)
    assert csv_path is not None and csv_path.name == "meta.csv"
    rows, warnings = read_adobe_csv(csv_path)
    assert rows["img_1.jpg"]["title"] == "Lemons"
    assert rows["img_1.jpg"]["keywords"] == "lemon, fruit"
    assert warnings == []


def test_csv_with_unquoted_keywords_and_arabic_excel_encoding(tmp_path):
    (tmp_path / "meta.csv").write_bytes(
        "Filename,Title,Keywords,Category,Releases\na.jpg,غروب,sea,sky,sun,7,\n".encode("cp1256")
    )
    rows, warnings = read_adobe_csv(tmp_path / "meta.csv")
    assert rows["a.jpg"]["title"] == "غروب"
    assert rows["a.jpg"]["keywords"] == "sea, sky, sun"
    assert rows["a.jpg"]["category"] == "7"
    assert len(warnings) == 1


def test_ordinary_words_are_not_trademarks():
    r = rules(report_with("Über den Wolken", ["clouds", "sky", "canon in d", "music", "sheet"]))
    assert r == {"meta.blocked.brand_check": Level.REVIEW, "meta.mixed_language": r.get("meta.mixed_language")} or \
        r == {"meta.blocked.brand_check": Level.REVIEW}
    assert Level.REJECT not in r.values()


def test_years_as_keywords_are_not_a_phone_number():
    assert "meta.personal_info" not in rules(report_with("Calendar", ["2023", "2024", "2025", "calendar", "date"]))
