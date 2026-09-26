"""Title and keyword rules, blocked names, and AI-content reminders."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path

from ..config import Config
from ..findings import FileReport, Level

SECTION_LABELS = {
    "brand": "علامة تجارية",
    "sports_org": "علامة رياضية محمية",
    "character": "شخصية محمية",
    "artist": "اسم فنان",
    "person": "اسم شخص حقيقي",
    "landmark": "معلم ممنوع في قائمة Adobe",
    "landmark_check": "معلم قد يكون مقيداً",
    "custom": "كلمة من قائمتك",
}
SECTION_GROUPS = {
    "brand": "ip", "sports_org": "ip", "character": "ip", "landmark": "ip", "landmark_check": "ip",
    "artist": "ip", "person": "people", "custom": "metadata",
}
REVIEW_SECTIONS = {"landmark_check"}

NEWS_WORDS = ("news", "breaking news", "editorial", "photojournalism", "war in", "invasion of")

SCRIPTS = {
    "لاتينية": r"[A-Za-zÀ-ɏ]",
    "عربية": r"[؀-ۿݐ-ݿ]",
    "سيريلية": r"[Ѐ-ӿ]",
    "يونانية": r"[Ͱ-Ͽ]",
    "عبرية": r"[֐-׿]",
    "تايلاندية": r"[฀-๿]",
    "صينية/يابانية/كورية": r"[぀-ヿ一-鿿가-힯]",
}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
URL = re.compile(r"https?://|www\.", re.I)
PHONE = re.compile(r"\+?\d[\d\s().-]{8,}\d")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"['’`]", "", text)
    text = re.sub(r"[^\w]+", " ", text)
    return " ".join(text.split())


@dataclass
class Blocklist:
    entries: dict[str, str] = field(default_factory=dict)  # normalized phrase -> section
    allow: list[str] = field(default_factory=list)

    @classmethod
    def load(cls, extra: Path | None = None) -> Blocklist:
        bl = cls()
        text = resources.files("quality_guard").joinpath("data/blocklist.txt").read_text(encoding="utf-8")
        bl._parse(text, default_section="brand")
        if extra is not None:
            bl._parse(extra.read_text(encoding="utf-8"), default_section="custom")
        return bl

    def _parse(self, text: str, default_section: str) -> None:
        section = default_section
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1].strip()
                continue
            phrase = normalize(line)
            if not phrase:
                continue
            if section == "allow":
                self.allow.append(phrase)
            else:
                self.entries.setdefault(phrase, section)

    def find(self, text: str) -> list[tuple[str, str]]:
        """(phrase, section) for every blocked phrase in text, longest phrases first, no overlaps."""
        norm = f" {normalize(text)} "
        for phrase in self.allow:
            norm = norm.replace(f" {phrase} ", " ")
        hits: list[tuple[str, str]] = []
        for phrase in sorted(self.entries, key=len, reverse=True):
            for form in (phrase, phrase + "s"):
                needle = f" {form} "
                if needle in norm:
                    hits.append((phrase, self.entries[phrase]))
                    norm = norm.replace(needle, " ")
                    break
        return hits


def _scripts(text: str) -> list[str]:
    return [name for name, pattern in SCRIPTS.items() if len(re.findall(pattern, text)) >= 3]


def check_metadata(report: FileReport, config: Config, blocklist: Blocklist) -> None:
    meta = report.metadata
    rules = config.metadata
    title, keywords = meta.title.strip(), meta.keywords

    if len(title) > rules.title_max:
        report.add("meta.title_long", "metadata", Level.REVIEW,
                   f"العنوان أطول من الحد ({rules.title_max} حرفاً)", f"{len(title)} حرفاً")
    elif len(title) > rules.title_recommended:
        report.add("meta.title_length", "metadata", Level.INFO,
                   f"يُفضَّل أن يكون العنوان أقل من {rules.title_recommended} حرفاً", f"{len(title)} حرفاً")

    if keywords:
        if len(keywords) > rules.keywords_max:
            report.add("meta.keywords_many", "metadata", Level.INFO,
                       f"أكثر من {rules.keywords_max} كلمة مفتاحية، وAdobe يحتفظ بأول {rules.keywords_max} فقط",
                       f"{len(keywords)} كلمة")
        elif len(keywords) < rules.keywords_min:
            report.add("meta.keywords_few", "metadata", Level.INFO,
                       "عدد الكلمات المفتاحية قليل، مما يُضعف ظهور الصورة في البحث", f"{len(keywords)} كلمة")
        lowered = [normalize(k) for k in keywords]
        dupes = sorted({k for k in lowered if lowered.count(k) > 1})
        if dupes:
            report.add("meta.keywords_dupes", "metadata", Level.INFO, "كلمات مفتاحية مكررة", "، ".join(dupes[:10]))
        long_ones = [k for k in keywords if len(k.split()) > 4 or len(k) > 40]
        if long_ones:
            report.add("meta.keywords_phrases", "metadata", Level.REVIEW,
                       "كلمات مفتاحية طويلة تشبه الجمل، وقد تُعتبر spam", "، ".join(long_ones[:5]))

    text = " ".join([title, *keywords])
    for phrase, section in blocklist.find(text):
        level = Level.REVIEW if section in REVIEW_SECTIONS else Level.REJECT
        report.add(f"meta.blocked.{section}", SECTION_GROUPS.get(section, "metadata"), level,
                   f"{SECTION_LABELS.get(section, 'كلمة ممنوعة')} في العنوان أو الكلمات المفتاحية", phrase)

    if EMAIL.search(text) or URL.search(text) or PHONE.search(text):
        report.add("meta.personal_info", "metadata", Level.REVIEW,
                   "العنوان أو الكلمات تحتوي على بريد أو رابط أو رقم هاتف")

    scripts = _scripts(text)
    if len(scripts) > 1:
        report.add("meta.mixed_language", "metadata", Level.REVIEW,
                   "العنوان والكلمات بأكثر من لغة، وAdobe يطلب لغة واحدة", " + ".join(scripts))

    if meta.ai_generated:
        report.add("ai.flag_reminder", "ai_rules", Level.INFO,
                   "صورة مولّدة بالذكاء الاصطناعي: فعّل خيار \"Created using generative AI tools\" عند الإرسال، "
                   "و\"People and Property are fictional\" إن ظهر فيها أشخاص أو ممتلكات",
                   meta.ai_evidence)
        news = [w for w in NEWS_WORDS if f" {w} " in f" {normalize(text)} "]
        if news:
            report.add("ai.news_words", "ai_rules", Level.REVIEW,
                       "كلمات توحي بحدث إخباري حقيقي في صورة مولّدة", "، ".join(news))
        for phrase, section in blocklist.find(meta.prompt):
            if section == "custom":
                continue
            level = Level.REVIEW if section in REVIEW_SECTIONS else Level.REJECT
            report.add(f"ai.prompt_blocked.{section}", "ai_rules", level,
                       f"الـ prompt المحفوظ في الملف يحتوي على {SECTION_LABELS.get(section, 'اسم ممنوع')}", phrase)
