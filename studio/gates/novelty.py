"""The novelty gate. YouTube demonetises channels whose videos are "mass-produced or
repetitive" (the inauthentic content policy), and a production line is exactly where
that happens: the same beats, the same jokes, the same sentences. Each new script is
compared with every past one by word 3-grams; the catchphrases and names, which are meant
to repeat, are removed first so they do not hide or fake a repeat."""
from __future__ import annotations

from ..bible.models import Bible
from ..episode import Episode
from ..ledger import Past
from ..text import jaccard, normalize_words, shingles, term_regex
from . import GateReport

ERROR_AT = 0.30
WARN_AT = 0.20


def _strip(bible: Bible, text: str, lang: str) -> str:
    text = " ".join(normalize_words(text))
    for ch in bible.characters.values():
        phrase = ch.personality.speech.catchphrase.get(lang)
        if phrase:
            text = term_regex(" ".join(normalize_words(phrase))).sub(" ", text)
    names = {w for ch in bible.characters.values() for w in normalize_words(ch.name)}
    return " ".join(w for w in text.split() if w not in names)


def similarity(bible: Bible, a: str, b: str, lang: str) -> float:
    return jaccard(shingles(_strip(bible, a, lang)), shingles(_strip(bible, b, lang)))


def check_novelty(bible: Bible, ep: Episode, history: list[Past]) -> GateReport:
    r = GateReport("novelty")
    lang = ep.language
    mine = shingles(_strip(bible, ep.text(), lang))
    if len(mine) < 20:
        r.error("novelty.too_short", f"only {len(mine)} distinct 3-word phrases once catchphrases and names are removed")
    title = " ".join(normalize_words(ep.title))
    for p in history:
        if p.id == ep.id:
            continue
        if " ".join(normalize_words(p.title)) == title:
            r.error("novelty.title", f"same title as {p.id}: {p.title}")
        s = jaccard(mine, shingles(_strip(bible, p.script, lang)))
        if s >= ERROR_AT:
            r.error("novelty.repeat", f"{s:.0%} of its 3-word phrases are shared with {p.id} ({p.title}); rewrite, do not paraphrase")
        elif s >= WARN_AT:
            r.warn("novelty.close", f"{s:.0%} shared with {p.id} ({p.title})")
    return r
