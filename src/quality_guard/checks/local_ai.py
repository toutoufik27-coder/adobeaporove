"""Checks that run on this computer, on the GPU when there is one: text in the picture and faces.

- Text (EasyOCR): brand names on products and signs, watermarks, signatures and printed dates,
  and the garbled lettering generators produce.
- Faces (YuNet, bundled, MIT license): a recognizable person needs a model release.

Both are optional installs (`pip install ".[gpu]"`). Like Claude's visual review, every finding here
goes to "review": a detector can misread, and its job is to show you where to look.
"""

from __future__ import annotations

import re
from importlib import resources
from importlib.util import find_spec
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from ..config import Config
from ..findings import FileReport, Level
from ..imaging import downscale
from .metadata import SECTION_LABELS, Blocklist, normalize

FACE_MODEL = "models/face_detection_yunet_2023mar.onnx"

WATERMARK_WORDS = (
    "shutterstock", "getty images", "gettyimages", "istock", "adobe stock", "dreamstime", "depositphotos",
    "123rf", "alamy", "freepik", "unsplash", "pexels", "pixabay", "watermark", "copyright",
    "all rights reserved", "photo by", "image by", "preview",
)
DATE_TIME = re.compile(
    r"\b(?:19|20)\d{2}[./\-: ](?:0?[1-9]|1[0-2])[./\-: ](?:0?[1-9]|[12]\d|3[01])\b"
    r"|\b(?:0?[1-9]|[12]\d|3[01])[./\-](?:0?[1-9]|1[0-2])[./\-](?:19|20)?\d{2}\b"
    r"|\b[0-2]?\d:[0-5]\d(?::[0-5]\d)?\b"
)


def available() -> dict[str, bool]:
    """Which local detectors can run, without importing the heavy libraries."""
    return {"ocr": find_spec("easyocr") is not None, "faces": find_spec("cv2") is not None}


def _where(cx: float, cy: float) -> str:
    v = "أعلى" if cy < 1 / 3 else "أسفل" if cy > 2 / 3 else "وسط"
    h = "اليسار" if cx < 1 / 3 else "اليمين" if cx > 2 / 3 else "المنتصف"
    return f"{v} {h}" if not (v == "وسط" and h == "المنتصف") else "وسط الصورة"


class LocalAI:
    def __init__(self, config: Config, blocklist: Blocklist, use_gpu: bool):
        self.config = config.local_ai
        self.blocklist = blocklist
        self.reader = None
        self.face_detector = None
        self.errors: list[str] = []
        have = available()
        if self.config.ocr and have["ocr"]:
            try:
                import easyocr  # noqa: PLC0415 - optional, pulls in PyTorch

                self.reader = easyocr.Reader(["en"], gpu=use_gpu, verbose=False)
            except Exception as e:  # model download or CUDA problems
                self.errors.append(f"OCR: {type(e).__name__}: {e}"[:200])
        if self.config.faces and have["faces"]:
            try:
                import cv2  # noqa: PLC0415 - optional

                model = resources.files("quality_guard").joinpath(FACE_MODEL)
                with resources.as_file(model) as model_path:
                    self.face_detector = cv2.FaceDetectorYN.create(
                        str(model_path), "", (320, 320), self.config.face_score, 0.3, 5000)
            except Exception as e:
                self.errors.append(f"Faces: {type(e).__name__}: {e}"[:200])

    @property
    def active(self) -> bool:
        return self.reader is not None or self.face_detector is not None

    def describe(self) -> str:
        parts = []
        if self.reader is not None:
            parts.append("قراءة النصوص")
        if self.face_detector is not None:
            parts.append("كشف الوجوه")
        return " + ".join(parts)

    def analyze(self, path: Path, report: FileReport) -> None:
        with Image.open(path) as img:
            img.load()
            rgb = ImageOps.exif_transpose(img).convert("RGB")
        if self.reader is not None:
            small = downscale(rgb, self.config.ocr_max_side)
            self._check_text(report, np.asarray(small), small.size)
        if self.face_detector is not None:
            small = downscale(rgb, 1600)
            self._check_faces(report, np.asarray(small)[:, :, ::-1].copy())
        report.local_checked = True

    def _check_text(self, report: FileReport, rgb: np.ndarray, size: tuple[int, int]) -> None:
        w, h = size
        items = self.reader.readtext(rgb)  # [(box, text, confidence)]
        report.metrics["text_regions"] = float(len(items))
        ai = report.metadata.ai_generated
        seen: set = set()
        garbled: list[str] = []
        clean_ai_text: list[str] = []
        for box, text, conf in items:
            text = str(text).strip()
            if not text:
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            cx, cy = (min(xs) + max(xs)) / 2 / w, (min(ys) + max(ys)) / 2 / h
            height = (max(ys) - min(ys)) / h
            where = _where(cx, cy)
            low = f" {normalize(text)} "
            letters = sum(c.isalnum() for c in text)

            if conf >= self.config.ocr_confidence:
                for phrase, section in self.blocklist.find(text):
                    if ("brand", phrase) in seen or section == "custom":
                        continue
                    seen.add(("brand", phrase))
                    report.add("local.text_brand", "ip", Level.REVIEW,
                               f"نص ظاهر في الصورة فيه {SECTION_LABELS.get(section, 'اسم محمي')}", f"«{text}» — {where}")
                if any(f" {normalize(word)} " in low for word in WATERMARK_WORDS) or "©" in text:
                    if "watermark" not in seen:
                        seen.add("watermark")
                        report.add("local.watermark", "overlays", Level.REVIEW,
                                   "نص يشبه علامة مائية أو حقوق نشر", f"«{text}» — {where}")
                elif DATE_TIME.search(text) and "date" not in seen:
                    seen.add("date")
                    report.add("local.date_stamp", "overlays", Level.REVIEW,
                               "تاريخ أو وقت مطبوع على الصورة", f"«{text}» — {where}")
                elif (min(cx, 1 - cx) < 0.15 and min(cy, 1 - cy) < 0.15 and height < 0.08
                      and letters >= 3 and "corner" not in seen):
                    seen.add("corner")
                    report.add("local.corner_text", "overlays", Level.REVIEW,
                               "نص صغير في زاوية الصورة: توقيع أو علامة مائية؟", f"«{text}» — {where}")
            if ai and letters >= 3:
                (garbled if conf < self.config.ocr_confidence else clean_ai_text).append(text)

        if garbled:
            report.add("local.garbled_text", "ai_defects", Level.REVIEW,
                       "نص غير مقروء أو مشوّه، وهو من أشهر عيوب صور الذكاء الاصطناعي",
                       "، ".join(f"«{t}»" for t in garbled[:4]))
        elif clean_ai_text:
            report.add("local.ai_text", "ai_defects", Level.INFO,
                       "في الصورة المولّدة نص؛ تأكد من صحة كل حرف فيه", "، ".join(f"«{t}»" for t in clean_ai_text[:4]))

    def _check_faces(self, report: FileReport, bgr: np.ndarray) -> None:
        h, w = bgr.shape[:2]
        self.face_detector.setInputSize((w, h))
        _, faces = self.face_detector.detect(bgr)
        if faces is None:
            report.metrics["faces"] = 0.0
            return
        short = min(w, h)
        big = [f for f in faces if f[14] >= self.config.face_score and min(f[2], f[3]) >= self.config.face_min_share * short]
        report.metrics["faces"] = float(len(big))
        if not big:
            return
        largest = max(big, key=lambda f: f[2] * f[3])
        cx, cy = (largest[0] + largest[2] / 2) / w, (largest[1] + largest[3] / 2) / h
        detail = f"{len(big)} وجه، أكبرها {_where(cx, cy)} ({largest[2] / w:.0%} من عرض الصورة)"
        meta = report.metadata
        if meta.ai_generated:
            report.add("local.faces_ai", "people", Level.INFO,
                       "وجوه في صورة مولّدة: فعّل خيار \"People and Property are fictional\"", detail)
        elif not meta.releases:
            report.add("local.faces", "people", Level.REVIEW,
                       "وجه يمكن التعرف عليه؛ أرفق تصريح النموذج (Model Release) أو استبعد الصورة", detail)
