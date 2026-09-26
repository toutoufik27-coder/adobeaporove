"""Copies files into pass / review / reject. Originals are never moved or modified."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from .findings import Verdict
from .metadata_io import write_adobe_csv
from .scanner import ScanResult

MANIFEST = ".qguard-manifest.json"


def _forget_previous_run(out_dir: Path) -> None:
    """Delete only the copies a previous run made, so a file that changed pile doesn't linger."""
    manifest = out_dir / MANIFEST
    if not manifest.exists():
        return
    try:
        previous = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    for rel in previous:
        target = (out_dir / rel).resolve()
        if out_dir.resolve() in target.parents and target.is_file():
            target.unlink()
    manifest.unlink()


def sort_files(result: ScanResult, out_dir: Path) -> dict[str, list[str]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    _forget_previous_run(out_dir)
    copied: list[str] = []
    placed: dict[str, list[str]] = {v.folder: [] for v in Verdict}
    csv_rows: dict[str, list[dict[str, str]]] = {v.folder: [] for v in Verdict}
    for report in result.reports:
        folder = out_dir / report.verdict.folder
        folder.mkdir(exist_ok=True)
        target = folder / report.name
        n = 2
        while target.exists():
            target = folder / f"{Path(report.name).stem} ({n}){Path(report.name).suffix}"
            n += 1
        shutil.copy2(report.path, target)
        copied.append(str(target.relative_to(out_dir)))
        placed[report.verdict.folder].append(target.name)
        row = result.csv_rows.get(report.name.lower())
        if row is not None:
            # The row names the copy as it was actually saved, "name (2).jpg" included.
            csv_rows[report.verdict.folder].append({**row, "filename": target.name})

    # With a metadata CSV, each pile gets its own CSV ready for Adobe's upload page.
    for folder, rows in csv_rows.items():
        if rows:
            csv_path = out_dir / folder / "adobe-stock-metadata.csv"
            write_adobe_csv(csv_path, rows)
            copied.append(str(csv_path.relative_to(out_dir)))
    (out_dir / MANIFEST).write_text(json.dumps(copied, ensure_ascii=False, indent=0), encoding="utf-8")
    return placed
