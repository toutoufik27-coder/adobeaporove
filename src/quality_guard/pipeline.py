"""Scan a folder, then publish the results: shared by the command line and the app."""

from __future__ import annotations

import threading
from pathlib import Path

from .config import Config
from .findings import Verdict
from .metadata_io import find_adobe_csv
from .report import write_csv, write_html, write_json
from .scanner import Progress, ScanResult, scan
from .sorter import sort_files


def default_out_dir(input_dir: Path) -> Path:
    return input_dir.parent / f"{input_dir.name}-quality-guard"


def exclusions(input_dir: Path, out_dir: Path) -> list[Path]:
    """Never re-scan our own output. The output folder itself is only skipped when it isn't the input."""
    skip = [out_dir / v.folder for v in Verdict] + [out_dir / "thumbs"]
    if out_dir.resolve() != input_dir.resolve():
        skip.append(out_dir)
    return skip


def analyse(
    input_dir: Path, out_dir: Path, config: Config, *, csv: Path | None = None, vision: bool = False,
    local_ai: bool | None = None, recursive: bool = False, jobs: int = 0,
    progress: Progress | None = None, cancel: threading.Event | None = None,
) -> ScanResult:
    csv = csv or find_adobe_csv(input_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return scan(
        input_dir, config, recursive=recursive, csv_path=csv, vision=vision, local_ai=local_ai, jobs=jobs,
        exclude=exclusions(input_dir, out_dir), cache_dir=out_dir, progress=progress, cancel=cancel,
    )


def publish(result: ScanResult, config: Config, out_dir: Path, *, copy: bool = True) -> Path:
    """Copy files into their piles (unless copy=False) and write the reports. Returns the HTML report."""
    out_dir.mkdir(parents=True, exist_ok=True)
    if copy:
        sort_files(result, out_dir)
    report = out_dir / "report.html"
    write_html(result, config, report)
    write_csv(result, out_dir / "results.csv")
    write_json(result, out_dir / "results.json")
    return report
