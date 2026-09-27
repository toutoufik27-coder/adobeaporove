"""Gate 1: the text, deterministic, run again for every translation. Banned words (per
language, world rules, market sensitivities), sentence length per character, vocabulary
for ages 3-6, the episode structure, and dub length (±15 % so the timing holds)."""
from __future__ import annotations

import math
import re

from ..bible.models import Bible
from ..episode import Episode
from ..text import sentences, syllables, term_regex, words
from . import GateReport

DUB_RATIO = (0.85, 1.15)
# speech rate for ages 3-6, English syllables a second by the character's pace; languages
# with shorter syllables say more of them a second
RATE = {"slow": 3.2, "moderate": 3.7, "fast": 4.2}
LANG_RATE = {"en": 1.0, "es": 1.25, "pt": 1.2, "fr": 1.2, "it": 1.25}
LENGTH_ERROR, SEGMENT_WARN = 0.30, 0.50


def _terms(bible: Bible, lang: str) -> list[tuple[str, str, object]]:
    out = []
    lx = bible.lexicons[lang]
    for t in lx.banned:
        out.append(("lexicon.banned", t, term_regex(t)))
    for t in bible.world.rule_terms.get(lang, []):
        out.append(("world.rule", t, term_regex(t)))
    for cu in bible.cultures.values():
        if cu.language == lang:
            for t in cu.avoid_terms:
                out.append((f"culture.{cu.market}", t, term_regex(t)))
    return out


def check_text(bible: Bible, ep: Episode, lang: str | None = None) -> GateReport:
    lang = lang or ep.language
    r = GateReport(f"gate1:{lang}")
    lx = bible.lexicons.get(lang)
    if lx is None:
        r.error("lexicon.missing", f"no lexicon for {lang}: this language cannot be checked")
        return r
    primary = lang == ep.language
    terms = _terms(bible, lang)
    patterns = [re.compile(p, re.IGNORECASE) for p in lx.banned_patterns]
    allowed = {w.lower() for w in lx.allowed_long_words}
    names = {c.name.lower() for c in bible.characters.values()}
    tr = ep.translations.get(lang, {})
    per_speaker: dict[str, list[int]] = {}

    if primary:
        fmt = bible.formats.get(ep.format)
        if not fmt:
            r.error("format.unknown", f"no format {ep.format}")
        else:
            want = [s.id for s in fmt.template]
            got = [b.segment for b in ep.beats]
            if got != want:
                r.error("structure.segments", f"beats must follow the {fmt.id} template {want}, got {got}")
        places = {p.id for p in bible.world.places}
        for b in ep.beats:
            if b.place not in places:
                r.error("structure.place", f"unknown place {b.place} in {b.segment}")
            if b.lighting not in ("morning", "afternoon", "evening"):
                r.error("world.rule", f"lighting {b.lighting}: the world has no dark night")

    for line in ep.lines():
        text = line.text if primary else tr.get(line.id)
        if not text:
            r.error("dub.missing", f"no {lang} text", line.id)
            continue
        if primary and line.speaker not in ep.cast:
            r.error("structure.speaker", f"{line.speaker} speaks but is not in the cast", line.id)
        for code, term, rx in terms:
            if rx.search(text):
                r.error(code, f"'{term}' in: {text}", line.id)
        for p in patterns:
            if p.search(text):
                r.error("lexicon.pattern", f"matches {p.pattern}: {text}", line.id)
        ch = bible.characters.get(line.speaker)
        for s in sentences(text):
            n = len(words(s))
            if n > lx.max_sentence_words:
                r.error("speech.too_long", f"{n} words (cap {lx.max_sentence_words}): {s}", line.id)
            elif primary and ch and n > ch.personality.speech.sentence_words[1] + 2:
                lo, hi = ch.personality.speech.sentence_words
                r.error("speech.character", f"{ch.name} speaks {lo}-{hi} words; this sentence has {n}: {s}", line.id)
            if primary:
                per_speaker.setdefault(line.speaker, []).append(n)
        for wd in words(text):
            if syllables(wd, lang) > lx.max_syllables and wd.lower() not in allowed and wd.lower() not in names:
                msg = f"'{wd}' has {syllables(wd, lang)} syllables (max {lx.max_syllables}, not on the allow-list)"
                (r.error if primary else r.warn)("vocab.hard_word", msg, line.id)
        if not primary:
            ok, ratio = dub_fits(bible, line.speaker, line.text, ep.language, text, lang)
            if not ok:
                r.error("dub.length", f"about {ratio:.0%} of the original's speaking time "
                                      f"(allowed {DUB_RATIO[0]:.0%}-{DUB_RATIO[1]:.0%}): {text}", line.id)

    if primary and bible.formats.get(ep.format):
        fmt = bible.formats[ep.format]
        est = estimate_seconds(bible, ep)
        total = sum(est.values())
        if abs(total / fmt.duration_s - 1) > LENGTH_ERROR:
            r.error("structure.length", f"the script runs about {total:.0f}s; the format is {fmt.duration_s}s "
                                        f"(allowed ±{LENGTH_ERROR:.0%}): {'add lines or holds' if total < fmt.duration_s else 'cut'}")
        for seg in fmt.template:
            want = seg.end_s - seg.start_s
            got = est.get(seg.id, 0.0)
            if abs(got / want - 1) > SEGMENT_WARN:
                r.warn("structure.segment_length", f"{seg.id} runs about {got:.0f}s, planned {want:.0f}s")

    if primary:
        for sp, lens in per_speaker.items():
            ch = bible.characters.get(sp)
            if not ch or not lens:
                continue
            lo, hi = ch.personality.speech.sentence_words
            avg = sum(lens) / len(lens)
            if not lo - 1 <= avg <= hi + 1:
                r.warn("speech.voice", f"{ch.name} averages {avg:.1f} words a sentence (their voice is {lo}-{hi})")
        speaking = {l.speaker for l in ep.lines()}
        for c in ep.cast:
            if c not in speaking:
                r.warn("structure.silent", f"{c} is in the cast but never speaks")
        lead = bible.characters.get(ep.lead)
        if lead and lead.personality.speech.catchphrase.get(lang, "").lower() not in ep.text().lower():
            r.warn("structure.catchphrase", f"the lead's catchphrase is not used: {lead.personality.speech.catchphrase.get(lang)}")
    return r


def syllables_of(text: str, lang: str) -> int:
    return sum(syllables(w, lang) for w in words(text))


def estimate_seconds(bible: Bible, ep: Episode) -> dict[str, float]:
    """Seconds per segment before any audio exists, with the timeline's own constants."""
    from ..timing import GAP_S, LEAD_IN_S, MAX_SHOT_S, TAIL_S
    out: dict[str, float] = {}
    k = LANG_RATE.get(ep.language, 1.1)
    for beat in ep.beats:
        t = 0.0
        for line in beat.lines:
            ch = bible.characters.get(line.speaker)
            rate = RATE[ch.voice.pace if ch else "moderate"] * k
            t += syllables_of(line.text, ep.language) / rate + GAP_S + line.hold_s
        shots = max(1, math.ceil(t / (MAX_SHOT_S - LEAD_IN_S - TAIL_S)))
        out[beat.segment] = out.get(beat.segment, 0.0) + t + shots * (LEAD_IN_S + TAIL_S - GAP_S)
    return out


def speech_units(text: str, lang: str) -> float:
    """Syllables scaled to English speaking time: Spanish says about 25 % more syllables a
    second, so equal time is not equal syllables."""
    return syllables_of(text, lang) / LANG_RATE.get(lang, 1.1)


def dub_fits(bible: Bible, speaker: str, original: str, lang_o: str, dub: str, lang_d: str) -> tuple[bool, float]:
    """The dub within ±15 % of the original's speaking time. A character's catchphrase is
    fixed in every language, so it is taken out of both sides first; very short lines
    ("Oops!") are compared by an absolute margin, where a percentage means nothing."""
    ch = bible.characters.get(speaker)
    if ch:
        po, pd = ch.personality.speech.catchphrase.get(lang_o), ch.personality.speech.catchphrase.get(lang_d)
        if po and pd and term_regex(po).search(original) and term_regex(pd).search(dub):
            original, dub = term_regex(po).sub(" ", original), term_regex(pd).sub(" ", dub)
    a, b = speech_units(original, lang_o), speech_units(dub, lang_d)
    ratio = b / a if a else (1.0 if not b else 9.99)
    if a < 3:
        return abs(b - a) <= 1.5, ratio
    return DUB_RATIO[0] <= ratio <= DUB_RATIO[1], ratio
