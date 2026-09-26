"""Vector files (SVG, EPS, AI): artboard size, live text, embedded rasters."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zlib

from ..config import Config
from ..findings import FileReport, Level

_UNITS = {"": 1.0, "px": 1.0, "pt": 1.0, "pc": 12.0, "in": 72.0, "mm": 72 / 25.4, "cm": 72 / 2.54}


def _length(value: str | None) -> float | None:
    if not value:
        return None
    m = re.fullmatch(r"\s*([0-9.]+)\s*([a-z%]*)\s*", value)
    if not m or m.group(2) not in _UNITS:
        return None
    try:
        return float(m.group(1)) * _UNITS[m.group(2)]
    except ValueError:
        return None


def svg_size(root: ET.Element) -> tuple[float, float] | None:
    width, height = _length(root.get("width")), _length(root.get("height"))
    if width and height:
        return width, height
    box = root.get("viewBox")
    if box:
        parts = re.split(r"[\s,]+", box.strip())
        if len(parts) == 4:
            try:
                return float(parts[2]), float(parts[3])
            except ValueError:
                return None
    return None


def check_vector(report: FileReport, data: bytes, config: Config) -> None:
    if report.kind == "svg":
        _check_svg(report, data)
    else:
        _check_postscript(report, data)
    if report.width and report.height:
        need = config.technical.min_vector_megapixels
        if report.megapixels < need:
            report.add("tech.vector_small", "technical", Level.REJECT,
                       f"لوحة الرسم أصغر من {need:g} ميغابكسل (مثلاً 5000×3000)",
                       f"{report.width}×{report.height} = {report.megapixels:.1f} ميغابكسل")
    else:
        report.add("tech.vector_size_unknown", "technical", Level.REVIEW,
                   f"تعذّرت قراءة مقاس لوحة الرسم؛ تأكد أنها {config.technical.min_vector_megapixels:g} ميغابكسل على الأقل")


def _check_svg(report: FileReport, data: bytes) -> None:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        report.add("tech.corrupt", "technical", Level.REJECT, "ملف SVG تالف أو لا يُقرأ", str(e))
        return
    size = svg_size(root)
    if size:
        report.width, report.height = round(size[0]), round(size[1])
    local = {el.tag.rsplit("}", 1)[-1] for el in root.iter()}
    if "text" in local:
        report.add("vector.live_text", "ip", Level.REVIEW, "نصوص حية غير محوّلة إلى مسارات؛ حوّل الخطوط إلى outlines")
    if "image" in local:
        report.add("vector.raster", "technical", Level.REVIEW, "الملف يحتوي على صورة نقطية مدمجة داخل الفيكتور")


def _check_postscript(report: FileReport, data: bytes) -> None:
    text = data.decode("latin-1")
    fonts = re.search(r"%%DocumentFonts:\s*(.+)", text)
    needed = re.search(r"%%DocumentNeededResources:\s*font\s+(.+)", text)
    names = (fonts.group(1).strip() if fonts else "") or (needed.group(1).strip() if needed else "")
    if names and names != "(atend)":
        report.add("vector.live_text", "ip", Level.REVIEW,
                   "الملف يستخدم خطوطاً غير محوّلة إلى مسارات؛ حوّلها إلى outlines", names[:80])

    box = _find_box(text)
    if box is None and report.kind == "ai":
        # PDF-based .ai files often keep the page dictionary inside compressed object streams.
        box = _find_box(_inflate_streams(data))
    if box is not None:
        x0, y0, x1, y1 = box
        report.width, report.height = round(abs(x1 - x0)), round(abs(y1 - y0))


_NUM = r"([-0-9.]+)"


def _find_box(text: str) -> tuple[float, float, float, float] | None:
    for pattern in (
        rf"%%HiResBoundingBox:\s*{_NUM}\s+{_NUM}\s+{_NUM}\s+{_NUM}",
        rf"%%BoundingBox:\s*{_NUM}\s+{_NUM}\s+{_NUM}\s+{_NUM}",
        rf"/ArtBox\s*\[\s*{_NUM}\s+{_NUM}\s+{_NUM}\s+{_NUM}\s*\]",
        rf"/MediaBox\s*\[\s*{_NUM}\s+{_NUM}\s+{_NUM}\s+{_NUM}\s*\]",
    ):
        m = re.search(pattern, text)
        if m:
            try:
                return tuple(float(v) for v in m.groups())  # type: ignore[return-value]
            except ValueError:
                continue
    return None


def _inflate_streams(data: bytes, attempts: int = 300) -> str:
    """Text of the first compressed streams that mention a page box (bounded work on big files)."""
    for n, m in enumerate(re.finditer(rb"(?<!end)stream\r?\n", data)):
        if n >= attempts:
            break
        try:
            chunk = zlib.decompressobj().decompress(data[m.end() : m.end() + 1_000_000], 1_000_000)
        except zlib.error:
            continue
        if b"Box" in chunk:
            text = chunk.decode("latin-1")
            if _find_box(text):
                return text
    return ""
