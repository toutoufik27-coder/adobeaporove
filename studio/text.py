"""Text measurement shared by the gates: sentences, words, syllables, n-grams."""
from __future__ import annotations

import re
import unicodedata

_WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*", re.UNICODE)


def sentences(text: str) -> list[str]:
    """Sentences of a line; an ellipsis ends a sentence ("Wait… let's think.")."""
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+", text.strip())]
    return [p for p in parts if _WORD.search(p)]


def words(text: str) -> list[str]:
    return _WORD.findall(text)


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def syllables(word: str, lang: str) -> int:
    """Approximate syllable count. English: vowel groups, minus a silent final e.
    Spanish and other languages written phonetically: vowel groups, where a weak vowel
    next to another vowel is one syllable (diphthong) unless it carries an accent."""
    w = word.lower()
    if lang == "en":
        w = re.sub(r"[^a-z]", "", w)
        if not w:
            return 0
        groups = re.findall(r"[aeiouy]+", w)
        n = len(groups)
        if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and n > 1:
            n -= 1
        if re.search(r"[^aeiou]ed$", w) and not re.search(r"[td]ed$", w) and n > 1:
            n -= 1  # "jumped", not "wanted"
        return max(1, n)
    if lang in ("es", "pt", "it"):
        accented_weak = set("íúÍÚ")
        n, prev = 0, None  # prev: kind of the vowel just before, or None after a consonant
        for ch in word:
            base = _strip_accents(ch).lower()
            if base not in "aeiou":
                prev = None
                continue
            kind = "strong" if base in "aeo" or ch in accented_weak else "weak"
            if prev is None or (prev == "strong" and kind == "strong"):
                n += 1  # a new nucleus, or a hiatus of two strong vowels
            prev = kind  # otherwise a diphthong: same syllable
        return max(1, n)
    return max(1, len(re.findall(r"[aeiouyáéíóúàèìòùâêîôûäëïöü]+", w)))


def normalize_words(text: str) -> list[str]:
    """Lower case, no accents, no apostrophes: "Let's" and "lets" are the same word."""
    return [_strip_accents(w.lower()).replace("'", "").replace("’", "") for w in words(text)]


def shingles(text: str, n: int = 3) -> set[tuple[str, ...]]:
    ws = normalize_words(text)
    return {tuple(ws[i:i + n]) for i in range(len(ws) - n + 1)}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def word_error_rate(expected: str, heard: str) -> float:
    """Word-level Levenshtein distance / expected length (0 = identical)."""
    e, h = normalize_words(expected), normalize_words(heard)
    if not e:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, we in enumerate(e, 1):
        cur = [i] + [0] * len(h)
        for j, wh in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (we != wh))
        prev = cur
    return prev[-1] / len(e)


def term_regex(term: str) -> re.Pattern:
    """A banned word or phrase on word boundaries, case-insensitive, any spacing."""
    parts = [re.escape(p) for p in term.split()]
    return re.compile(r"(?<![^\W_])" + r"\s+".join(parts) + r"(?![^\W_])", re.IGNORECASE | re.UNICODE)
