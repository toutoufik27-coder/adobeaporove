"""What a check reports, and how findings turn into a verdict for one file."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class Level(IntEnum):
    # Advice only: shown in the report, never moves the file out of "pass".
    INFO = 0
    # A real risk of rejection that needs a human look (heuristic, or a visual check by Claude).
    REVIEW = 1
    # A measured violation of a published Adobe Stock rule.
    REJECT = 2


class Verdict(IntEnum):
    PASS = 0
    REVIEW = 1
    REJECT = 2

    @property
    def folder(self) -> str:
        return ("pass", "review", "reject")[self]

    @property
    def label(self) -> str:
        return ("مقبول", "مراجعة", "مرفوض")[self]


# The eleven groups of the Adobe Stock rules brief, in its order.
GROUPS: dict[str, str] = {
    "technical": "المواصفات التقنية",
    "quality": "جودة الصورة",
    "ai_defects": "عيوب التوليد بالذكاء الاصطناعي",
    "ai_rules": "قواعد المحتوى المولّد",
    "ip": "الملكية الفكرية",
    "people": "الأشخاص والممتلكات",
    "similar": "التشابه والتكرار",
    "appeal": "القيمة الجمالية أو التجارية",
    "overlays": "عناصر مرئية ممنوعة",
    "metadata": "العنوان والكلمات المفتاحية",
    "prohibited": "المحتوى المحظور",
}


@dataclass
class Finding:
    rule: str
    group: str
    level: Level
    message: str
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "rule": self.rule,
            "group": self.group,
            "level": self.level.name.lower(),
            "message": self.message,
            "detail": self.detail,
        }


@dataclass
class Metadata:
    title: str = ""
    keywords: list[str] = field(default_factory=list)
    category: str = ""
    releases: str = ""
    source: str = ""  # "csv", "embedded" or ""
    ai_generated: bool = False
    ai_evidence: str = ""
    prompt: str = ""


@dataclass
class FileReport:
    path: str
    name: str
    kind: str  # jpeg, png, svg, eps, ai, other
    size_bytes: int
    width: int = 0
    height: int = 0
    findings: list[Finding] = field(default_factory=list)
    metrics: dict[str, float] = field(default_factory=dict)
    metadata: Metadata = field(default_factory=Metadata)
    phash: int | None = None
    phash_mirror: int | None = None
    thumbnail: bytes = b""
    sha256: str = ""
    vision_checked: bool = False

    @property
    def verdict(self) -> Verdict:
        worst = max((f.level for f in self.findings), default=Level.INFO)
        return Verdict(int(worst)) if worst > Level.INFO else Verdict.PASS

    @property
    def is_raster(self) -> bool:
        return self.kind in ("jpeg", "png")

    @property
    def megapixels(self) -> float:
        return self.width * self.height / 1_000_000

    def add(self, rule: str, group: str, level: Level, message: str, detail: str = "") -> None:
        self.findings.append(Finding(rule, group, level, message, detail))

    def to_dict(self) -> dict:
        return {
            "file": self.name,
            "path": self.path,
            "kind": self.kind,
            "verdict": self.verdict.folder,
            "width": self.width,
            "height": self.height,
            "size_bytes": self.size_bytes,
            "metrics": {k: round(v, 3) for k, v in self.metrics.items()},
            "vision_checked": self.vision_checked,
            "metadata": {
                "title": self.metadata.title,
                "keywords": self.metadata.keywords,
                "source": self.metadata.source,
                "ai_generated": self.metadata.ai_generated,
                "ai_evidence": self.metadata.ai_evidence,
            },
            "findings": [f.to_dict() for f in self.findings],
        }
