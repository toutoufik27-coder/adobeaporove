"""Runs every check over a folder and returns one report per file."""

from __future__ import annotations

import io
import threading
import time
from collections.abc import Callable, Iterable
from concurrent.futures import CancelledError, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from . import hardware
from .checks.local_ai import LocalAI, available
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
    to_rgb,
)
from .checks.vector import check_vector
from .checks.vision import VisionReviewer, VisionUnavailable, apply_review, sha256_of
from .config import Config, resolve_blocklist
from .findings import FileReport, Level, Verdict
from .imaging import downscale
from .metadata_io import apply_csv_row, read_adobe_csv, read_embedded, read_head

# We check megapixels from the header before decoding, so Pillow's own bomb guard is redundant.
Image.MAX_IMAGE_PIXELS = None

THUMB_SIDE = 480


@dataclass
class ProgressEvent:
    stage: str  # "analyze", "similar", "local", "vision", "done"
    done: int
    total: int
    name: str = ""
    verdict: str = ""  # verdict of the file just finished, as far as it is known
    report: FileReport | None = None  # the file just finished (analyze stage), for live previews


Progress = Callable[[ProgressEvent], None]


class Cancelled(Exception):
    pass


@dataclass
class ScanResult:
    input_dir: Path
    reports: list[FileReport]
    csv_path: Path | None = None
    csv_rows: dict[str, dict[str, str]] = field(default_factory=dict)
    csv_warnings: list[str] = field(default_factory=list)
    vision: str = "off"  # "off", "on", or the reason it could not run
    vision_model: str = ""
    vision_calls: int = 0
    vision_input_tokens: int = 0
    vision_output_tokens: int = 0
    local_ai: str = "off"  # "off", "on: <what ran>", or the reason it could not run
    jobs: int = 1
    seconds: float = 0.0

    def count(self, verdict: Verdict) -> int:
        return sum(1 for r in self.reports if r.verdict == verdict)


def collect_files(folder: Path, recursive: bool, exclude: Iterable[Path] = ()) -> list[Path]:
    skip = [p.resolve() for p in exclude]
    pattern = folder.rglob("*") if recursive else folder.glob("*")
    files = []
    for p in pattern:
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in ACCEPTED and p.suffix.lower() not in OTHER_IMAGES:
            continue
        resolved = p.resolve()
        if any(s == resolved or s in resolved.parents for s in skip):
            continue
        files.append(p)
    return sorted(files, key=lambda p: str(p).lower())


def _thumbnail(img: Image.Image) -> bytes:
    small = downscale(ImageOps.exif_transpose(img), THUMB_SIDE)
    if small.mode in ("RGBA", "LA", "PA") or "transparency" in small.info:
        rgba = small.convert("RGBA")
        # A light checkerboard shows which parts of a cut-out are transparent.
        ys, xs = np.indices((rgba.height, rgba.width))
        board = np.where(((ys // 12 + xs // 12) % 2)[..., None] == 0, 236, 214).astype(np.uint8)
        base = Image.fromarray(np.dstack([board.repeat(3, axis=2), np.full(board.shape, 255, np.uint8)]), "RGBA")
        base.alpha_composite(rgba)
        small = base
    buf = io.BytesIO()
    to_rgb(small).save(buf, "JPEG", quality=82)
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

        rgb_img = to_rgb(img)
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
        upright = ImageOps.exif_transpose(rgb_img) if img.getexif().get(0x0112, 1) != 1 else rgb_img
        report.phash, report.phash_mirror = phash(upright)
        report.thumbnail = _thumbnail(img)


_blocklist: Blocklist | None = None


def _init_worker(config: Config) -> None:
    global _blocklist
    _blocklist = Blocklist.load(resolve_blocklist(config))


def _worker(args: tuple[str, Config, dict[str, str] | None]) -> FileReport:
    path, config, row = args
    if _blocklist is None:
        _init_worker(config)
    assert _blocklist is not None
    try:
        return analyze_file(Path(path), config, row, _blocklist)
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
    local_ai: bool | None = None,
    jobs: int = 0,
    exclude: Iterable[Path] = (),
    cache_dir: Path | None = None,
    progress: Progress | None = None,
    cancel: threading.Event | None = None,
) -> ScanResult:
    """Analyse every image in input_dir. local_ai=None runs the local detectors when installed."""
    started = time.monotonic()
    blocklist = Blocklist.load(resolve_blocklist(config))  # validates the config before any work
    files = collect_files(input_dir, recursive, exclude)
    rows, warnings = read_adobe_csv(csv_path) if csv_path else ({}, [])
    result = ScanResult(input_dir=input_dir, reports=[], csv_path=csv_path, csv_rows=rows, csv_warnings=warnings)

    def emit(stage: str, done: int, total: int, report: FileReport | None = None) -> None:
        if cancel is not None and cancel.is_set():
            raise Cancelled
        if progress:
            name, verdict = (report.name, report.verdict.folder) if report else ("", "")
            progress(ProgressEvent(stage, done, total, name, verdict, report if stage == "analyze" else None))

    jobs = jobs or config.performance.jobs or hardware.detect().auto_jobs()
    result.jobs = jobs
    tasks = [(str(p), config, rows.get(p.name.lower())) for p in files]
    done: list[FileReport | None] = [None] * len(tasks)

    def finished(index: int, report: FileReport, count: int) -> None:
        report.id = index  # ids follow the sorted file order, so they are stable across runs
        done[index] = report
        emit("analyze", count, len(tasks), report)

    if jobs == 1 or len(tasks) < 3:
        global _blocklist
        _blocklist = blocklist
        for i, task in enumerate(tasks):
            finished(i, _worker(task), i + 1)
    else:
        pool = ProcessPoolExecutor(max_workers=min(jobs, len(tasks)), initializer=_init_worker, initargs=(config,))
        try:
            futures = {pool.submit(_worker, t): i for i, t in enumerate(tasks)}
            for count, fut in enumerate(as_completed(futures), 1):
                finished(futures[fut], fut.result(), count)
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
    result.reports = [r for r in done if r is not None]

    emit("similar", 0, 1)
    check_similarity(result.reports, config)

    want_local = config.local_ai.enabled if local_ai is None else local_ai
    if want_local:
        _run_local_ai(result, config, blocklist, emit)
    if vision:
        _run_vision(result, config, cache_dir, emit)
    result.seconds = time.monotonic() - started
    emit("done", len(result.reports), len(result.reports))
    return result


def _run_local_ai(result: ScanResult, config: Config, blocklist: Blocklist, emit: Callable) -> None:
    have = available()
    if not (have["ocr"] and config.local_ai.ocr) and not (have["faces"] and config.local_ai.faces):
        result.local_ai = 'غير مثبت: pip install ".[gpu]"'
        return
    use_gpu = config.local_ai.gpu and hardware.cuda_available()
    detector = LocalAI(config, blocklist, use_gpu)
    if not detector.active:
        result.local_ai = "؛ ".join(detector.errors) or "تعذّر التشغيل"
        return
    todo = [r for r in result.reports if r.is_raster and r.verdict != Verdict.REJECT and r.thumbnail]
    for i, report in enumerate(todo, 1):
        try:
            detector.analyze(Path(report.path), report)
        except Exception as e:  # one bad file must not stop the batch
            report.add("local.failed", "quality", Level.INFO, "تعذّر الفحص المحلي لهذه الصورة", f"{type(e).__name__}: {e}"[:160])
        emit("local", i, len(todo), report)
    result.local_ai = f"on: {detector.describe()} ({'GPU' if use_gpu else 'CPU'})"


def _run_vision(result: ScanResult, config: Config, cache_dir: Path | None, emit: Callable) -> None:
    result.vision_model = config.vision.model
    try:
        reviewer = VisionReviewer(config, cache_dir / ".qguard-vision-cache.json" if cache_dir else None)
    except VisionUnavailable as e:
        result.vision = str(e)
        return
    todo = [r for r in result.reports if r.is_raster and r.verdict != Verdict.REJECT and r.thumbnail]
    stopped: str | None = None
    pool = ThreadPoolExecutor(max_workers=max(1, config.vision.workers))
    try:
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
            emit("vision", i, len(todo), report)
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        reviewer.save_cache()
    result.vision = stopped or "on"
    result.vision_calls = reviewer.calls
    result.vision_input_tokens = reviewer.input_tokens
    result.vision_output_tokens = reviewer.output_tokens
