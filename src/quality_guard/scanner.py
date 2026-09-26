"""Runs every check over a folder and returns one report per file."""

from __future__ import annotations

import io
import os
import time
from collections.abc import Callable
from concurrent.futures import CancelledError, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from .checks.metadata import Blocklist, check_metadata
from .checks.quality import check_borders, check_exposure, check_quality
from .checks.similarity import check_similarity, phash
from .checks.technical import (
    ACCEPTED,
    OTHER_IMAGES,
    alpha_channel,
    check_color,
    check_container,
    check_dimensions,
    check_jpeg_quality,
    check_png,
    detect_checkerboard,
)
from .checks.vector import check_vector
from .checks.vision import VisionReviewer, VisionUnavailable, apply_review, sha256_of
from .config import Config
from .findings import FileReport, Level, Verdict
from .imaging import downscale
from .metadata_io import apply_csv_row, read_adobe_csv, read_embedded, read_head

# We check megapixels from the header before decoding, so Pillow's own bomb guard is redundant.
Image.MAX_IMAGE_PIXELS = None

Progress = Callable[[str, int, int, str], None]


@dataclass
class ScanResult:
    input_dir: Path
    reports: list[FileReport]
    csv_path: Path | None = None
    csv_rows: dict[str, dict[str, str]] = field(default_factory=dict)
    vision: str = "off"  # "off", "on", or the reason it could not run
    vision_model: str = ""
    vision_calls: int = 0
    vision_input_tokens: int = 0
    vision_output_tokens: int = 0
    seconds: float = 0.0

    def count(self, verdict: Verdict) -> int:
        return sum(1 for r in self.reports if r.verdict == verdict)


def collect_files(folder: Path, recursive: bool, exclude: Path | None = None) -> list[Path]:
    pattern = folder.rglob("*") if recursive else folder.glob("*")
    files = []
    for p in pattern:
        if not p.is_file() or p.name.startswith("."):
            continue
        if exclude is not None and exclude in p.parents:
            continue
        if p.suffix.lower() in ACCEPTED or p.suffix.lower() in OTHER_IMAGES:
            files.append(p)
    return sorted(files, key=lambda p: str(p).lower())


def _thumbnail(img: Image.Image) -> bytes:
    small = downscale(img, 360)
    if small.mode in ("RGBA", "LA", "PA") or "transparency" in small.info:
        rgba = small.convert("RGBA")
        base = Image.new("RGBA", rgba.size, (225, 228, 232, 255))
        base.alpha_composite(rgba)
        small = base
    buf = io.BytesIO()
    small.convert("RGB").save(buf, "JPEG", quality=78)
    return buf.getvalue()


def analyze_file(path: Path, config: Config, csv_row: dict[str, str] | None, blocklist: Blocklist) -> FileReport:
    ext = path.suffix.lower()
    report = FileReport(path=str(path), name=path.name, kind=ACCEPTED.get(ext, "other"), size_bytes=path.stat().st_size)
    head = read_head(path)
    if not check_container(report, ext, head, config):
        return report
    report.sha256 = sha256_of(path)

    if report.kind in ("svg", "eps", "ai"):
        data = path.read_bytes() if report.kind == "svg" and report.size_bytes < 50_000_000 else head
        check_vector(report, data, config)
        report.metadata = read_embedded(path, None, head)
    else:
        _analyze_raster(path, report, head, config)
    if csv_row is not None:
        apply_csv_row(report.metadata, csv_row)
    if report.kind != "other":
        check_metadata(report, config, blocklist)
    return report


def _analyze_raster(path: Path, report: FileReport, head: bytes, config: Config) -> None:
    try:
        img = Image.open(path)
    except Exception as e:
        report.add("tech.corrupt", "technical", Level.REJECT, "الملف تالف أو لا يُفتح", type(e).__name__)
        return
    with img:
        report.width, report.height = img.size
        if not check_dimensions(report, config):
            report.metadata = read_embedded(path, img, head)
            return
        try:
            img.load()
        except Exception as e:
            report.add("tech.corrupt", "technical", Level.REJECT, "الملف تالف أو ناقص ولا يكتمل فتحه", str(e)[:120])
            return
        report.metadata = read_embedded(path, img, head)
        check_color(report, img)
        if report.kind == "jpeg":
            check_jpeg_quality(report, img, config)

        rgb_img = img.convert("RGB")
        rgb = np.asarray(rgb_img)
        alpha = None
        if report.kind == "png":
            check_png(report, img, rgb, config)
            alpha = alpha_channel(img)
        elif detect_checkerboard(rgb):
            report.add("tech.fake_transparency", "technical", Level.REVIEW,
                       "الخلفية تبدو شطرنجية مرسومة لتوحي بالشفافية؛ إن كان العنصر مفرغاً فاحفظه PNG شفافاً")

        check_quality(report, np.asarray(rgb_img.convert("L")), config, alpha)
        small = np.asarray(downscale(rgb_img, 1200))
        if report.kind == "jpeg":
            check_exposure(report, small, config)
            check_borders(report, small)
        report.phash, report.phash_mirror = phash(rgb_img)
        report.thumbnail = _thumbnail(img)
        del rgb, rgb_img


def _worker(args: tuple[str, Config, dict[str, str] | None]) -> FileReport:
    path, config, row = args
    extra = Path(config.metadata.extra_blocklist) if config.metadata.extra_blocklist else None
    if extra is not None and not extra.is_absolute():
        extra = config.base_dir / extra
    blocklist = Blocklist.load(extra)
    try:
        return analyze_file(Path(path), config, row, blocklist)
    except Exception as e:  # one unreadable file must not stop the batch
        report = FileReport(path=path, name=Path(path).name, kind="other", size_bytes=Path(path).stat().st_size)
        reason = "الذاكرة لا تكفي" if isinstance(e, MemoryError) else f"{type(e).__name__}: {e}"[:160]
        report.add("tool.error", "technical", Level.REVIEW, "تعذّر فحص هذا الملف؛ افحصه بعينك", reason)
        return report


def scan(
    input_dir: Path,
    config: Config,
    *,
    recursive: bool = False,
    csv_path: Path | None = None,
    vision: bool = False,
    jobs: int = 0,
    exclude: Path | None = None,
    cache_dir: Path | None = None,
    progress: Progress | None = None,
) -> ScanResult:
    started = time.monotonic()
    files = collect_files(input_dir, recursive, exclude)
    rows = read_adobe_csv(csv_path) if csv_path else {}
    result = ScanResult(input_dir=input_dir, reports=[], csv_path=csv_path, csv_rows=rows)

    jobs = jobs or max(1, min(3, (os.cpu_count() or 2) - 1))  # ~0.5 GB per 24 MP file in flight
    tasks = [(str(p), config, rows.get(p.name.lower())) for p in files]
    reports: dict[str, FileReport] = {}
    if jobs == 1 or len(tasks) < 3:
        for i, task in enumerate(tasks, 1):
            reports[task[0]] = _worker(task)
            if progress:
                progress("analyze", i, len(tasks), Path(task[0]).name)
    else:
        with ProcessPoolExecutor(max_workers=jobs) as pool:
            futures = {pool.submit(_worker, t): t[0] for t in tasks}
            for i, fut in enumerate(as_completed(futures), 1):
                reports[futures[fut]] = fut.result()
                if progress:
                    progress("analyze", i, len(tasks), Path(futures[fut]).name)
    result.reports = [reports[str(p)] for p in files]

    check_similarity(result.reports, config)

    if vision:
        _run_vision(result, config, cache_dir, progress)
    result.seconds = time.monotonic() - started
    return result


def _run_vision(result: ScanResult, config: Config, cache_dir: Path | None, progress: Progress | None) -> None:
    result.vision_model = config.vision.model
    try:
        reviewer = VisionReviewer(config, cache_dir / ".qguard-vision-cache.json" if cache_dir else None)
    except VisionUnavailable as e:
        result.vision = str(e)
        return
    todo = [r for r in result.reports if r.is_raster and r.verdict != Verdict.REJECT and r.thumbnail]
    stopped: str | None = None
    with ThreadPoolExecutor(max_workers=max(1, config.vision.workers)) as pool:
        futures = {pool.submit(reviewer.fetch, Path(r.path), r): r for r in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            report = futures[fut]
            try:
                apply_review(report, fut.result())
            except CancelledError:
                continue
            except VisionUnavailable as e:
                if stopped is None:
                    stopped = str(e)
                    for other in futures:
                        other.cancel()
            except Exception as e:  # one failed request must not stop the batch
                apply_review(report, {"error": f"{type(e).__name__}: {e}"[:160]})
            if progress:
                progress("vision", i, len(todo), report.name)
    result.vision = stopped or "on"
    result.vision_calls = reviewer.calls
    result.vision_input_tokens = reviewer.input_tokens
    result.vision_output_tokens = reviewer.output_tokens
