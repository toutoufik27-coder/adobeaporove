from __future__ import annotations

import csv
import json

from PIL import Image, ImageDraw, ImageFilter

from quality_guard.cli import calibration_text, main
from quality_guard.config import ConfigError, load_config
from quality_guard.scanner import ScanResult


def make_batch(folder, photo):
    folder.mkdir()
    photo.save(folder / "good.jpg", quality=95)
    photo.filter(ImageFilter.GaussianBlur(3)).save(folder / "blurry.jpg", quality=95)
    photo.resize((1000, 750)).save(folder / "small.jpg", quality=95)
    cut = Image.new("RGBA", (2400, 1800), (0, 0, 0, 0))
    ImageDraw.Draw(cut).ellipse((200, 150, 2200, 1650), fill=(40, 160, 90, 255))
    cut.save(folder / "object.png")
    (folder / "notes.txt").write_text("not an image")
    (folder / "meta.csv").write_text(
        "Filename,Title,Keywords,Category,Releases\n"
        "good.jpg,Abstract colorful shapes,\"abstract, shapes, color, pattern, background\",8,\n"
        "object.png,Green ball for Nike ads,\"ball, green, nike, sport, round\",8,\n",
        encoding="utf-8",
    )


def test_scan_sorts_files_and_writes_reports(tmp_path, photo):
    batch = tmp_path / "batch"
    make_batch(batch, photo)
    out = tmp_path / "out"
    assert main([str(batch), "--out", str(out), "--jobs", "1", "--no-local-ai"]) == 0

    assert sorted(p.name for p in (out / "pass").glob("*.jpg")) == ["good.jpg"]
    assert sorted(p.name for p in (out / "reject").iterdir() if p.suffix != ".csv") == [
        "blurry.jpg", "object.png", "small.jpg"]
    assert (batch / "good.jpg").exists(), "originals must stay in place"

    data = json.loads((out / "results.json").read_text(encoding="utf-8"))
    verdicts = {f["file"]: f["verdict"] for f in data["files"]}
    assert verdicts == {"good.jpg": "pass", "blurry.jpg": "reject", "small.jpg": "reject", "object.png": "reject"}
    obj = next(f for f in data["files"] if f["file"] == "object.png")
    assert {x["rule"] for x in obj["findings"]} >= {"meta.blocked.brand"}

    html = (out / "report.html").read_text(encoding="utf-8")
    assert 'dir="rtl"' in html and "good.jpg" in html and "لم تعمل مراجعة Claude البصرية" in html
    assert (out / "thumbs").is_dir() and (out / "assets" / "fonts.css").is_file()
    rows = list(csv.DictReader((out / "results.csv").open(encoding="utf-8-sig")))
    assert {r["file"] for r in rows} == set(verdicts)
    # The metadata CSV is split per pile, ready for Adobe's upload page.
    pass_csv = list(csv.reader((out / "pass" / "adobe-stock-metadata.csv").open(encoding="utf-8")))
    assert pass_csv[0] == ["Filename", "Title", "Keywords", "Category", "Releases"]
    assert [r[0] for r in pass_csv[1:]] == ["good.jpg"]


def test_rerun_removes_stale_copies(tmp_path, photo):
    batch = tmp_path / "batch"
    make_batch(batch, photo)
    out = tmp_path / "out"
    main([str(batch), "--out", str(out), "--jobs", "1", "--no-local-ai"])
    photo.save(batch / "blurry.jpg", quality=95)  # fixed by the user
    main([str(batch), "--out", str(out), "--jobs", "1", "--no-local-ai"])
    assert (out / "pass" / "blurry.jpg").exists()
    assert not (out / "reject" / "blurry.jpg").exists()


def test_parallel_scan_matches_serial(tmp_path, photo):
    batch = tmp_path / "batch"
    make_batch(batch, photo)
    main([str(batch), "--out", str(tmp_path / "a"), "--jobs", "1", "--no-copy", "--no-local-ai"])
    main([str(batch), "--out", str(tmp_path / "b"), "--jobs", "3", "--no-copy", "--no-local-ai"])
    a = json.loads((tmp_path / "a" / "results.json").read_text(encoding="utf-8"))
    b = json.loads((tmp_path / "b" / "results.json").read_text(encoding="utf-8"))
    assert [f["verdict"] for f in a["files"]] == [f["verdict"] for f in b["files"]]
    assert not (tmp_path / "b" / "pass").exists()


def test_missing_folder_and_bad_config(tmp_path):
    assert main([str(tmp_path / "nope")]) == 2
    bad = tmp_path / "bad.toml"
    bad.write_text("[quality]\nsharpnes_review = 0.5\n", encoding="utf-8")
    try:
        load_config(bad)
    except ConfigError as e:
        assert "sharpnes_review" in str(e)
    else:
        raise AssertionError("unknown key accepted")
    good = tmp_path / "good.toml"
    good.write_text("[quality]\nnoise_review = 4\n[vision]\nmodel = \"claude-sonnet-5\"\n", encoding="utf-8")
    config = load_config(good)
    assert config.quality.noise_review == 4.0 and config.vision.model == "claude-sonnet-5"


def test_calibration_estimates_pass_pile_precision(tmp_path, photo):
    from quality_guard.findings import FileReport, Level

    def result(verdicts):
        reports = []
        for i, v in enumerate(verdicts):
            r = FileReport(path=str(i), name=f"{i}.jpg", kind="jpeg", size_bytes=0)
            if v:
                r.add("quality.soft", "quality", v, "لينة")
            reports.append(r)
        return ScanResult(input_dir=tmp_path, reports=reports)

    accepted = result([None] * 9 + [Level.REVIEW])
    rejected = result([Level.REJECT] * 8 + [None] * 2)
    text = calibration_text(accepted, rejected)
    assert "مقبول 90%" in text
    assert "التقطتها الأداة 80%" in text
    # 9 accepted and 2 rejected files land in pass: 9 / 11 = 82%.
    assert "نحو 82" in text
