"""Optional visual review by Claude: what only eyes can judge (AI defects, logos, people, overlays...).

Every visual finding goes to "review", never straight to "reject": the model can be wrong, and the
point is to show you where to look. Results are cached by file hash so a re-run costs nothing.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import threading
from pathlib import Path

from PIL import Image

from ..config import Config
from ..findings import FileReport, Level
from ..imaging import downscale

PROMPT_VERSION = "1"
CROP = 768
# Models that accept server-side refusal fallbacks.
FALLBACK_MODELS = {"claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"}

CATEGORIES: dict[str, tuple[str, str]] = {
    "ai_anatomy": ("ai_defects", "تشوه في الأيدي أو الوجوه أو الأجسام"),
    "ai_object_defect": ("ai_defects", "أجسام ذائبة أو هندسة مستحيلة أو أجزاء ناقصة"),
    "garbled_text": ("ai_defects", "نص ذائب أو حروف غير مفهومة"),
    "ai_texture": ("ai_defects", "ملمس مكرر أو بلاستيكي أو تفاصيل مصطنعة"),
    "logo_trademark": ("ip", "شعار أو علامة تجارية ظاهرة"),
    "product_design": ("ip", "منتج بتصميم مميز كموضوع رئيسي"),
    "protected_artwork": ("ip", "عمل فني أو شخصية محمية"),
    "restricted_landmark": ("ip", "معلم أو مبنى قد يحتاج تصريحاً"),
    "recognizable_person": ("people", "شخص يمكن التعرف عليه"),
    "minor": ("people", "قاصر يظهر في الصورة"),
    "private_property": ("people", "ممتلكات خاصة قد تحتاج تصريحاً"),
    "watermark_signature": ("overlays", "علامة مائية أو توقيع أو شعار شخصي"),
    "date_stamp": ("overlays", "تاريخ أو وقت مطبوع"),
    "frame_border": ("overlays", "إطار أو حدود مضافة"),
    "screenshot_ui": ("overlays", "لقطة شاشة أو عناصر واجهة"),
    "focus_blur": ("quality", "تركيز خاطئ أو ضبابية"),
    "noise_grain": ("quality", "ضوضاء أو حبيبات"),
    "exposure": ("quality", "إضاءة زائدة أو ظلام يُفقد التفاصيل"),
    "over_processing": ("quality", "معالجة مفرطة أو هالات أو حدة زائدة"),
    "compression_artifacts": ("quality", "آثار ضغط"),
    "upscaling_artifacts": ("quality", "آثار تكبير الدقة"),
    "chromatic_aberration": ("quality", "زيغ لوني حول الحواف"),
    "sensor_dust": ("quality", "بقع غبار"),
    "tilted_horizon": ("quality", "أفق مائل"),
    "fake_transparency": ("technical", "خلفية شطرنجية مرسومة"),
    "news_event": ("ai_rules", "يوحي بحدث إخباري حقيقي"),
    "prohibited_content": ("prohibited", "محتوى محظور"),
    "other": ("quality", "مشكلة أخرى"),
}

SCHEMA = {
    "type": "object",
    "properties": {
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": list(CATEGORIES)},
                    "confidence": {"type": "string", "enum": ["high", "medium"]},
                    "where": {"type": "string"},
                    "explanation_ar": {"type": "string"},
                },
                "required": ["category", "confidence", "where", "explanation_ar"],
                "additionalProperties": False,
            },
        },
        "looks_ai_generated": {"type": "boolean"},
        "photorealistic": {"type": "boolean"},
        "people": {"type": "string", "enum": ["none", "unrecognizable", "recognizable"]},
        "commercial_appeal": {"type": "string", "enum": ["low", "medium", "high"]},
        "appeal_note_ar": {"type": "string"},
        "irrelevant_keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "issues", "looks_ai_generated", "photorealistic", "people",
        "commercial_appeal", "appeal_note_ar", "irrelevant_keywords",
    ],
    "additionalProperties": False,
}

SYSTEM = """You review images right before a contributor submits them to Adobe Stock. Your job is to catch what \
would get the file rejected, so the contributor can fix or drop it first. Measurable checks (resolution, file size, \
color profile, sharpness and noise statistics, duplicates) are already done by code; you look for what needs eyes.

You get two views of one file: the whole image scaled down, and a crop at 100% (actual pixels) from its most \
detailed area. Adobe reviewers inspect at 100%, so judge pixel-level quality from the crop.

Report an issue only when you can point to where it is in the image. Use these categories:
- ai_anatomy: extra/missing/fused fingers, deformed hands, limbs or bodies, unnatural faces, eyes or teeth.
- ai_object_defect: melted or merging objects, impossible geometry, missing parts, broken physics.
- garbled_text: nonsense letters or melted text anywhere, including signs, labels, books and screens.
- ai_texture: repeated, plastic or waxy texture, fake detail invented by an upscaler.
- logo_trademark: any visible logo, brand name or recognizable trade dress, even small or partial.
- product_design: a product with a distinctive, identifiable design as the main subject (cars, sneakers, \
electronics, designer furniture, toys).
- protected_artwork: paintings, murals, street art, sculptures, tattoos or cartoon/film/game characters, \
including look-alikes.
- restricted_landmark: buildings or landmarks with distinctive architecture that may need a property release.
- recognizable_person: a real-looking person who could be identified by face, tattoo or context.
- minor: a person who appears to be under 18.
- private_property: identifiable private homes, interiors, pets as the subject, or artworks that need a release.
- watermark_signature, date_stamp, frame_border, screenshot_ui: anything added on top of the picture.
- focus_blur, noise_grain, exposure, over_processing (halos, oversharpening), compression_artifacts, \
upscaling_artifacts, chromatic_aberration, sensor_dust, tilted_horizon: technical quality problems visible at 100%.
- fake_transparency: a painted gray/white checkerboard pretending to be a transparent background.
- news_event: the image looks like documentation of a real news event.
- prohibited_content: nudity, sexual content, graphic violence or gore, hate symbols, illegal activity, self-harm.
- other: any other concrete reason Adobe would reject it.

Use confidence "high" only when a reviewer would certainly agree. Do not report deliberate style: shallow depth of \
field with a sharp subject, intentional motion blur, or a clean studio background are fine. If nothing is wrong, \
return an empty issues list; that is a good outcome, not a failure.

Also judge: whether the image looks AI-generated; whether it is photorealistic (it should then be submitted as \
Photo, otherwise Illustration); whether people appear and could be recognized; and commercial appeal, meaning how \
likely a designer or advertiser is to license it (saturated subjects shown in an ordinary way are low). If \
keywords are given, list the ones that do not describe anything in the image.

Write "where" and every "_ar" field in Arabic, short and concrete (for example: "اليد اليسرى، ستة أصابع")."""

SUMMARY_TEXT = "الصورة كاملة (مصغرة)."
CROP_TEXT = "قص بتكبير 100% من المنطقة الأكثر تفصيلاً."


class VisionUnavailable(RuntimeError):
    """Vision cannot run at all (no credentials, unknown model, missing package)."""


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _jpeg_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def prepare_views(path: Path, report: FileReport, max_side: int) -> tuple[str, str]:
    with Image.open(path) as img:
        img.load()
        if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info:
            # Show cut-outs on mid gray so both light and dark edges stay visible.
            rgba = img.convert("RGBA")
            base = Image.new("RGBA", rgba.size, (128, 128, 128, 255))
            base.alpha_composite(rgba)
            rgb = base.convert("RGB")
        else:
            rgb = img.convert("RGB")
    w, h = rgb.size
    cx = int(report.metrics.get("detail_x", w / 2))
    cy = int(report.metrics.get("detail_y", h / 2))
    size = min(CROP, w, h)
    left = min(max(0, cx - size // 2), w - size)
    top = min(max(0, cy - size // 2), h - size)
    crop = rgb.crop((left, top, left + size, top + size))
    return _jpeg_b64(downscale(rgb, max_side)), _jpeg_b64(crop)


class VisionReviewer:
    def __init__(self, config: Config, cache_path: Path | None):
        try:
            import anthropic
        except ImportError as e:
            raise VisionUnavailable("مكتبة anthropic غير مثبتة: pip install anthropic") from e
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(max_retries=4)
        # Without a key, token or `ant auth login` profile the SDK only fails at the first request.
        if not (self.client.api_key or self.client.auth_token or getattr(self.client, "credentials", None)):
            raise VisionUnavailable("لا يوجد مفتاح Claude API؛ عيّن المتغير ANTHROPIC_API_KEY")
        self.config = config.vision
        self.cache_path = cache_path
        self.cache: dict[str, dict] = {}
        if cache_path and cache_path.exists():
            try:
                self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self.cache = {}
        self.lock = threading.Lock()
        self._dirty = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0

    def _key(self, report: FileReport) -> str:
        return f"{report.sha256}:{self.config.model}:{PROMPT_VERSION}:{','.join(report.metadata.keywords)}"

    def save_cache(self) -> None:
        """Write the cache atomically, so an interrupted run never loses what was already paid for."""
        if not self.cache_path or not self._dirty:
            return
        with self.lock:
            data = json.dumps(self.cache, ensure_ascii=False)
            self._dirty = 0
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, self.cache_path)

    def _request(self, overview: str, crop: str, report: FileReport):
        meta = report.metadata
        facts = [
            f"Title: {meta.title or '(none)'}",
            f"Keywords: {', '.join(meta.keywords) if meta.keywords else '(none)'}",
            f"Declared as AI-generated: {'yes' if meta.ai_generated else 'unknown'}",
            f"Releases on file: {meta.releases or 'none listed'}",
        ]
        output_config: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
        if self.config.effort:
            output_config["effort"] = self.config.effort
        kwargs: dict = {}
        if self.config.model in FALLBACK_MODELS:
            kwargs = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
        return self.client.beta.messages.create(
            model=self.config.model,
            max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": overview}},
                    {"type": "text", "text": SUMMARY_TEXT},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": crop}},
                    {"type": "text", "text": CROP_TEXT + "\n\n" + "\n".join(facts)},
                ],
            }],
            output_config=output_config,
            **kwargs,
        )

    def fetch(self, path: Path, report: FileReport) -> dict:
        """The parsed review for one file, from cache or from the API. Raises VisionUnavailable."""
        key = self._key(report)
        with self.lock:
            if key in self.cache:
                return self.cache[key]
        overview, crop = prepare_views(path, report, self.config.max_side)
        a = self.anthropic
        try:
            response = self._request(overview, crop, report)
        except (a.AuthenticationError, a.PermissionDeniedError) as e:
            raise VisionUnavailable(f"مفتاح Claude API غير صالح أو بلا صلاحية: {e.message}") from e
        except a.NotFoundError as e:
            raise VisionUnavailable(f"النموذج {self.config.model} غير متاح: {e.message}") from e
        except a.BadRequestError as e:
            return {"error": f"طلب مرفوض من API: {e.message}"}
        except a.RateLimitError:
            return {"error": "تجاوزت حد الطلبات في Claude API؛ أعد التشغيل لاحقاً"}
        except a.APIStatusError as e:
            return {"error": f"خطأ من Claude API ({e.status_code})"}
        except a.APIConnectionError:
            return {"error": "تعذّر الاتصال بـ Claude API"}

        with self.lock:
            self.calls += 1
            self.input_tokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens or 0) + (
                response.usage.cache_creation_input_tokens or 0)
            self.output_tokens += response.usage.output_tokens

        if response.stop_reason == "refusal":
            result: dict = {"refusal": True}
        elif response.stop_reason == "max_tokens":
            return {"error": "انقطع رد Claude قبل اكتماله"}
        else:
            text = next((b.text for b in response.content if b.type == "text"), "")
            try:
                result = json.loads(text)
            except ValueError:
                return {"error": "رد Claude ليس JSON صالحاً"}
        with self.lock:
            self.cache[key] = result
            self._dirty += 1
            flush = self._dirty >= 20
        if flush:
            self.save_cache()
        return result


def apply_review(report: FileReport, result: dict) -> None:
    if "error" in result:
        report.add("vision.failed", "quality", Level.REVIEW,
                   "لم يكتمل الفحص البصري لهذه الصورة، فافحصها بعينك", result["error"])
        return
    report.vision_checked = True
    if result.get("refusal"):
        report.add("vision.refused", "prohibited", Level.REVIEW,
                   "رفض Claude مراجعة الصورة، وقد يعني ذلك محتوى محظوراً؛ افحصها بعينك")
        return
    meta = report.metadata
    for issue in result.get("issues", []):
        group, label = CATEGORIES.get(issue.get("category", "other"), CATEGORIES["other"])
        if issue.get("category") == "recognizable_person" and meta.releases:
            continue
        sure = "مؤكد" if issue.get("confidence") == "high" else "محتمل"
        parts = [issue.get("explanation_ar", ""), issue.get("where", "")]
        detail = " — ".join(p for p in parts if p) + f" ({sure})"
        report.add(f"vision.{issue.get('category', 'other')}", group, Level.REVIEW, f"{label} (بحسب Claude)", detail)

    ai = meta.ai_generated
    if result.get("people") == "recognizable" and not meta.releases and not ai and not any(
        f.rule in ("vision.recognizable_person", "local.faces") for f in report.findings
    ):
        report.add("vision.people_release", "people", Level.REVIEW,
                   "يظهر شخص يمكن التعرف عليه؛ أرفق تصريح النموذج (Model Release)")
    if result.get("looks_ai_generated") and not ai:
        report.add("vision.looks_ai", "ai_rules", Level.INFO,
                   "تبدو الصورة مولّدة بالذكاء الاصطناعي؛ إن كانت كذلك ففعّل خيار الذكاء الاصطناعي عند الإرسال")
    if ai or result.get("looks_ai_generated"):
        kind = "Photo" if result.get("photorealistic") else "Illustration"
        report.add("vision.submit_as", "ai_rules", Level.INFO, f"أرسلها كنوع {kind}")
    if result.get("commercial_appeal") == "low":
        report.add("vision.appeal", "appeal", Level.INFO, "قيمة تجارية منخفضة في تقدير Claude",
                   result.get("appeal_note_ar", ""))
    irrelevant = [k for k in result.get("irrelevant_keywords", []) if k]
    if irrelevant:
        level = Level.REVIEW if len(irrelevant) >= 3 else Level.INFO
        report.add("vision.keywords", "metadata", level, "كلمات مفتاحية لا تصف ما في الصورة", "، ".join(irrelevant[:12]))
