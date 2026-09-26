"""Technical specifications: format, size, resolution, color space, PNG transparency, JPEG quality."""

from __future__ import annotations

import numpy as np
from PIL import Image

from ..config import Config
from ..findings import FileReport, Level
from ..icc import parse_icc

# IJG reference luminance quantization table (quality 50); JPEG quality is estimated against it.
_IJG_LUMA = np.array([
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
], dtype=np.float64)

ACCEPTED = {".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".svg": "svg", ".eps": "eps", ".ai": "ai"}
OTHER_IMAGES = {
    ".tif", ".tiff", ".webp", ".heic", ".heif", ".avif", ".gif", ".bmp", ".psd", ".psb", ".jxl",
    ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".pdf",
}


def sniff(head: bytes) -> str:
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"%!PS-Adobe") or head.startswith(b"\xc5\xd0\xd3\xc6"):
        return "postscript"
    text = head[:4096].lower()
    if b"<svg" in text:
        return "svg"
    if head[4:12] in (b"ftypheic", b"ftypheix", b"ftypmif1", b"ftypavif"):
        return "heif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "webp"
    if head[:4] in (b"II*\0", b"MM\0*"):
        return "tiff"
    return "unknown"


def check_container(report: FileReport, ext: str, head: bytes, config: Config) -> bool:
    """Format and file size. Returns False when the file cannot be analysed further."""
    tech = config.technical
    if ext in OTHER_IMAGES:
        report.add("tech.format", "technical", Level.REJECT,
                   "صيغة غير مقبولة في Adobe Stock: الصور JPEG، والمفرغة PNG، والفيكتور AI أو EPS أو SVG",
                   ext.lstrip(".").upper())
        return False
    actual = sniff(head)
    expected = {"jpeg": {"jpeg"}, "png": {"png"}, "svg": {"svg"}, "eps": {"postscript"}, "ai": {"pdf", "postscript"}}
    if actual not in expected[report.kind]:
        report.add("tech.mismatch", "technical", Level.REJECT,
                   "امتداد الملف لا يطابق محتواه الحقيقي", f"الامتداد {ext} والمحتوى {actual}")
        return False
    limit = tech.max_file_mb * 1_000_000
    if report.size_bytes > limit:
        report.add("tech.file_size", "technical", Level.REJECT,
                   f"حجم الملف أكبر من {tech.max_file_mb:g} ميغابايت", f"{report.size_bytes / 1_000_000:.1f} ميغابايت")
    return True


def check_dimensions(report: FileReport, config: Config) -> bool:
    """Resolution. Returns False when the image is too large to decode safely."""
    tech = config.technical
    mp = report.megapixels
    detail = f"{report.width}×{report.height} = {mp:.1f} ميغابكسل"
    if mp < tech.min_megapixels:
        need = (tech.min_megapixels * 1_000_000 / (report.width * report.height)) ** 0.5 if mp else 0
        report.add("tech.resolution_low", "technical", Level.REJECT,
                   f"الدقة أقل من {tech.min_megapixels:g} ميغابكسل",
                   detail + (f"؛ تحتاج تكبيراً حقيقياً بنسبة {need:.2f}× على الأقل" if need else ""))
    elif mp > tech.max_megapixels:
        report.add("tech.resolution_high", "technical", Level.REJECT,
                   f"الدقة أكبر من {tech.max_megapixels:g} ميغابكسل", detail)
        return False
    return True


def check_color(report: FileReport, img: Image.Image) -> None:
    mode = img.mode
    if mode == "CMYK":
        report.add("tech.cmyk", "technical", Level.REJECT, "الصورة بنظام ألوان CMYK، والمطلوب sRGB")
        return
    icc_bytes = img.info.get("icc_profile")
    info = parse_icc(icc_bytes) if icc_bytes else None
    if info is not None:
        if info.color_space == "CMYK":
            report.add("tech.cmyk", "technical", Level.REJECT, "ملف تعريف الألوان CMYK، والمطلوب sRGB", info.description)
        elif info.color_space == "GRAY" or mode in ("L", "LA", "I;16"):
            report.add("tech.grayscale", "technical", Level.REVIEW,
                       "صورة رمادية (Grayscale)؛ احفظها بنظام RGB وملف sRGB لتجنب الرفض", info.description)
        elif not info.is_srgb:
            report.add("tech.color_space", "technical", Level.REJECT,
                       "فضاء الألوان ليس sRGB؛ حوّل الصورة إلى sRGB قبل التصدير", info.family)
        return
    if mode in ("L", "LA", "I;16", "1"):
        report.add("tech.grayscale", "technical", Level.REVIEW,
                   "صورة رمادية (Grayscale)؛ احفظها بنظام RGB وملف sRGB لتجنب الرفض")
        return
    try:
        color_space_tag = img.getexif().get_ifd(0x8769).get(0xA001)
    except Exception:
        color_space_tag = None
    if color_space_tag == 0xFFFF:
        report.add("tech.color_space_unknown", "technical", Level.REVIEW,
                   "لا يوجد ملف ألوان، وبيانات الكاميرا تقول Uncalibrated (غالباً Adobe RGB)؛ صدّرها بملف sRGB")


def estimate_jpeg_quality(img: Image.Image) -> int | None:
    tables = getattr(img, "quantization", None)
    if not tables or 0 not in tables:
        return None
    luma = np.asarray(list(tables[0])[:64], dtype=np.float64)
    if len(luma) != 64:
        return None
    scale = luma.sum() / _IJG_LUMA.sum() * 100
    quality = (200 - scale) / 2 if scale <= 100 else 5000 / scale
    return int(round(min(100, max(1, quality))))


def check_jpeg_quality(report: FileReport, img: Image.Image, config: Config) -> None:
    quality = estimate_jpeg_quality(img)
    if quality is None:
        return
    report.metrics["jpeg_quality"] = quality
    tech = config.technical
    if quality < tech.jpeg_quality_reject:
        report.add("tech.jpeg_quality", "quality", Level.REJECT,
                   "ضغط JPEG مرتفع جداً، وآثار الضغط ستظهر بتكبير 100%؛ صدّر بجودة 10-12 من 12",
                   f"جودة تقديرية {quality} من 100")
    elif quality < tech.jpeg_quality_review:
        report.add("tech.jpeg_quality", "quality", Level.REVIEW,
                   "ضغط JPEG مرتفع وقد تظهر آثاره بتكبير 100%", f"جودة تقديرية {quality} من 100")


def alpha_channel(img: Image.Image) -> np.ndarray | None:
    if img.mode in ("RGBA", "LA", "PA"):
        return np.asarray(img.getchannel("A"))
    if "transparency" in img.info:
        return np.asarray(img.convert("RGBA").getchannel("A"))
    return None


def check_png(report: FileReport, img: Image.Image, rgb: np.ndarray, config: Config) -> None:
    tech = config.technical
    alpha = alpha_channel(img)
    if alpha is None or alpha.min() == 255:
        if detect_checkerboard(rgb):
            report.add("tech.fake_transparency", "technical", Level.REJECT,
                       "خلفية شطرنجية مرسومة وليست شفافية حقيقية؛ احذفها واحفظ PNG بخلفية شفافة")
        else:
            report.add("tech.png_opaque", "technical", Level.REJECT,
                       "ملف PNG بلا خلفية شفافة؛ Adobe يقبل PNG للعناصر المفرغة فقط، فاحفظه JPEG إن لم يكن مفرغاً")
        return
    visible = alpha > 8
    if not visible.any():
        report.add("tech.png_empty", "technical", Level.REJECT, "الصورة شفافة بالكامل ولا تحتوي على شيء")
        return
    transparent_share = float((alpha == 0).mean())
    report.metrics["transparent_share"] = transparent_share
    if transparent_share < tech.png_min_transparent:
        report.add("tech.png_barely_transparent", "technical", Level.REVIEW,
                   "الشفافية تكاد تكون معدومة؛ تأكد أن الخلفية مفرغة فعلاً", f"{transparent_share:.1%} من البكسلات شفافة")
    ys = np.flatnonzero(visible.any(axis=1))
    xs = np.flatnonzero(visible.any(axis=0))
    h, w = alpha.shape
    top, bottom = ys[0] / h, (h - 1 - ys[-1]) / h
    left, right = xs[0] / w, (w - 1 - xs[-1]) / w
    area = (ys[-1] - ys[0] + 1) * (xs[-1] - xs[0] + 1) / (w * h)
    report.metrics["content_area"] = area
    margins = f"أعلى {top:.0%}، أسفل {bottom:.0%}، يمين {right:.0%}، يسار {left:.0%}"
    if area < tech.png_min_content_area:
        report.add("tech.png_margins", "technical", Level.REJECT,
                   "العنصر صغير جداً وسط مساحة فارغة كبيرة؛ قص الصورة حول العنصر", margins)
    elif max(top, bottom, left, right) > tech.png_margin_review:
        report.add("tech.png_margins", "technical", Level.REVIEW,
                   "مساحة فارغة كبيرة حول العنصر؛ قص الصورة بإحكام حوله", margins)
    # A checkerboard can also be painted inside a PNG that has some real transparency.
    if detect_checkerboard(np.where(alpha[..., None] == 255, rgb, 0)):
        report.add("tech.fake_transparency", "technical", Level.REJECT,
                   "أجزاء من الخلفية شطرنجية مرسومة وليست شفافة")


def detect_checkerboard(rgb: np.ndarray, patch: int = 96) -> bool:
    """True when at least two corners show a gray/white checkerboard, the classic fake transparency."""
    h, w = rgb.shape[:2]
    if h < patch or w < patch:
        return False
    corners = [rgb[:patch, :patch], rgb[:patch, -patch:], rgb[-patch:, :patch], rgb[-patch:, -patch:]]
    return sum(_is_checker(c) for c in corners) >= 2


def _is_checker(block: np.ndarray) -> bool:
    px = block.reshape(-1, 3).astype(np.int16)
    # Both checker colors are neutral grays or white.
    if (px.max(axis=1) - px.min(axis=1)).max() > 12:
        return False
    gray = px.mean(axis=1).reshape(block.shape[:2])
    lo, hi = gray.min(), gray.max()
    if hi - lo < 8 or hi < 150:
        return False
    binary = gray > (lo + hi) / 2
    # Mostly two flat levels, not a gradient.
    near = (np.abs(gray - lo) < 4) | (np.abs(gray - hi) < 4)
    if near.mean() < 0.95:
        return False
    size = _period(binary[0])
    if size is None or size != _period(binary[:, 0]):
        return False
    ys, xs = np.indices(binary.shape)
    for oy in range(size):
        for ox in range(size):
            pattern = (((ys + oy) // size + (xs + ox) // size) % 2).astype(bool)
            if (pattern == binary).mean() > 0.97 or (pattern != binary).mean() > 0.97:
                return True
    return False


def _period(line: np.ndarray) -> int | None:
    edges = np.flatnonzero(line[1:] != line[:-1]) + 1
    if len(edges) < 3:
        return None
    runs = np.diff(edges)
    size = int(np.median(runs))
    if size < 4 or size > 48 or (np.abs(runs - size) > 1).mean() > 0.1:
        return None
    return size
