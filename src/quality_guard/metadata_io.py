"""Reading titles, keywords and AI provenance from files and from Adobe Stock's CSV format."""

from __future__ import annotations

import csv
import io
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, IptcImagePlugin

from .findings import Metadata

NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "xmp": "http://ns.adobe.com/xap/1.0/",
    "photoshop": "http://ns.adobe.com/photoshop/1.0/",
    "Iptc4xmpExt": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
}

# Software names that only ever produce generated images.
AI_TOOLS = (
    "midjourney", "dall-e", "dall·e", "dalle", "stable diffusion", "stablediffusion", "comfyui",
    "automatic1111", "invokeai", "novelai", "firefly", "leonardo.ai", "leonardo ai", "ideogram",
    "imagen", "flux.1", "black forest labs", "gemini", "chatgpt", "openai", "made with google ai",
    "nightcafe", "playground ai", "krea", "recraft",
)
# PNG text chunks written by Stable Diffusion front ends.
AI_PNG_KEYS = ("parameters", "prompt", "workflow", "invokeai_metadata", "sd-metadata", "dream")

CSV_COLUMNS = ("Filename", "Title", "Keywords", "Category", "Releases")


class CsvFormatError(ValueError):
    pass


def read_head(path: Path, limit: int = 8 * 1024 * 1024) -> bytes:
    with open(path, "rb") as f:
        return f.read(limit)


def extract_xmp(data: bytes) -> str:
    start = data.find(b"<x:xmpmeta")
    if start < 0:
        return ""
    end = data.find(b"</x:xmpmeta>", start)
    if end < 0:
        return ""
    return data[start : end + len(b"</x:xmpmeta>")].decode("utf-8", "replace")


def _parse_xmp(xmp: str) -> dict:
    out: dict = {"title": "", "description": "", "keywords": [], "tool": "", "source_type": ""}
    if not xmp:
        return out
    try:
        root = ET.fromstring(xmp)
    except ET.ParseError:
        return out

    def alt_text(tag: str) -> str:
        for node in root.iter(tag):
            for li in node.iter(f"{{{NS['rdf']}}}li"):
                if li.text and li.text.strip():
                    return li.text.strip()
            if node.text and node.text.strip():
                return node.text.strip()
        return ""

    out["title"] = alt_text(f"{{{NS['dc']}}}title")
    out["description"] = alt_text(f"{{{NS['dc']}}}description") or alt_text(f"{{{NS['photoshop']}}}Headline")
    for node in root.iter(f"{{{NS['dc']}}}subject"):
        out["keywords"] = [li.text.strip() for li in node.iter(f"{{{NS['rdf']}}}li") if li.text and li.text.strip()]
        break
    for tag in (f"{{{NS['xmp']}}}CreatorTool", f"{{{NS['Iptc4xmpExt']}}}DigitalSourceType"):
        key = "tool" if tag.endswith("CreatorTool") else "source_type"
        for el in root.iter():
            value = el.attrib.get(tag)
            if value:
                out[key] = value
                break
        if not out[key]:
            for node in root.iter(tag):
                if node.text and node.text.strip():
                    out[key] = node.text.strip()
                    break
                resource = node.attrib.get(f"{{{NS['rdf']}}}resource")
                if resource:
                    out[key] = resource
                    break
    return out


def _decode(value) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8").strip()
        except UnicodeDecodeError:
            return value.decode("latin-1").strip()
    return str(value).strip()


def _xp(value) -> str:
    """Windows Explorer's XP* EXIF tags are UTF-16LE byte tuples."""
    if isinstance(value, tuple):
        value = bytes(value)
    if isinstance(value, bytes):
        return value.decode("utf-16-le", "replace").rstrip("\0").strip()
    return str(value).strip()


def split_keywords(text: str) -> list[str]:
    return [k.strip() for k in re.split(r"[,;\n]", text) if k.strip()]


def prompt_from_png_text(text: dict[str, str]) -> str:
    if "parameters" in text:
        return text["parameters"].split("Negative prompt:")[0].strip()
    if "prompt" in text:
        try:
            graph = json.loads(text["prompt"])
        except (ValueError, TypeError):
            return str(text["prompt"])[:2000]
        parts = []
        if isinstance(graph, dict):
            for node in graph.values():
                inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
                for key in ("text", "text_g", "text_l", "prompt"):
                    if isinstance(inputs.get(key), str):
                        parts.append(inputs[key])
        return "\n".join(parts)
    return ""


def read_embedded(path: Path, img: Image.Image | None, head: bytes) -> Metadata:
    meta = Metadata()
    xmp = _parse_xmp(extract_xmp(head))
    title = xmp["title"] or xmp["description"]
    keywords = list(xmp["keywords"])
    tools = [xmp["tool"]]
    text: dict[str, str] = {}

    if img is not None:
        if img.format == "JPEG":
            try:
                iptc = IptcImagePlugin.getiptcinfo(img) or {}
            except Exception:  # malformed IPTC blocks are common and harmless here
                iptc = {}
            if not title:
                title = _decode(iptc.get((2, 5), b"")) or _decode(iptc.get((2, 120), b""))
            if not keywords and (2, 25) in iptc:
                raw = iptc[(2, 25)]
                keywords = [_decode(k) for k in (raw if isinstance(raw, list) else [raw]) if _decode(k)]
        try:
            exif = img.getexif()
        except Exception:
            exif = {}
        if exif:
            tools.append(_decode(exif.get(0x0131, "")))  # Software
            if not title:
                title = _xp(exif.get(0x9C9B, b"")) or _decode(exif.get(0x010E, ""))
            if not keywords and 0x9C9E in exif:
                keywords = split_keywords(_xp(exif[0x9C9E]))
        if img.format == "PNG":
            # img.text decodes the image if it isn't yet (oversized files are never decoded); img.info
            # then still holds the text chunks written before the pixel data.
            decoded = getattr(img, "_im", None) is not None
            chunks = img.text if decoded else img.info
            text = {str(k): _decode(v) for k, v in chunks.items()
                    if isinstance(v, (str, bytes)) and k not in ("icc_profile", "exif", "transparency")}
        if text:
            tools.append(text.get("Software", ""))
            if not title:
                title = text.get("Title", "") or text.get("Description", "")

    meta.title = title
    meta.keywords = keywords
    meta.source = "embedded" if (title or keywords) else ""

    evidence = ""
    if b"trainedAlgorithmicMedia" in head or "trainedalgorithmicmedia" in xmp["source_type"].lower():
        evidence = "IPTC Digital Source Type / C2PA"
    else:
        for tool in tools:
            low = tool.lower()
            hit = next((t for t in AI_TOOLS if t in low), None)
            if hit:
                evidence = f"Software: {tool}"
                break
    if not evidence and text:
        key = next((k for k in AI_PNG_KEYS if k in text), None)
        if key:
            evidence = f"PNG text chunk '{key}'"
        elif "Job ID:" in text.get("Description", ""):
            evidence = "Midjourney description"
    if evidence:
        meta.ai_generated = True
        meta.ai_evidence = evidence
    if text:
        meta.prompt = prompt_from_png_text(text) or (text.get("Description", "") if "Job ID:" in text.get("Description", "") else "")
    return meta


def _decode_csv(path: Path) -> str:
    """Adobe wants UTF-8, but Excel on an Arabic Windows saves CSV as cp1256."""
    data = path.read_bytes()
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1256", errors="replace")


def read_adobe_csv(path: Path) -> tuple[dict[str, dict[str, str]], list[str]]:
    """Rows of an Adobe Stock metadata CSV keyed by lower-case file name, plus warnings about the file."""
    reader = csv.reader(io.StringIO(_decode_csv(path), newline=""))
    columns = [h.strip().lower() for h in next(reader, [])]
    if "filename" not in columns:
        raise CsvFormatError(f"{path.name}: لا يوجد عمود Filename، الصيغة المتوقعة: {', '.join(CSV_COLUMNS)}")
    rows: dict[str, dict[str, str]] = {}
    warnings: list[str] = []
    k = columns.index("keywords") if "keywords" in columns else -1
    for line, fields in enumerate(reader, start=2):
        if not any(f.strip() for f in fields):
            continue
        if len(fields) > len(columns) and k >= 0:
            # Unquoted keywords spill into the next columns; the columns after Keywords are still the last ones.
            tail = len(columns) - k - 1
            fields = fields[:k] + [", ".join(fields[k : len(fields) - tail])] + fields[len(fields) - tail :]
            warnings.append(f"السطر {line}: الكلمات المفتاحية بلا علامتي تنصيص، فجُمعت تلقائياً؛ تأكد منها")
        clean = {c: (fields[i].strip() if i < len(fields) else "") for i, c in enumerate(columns)}
        name = clean.get("filename", "")
        if name:
            key = Path(name.replace("\\", "/")).name.lower()
            if key in rows:
                warnings.append(f"السطر {line}: الملف {name} مكرر في CSV، واعتُمد آخر سطر")
            rows[key] = clean
    return rows, warnings


def find_adobe_csv(folder: Path) -> Path | None:
    """A CSV next to the images with a Filename column, if there is exactly one."""
    found = []
    for candidate in sorted(folder.glob("*.csv")):
        try:
            header = next(csv.reader(io.StringIO(_decode_csv(candidate), newline="")), [])
        except OSError:
            continue
        if "filename" in {h.strip().lower() for h in header}:
            found.append(candidate)
    return found[0] if len(found) == 1 else None


def apply_csv_row(meta: Metadata, row: dict[str, str]) -> None:
    meta.title = row.get("title", "")
    meta.keywords = split_keywords(row.get("keywords", "").replace(";", ","))
    meta.category = row.get("category", "")
    meta.releases = row.get("releases", "")
    meta.source = "csv"


def write_adobe_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(CSV_COLUMNS)
        for row in rows:
            writer.writerow([row.get(c.lower(), "") for c in CSV_COLUMNS])
