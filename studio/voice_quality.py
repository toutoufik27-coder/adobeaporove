"""Studio quality for the synthetic voices. What makes a TTS line sound fake is rarely the
voice itself; it is the defects around it: a chipmunk timbre from a crude pitch shift, a
metallic or cut-off take, a half-second hiccup, a word skipped, one line louder than the
next, sibilants that hiss on a tablet speaker. Each has a fix here:

1. Pitch: in two stages. Only part of the shift moves the formants (the "size" of the
   voice): enough for a child's timbre, not so much that it turns into a cartoon squeak.
   The rest is pure pitch with the formants kept. Rubberband at its quality settings.
2. Takes: three per line (two rounds if needed); each is checked for similarity to the
   character, the words Whisper hears (names matched by sound, "zoo zoo" is Zuzu), and
   defects that can be measured: clipping, a long gap inside the line, a cut-off end,
   a line far too fast or too slow for its words (skipped or invented words), silence.
   The best take wins; a line whose best take still fails goes to a person.
3. Finishing, the same for every line: rumble cut, clicks removed, light denoise, less
   mud, more presence, de-essing, gentle compression, every line at the same loudness
   (-20 LUFS, peaks under -2 dBTP), clean edges with short fades, 48 kHz / 24-bit.
4. Distinct voices, measured: the median pitch (F0) of the finished references; two
   characters with the same pace less than 2 semitones apart are reported."""
from __future__ import annotations

import math
import subprocess
from pathlib import Path

from .gates.text import LANG_RATE, RATE, syllables_of
from .lipsync import read_pcm, rms_per_frame, silences
from .media.mix import parse_loudnorm
from .text import normalize_words, sentences

TAKES, ROUNDS = 3, 2
LINE_LUFS, LINE_TP_DB = -20.0, -2.0
OUT_RATE = 48000
FORMANT_SHARE = 0.6
MIN_F0_GAP = 2.0
RUBBERBAND_Q = "pitchq=quality:transients=mixed:detector=soft"


# ---------------------------------------------------------------- 1. pitch
def pitch_filter(semitones: float, formant_share: float = FORMANT_SHARE) -> str:
    """The shift in two rubberband stages: formants follow only formant_share of it."""
    s1 = semitones * formant_share
    s2 = semitones - s1
    parts = []
    if abs(s1) > 1e-9:
        parts.append(f"rubberband=pitch={2 ** (s1 / 12):.5f}:formant=shifted:{RUBBERBAND_Q}")
    if abs(s2) > 1e-9:
        parts.append(f"rubberband=pitch={2 ** (s2 / 12):.5f}:formant=preserved:{RUBBERBAND_Q}")
    return ",".join(parts) or "anull"


# ---------------------------------------------------------------- 2. takes
def expected_seconds(text: str, lang: str, pace: str) -> float:
    return syllables_of(text, lang) / (RATE[pace] * LANG_RATE.get(lang, 1.1))


def defects(path: Path, text: str, lang: str, pace: str) -> list[str]:
    """What can be measured wrong in a take, in words a person understands."""
    samples, sr = read_pcm(path)
    if not samples:
        return ["empty"]
    peak = max(abs(s) for s in samples)
    if peak < 0.01:
        return ["almost silent"]
    out = []
    clipped = sum(abs(s) >= 0.999 for s in samples) / len(samples)
    if clipped > 0.001:
        out.append(f"clipping ({clipped:.1%} of samples)")
    fps = 100
    rms = rms_per_frame(path, fps)
    quiet = silences(rms, fps, min_s=0.05, floor_db=-40)
    start = quiet[0][1] if quiet and quiet[0][0] == 0 else 0.0
    end = quiet[-1][0] if quiet and quiet[-1][1] >= len(rms) / fps - 1e-9 else len(rms) / fps
    for a, b in silences(rms, fps, min_s=max_gap(text), floor_db=-40):
        if a > start + 1e-9 and b < end - 1e-9:
            out.append(f"a {b - a:.1f}s gap inside the line")
    tail = rms[-3:]
    if tail and max(tail) > max(rms) * 10 ** (-25 / 20):
        out.append("cut off at the end")
    spoken, want = max(0.0, end - start), expected_seconds(text, lang, pace)
    if want >= 1.0:
        wrong = not 0.55 <= spoken / want <= 1.8
    else:  # "Oops!": a ratio means nothing for a word or two, an absolute margin does
        wrong = not 0.15 <= spoken <= want + 1.2
    if wrong:
        out.append(f"{spoken:.1f}s for about {want:.1f}s of words: skipped or invented words")
    return out


def max_gap(text: str) -> float:
    """The longest silence a line may hold: longer between sentences, longer after "…"."""
    return min(1.6, 0.7 + 0.4 * (len(sentences(text)) - 1) + 0.5 * ("…" in text or "..." in text))


def _lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


_SOUNDS = [("ph", "f"), ("ck", "k"), ("qu", "k"), ("c", "k"), ("oo", "u"), ("ou", "u"), ("ee", "i"), ("ea", "i"),
           ("y", "i"), ("ie", "i")]


def _sound(word: str) -> str:
    """A rough spelling-by-ear: "zoozoo", "keeko", "benny" -> "zuzu", "kiko", "beni"."""
    for a, b in _SOUNDS:
        word = word.replace(a, b)
    return "".join(ch for i, ch in enumerate(word) if i == 0 or ch != word[i - 1])


def match_names(heard: str, names: list[str]) -> str:
    """Whisper spells invented names its own way ("Zoo zoo", "Kico"): words that sound
    like a character's name become the name before the words are compared."""
    toks = normalize_words(heard)
    targets = {_sound(n): n for name in names for n in normalize_words(name)}
    out, i = [], 0
    while i < len(toks):
        for span in (2, 1):
            cand = _sound("".join(toks[i:i + span]))
            hit = next((n for k, n in targets.items()
                        if len(toks[i:i + span]) == span and _lev(cand, k) <= max(1, len(k) // 4)), None)
            if hit:
                out.append(hit)
                i += span
                break
        else:
            out.append(toks[i])
            i += 1
    return " ".join(out)


def take_score(similarity: float, wer: float, found: list[str]) -> float:
    return round(similarity - wer - 0.3 * len(found), 4)


# ---------------------------------------------------------------- 3. finishing
PRE = ("highpass=f=80,adeclick,afftdn=nr=8:nf=-45,"
       "equalizer=f=300:t=q:w=1:g=-2,equalizer=f=4000:t=q:w=1.2:g=2,deesser=i=0.4,"
       "acompressor=threshold=-24dB:ratio=3:attack=5:release=90:makeup=2,"
       "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,"
       "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,afade=t=in:d=0.015,areverse,"
       "afade=t=in:d=0.01")


def pre_argv(src: Path, dst: Path) -> list[str]:
    return ["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-af", PRE, "-c:a", "pcm_s24le", str(dst)]


def final_argv(src: Path, dst: Path, gain_db: float) -> list[str]:
    limit = 10 ** (LINE_TP_DB / 20)
    af = (f"volume={gain_db:.2f}dB,alimiter=limit={limit:.4f}:attack=5:release=50:level=false,"
          f"adelay=delays=40:all=1,apad=pad_dur=0.08,aresample={OUT_RATE}")
    return ["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-af", af, "-ar", str(OUT_RATE), "-c:a", "pcm_s24le", str(dst)]


def measure_argv(src: Path) -> list[str]:
    return ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src), "-af", "loudnorm=print_format=json", "-f", "null", "-"]


def finish_line(src: Path, dst: Path) -> Path:
    """The studio chain, in two passes so every line lands at the same loudness."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.stem + ".pre.wav")
    _run(pre_argv(src, tmp))
    loud = parse_loudnorm(_run(measure_argv(tmp)).stderr)["input_i"]
    if not math.isfinite(loud):
        raise ValueError(f"{src}: nothing audible to finish")
    _run(final_argv(tmp, dst, max(-20.0, min(20.0, LINE_LUFS - loud))))
    tmp.unlink(missing_ok=True)
    return dst


def _run(argv: list[str]) -> subprocess.CompletedProcess:
    p = subprocess.run(argv, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(f"ffmpeg failed: {p.stderr[-1500:]}")
    return p


# ---------------------------------------------------------------- 4. distinct voices
def f0_median(path: Path, fmin: float = 70.0, fmax: float = 700.0, max_s: float = 12.0) -> float | None:
    """Median pitch of the voiced parts (a YIN-style estimate with numpy), in Hz."""
    import numpy as np
    samples, sr = read_pcm(path)
    x = np.asarray(samples[: int(max_s * sr)], dtype=np.float64)
    n, hop = int(0.04 * sr), int(0.01 * sr)
    lo, hi = int(sr / fmax), min(int(sr / fmin), n - 1)
    if len(x) < n or hi <= lo:
        return None
    peak = np.max(np.abs(x)) or 1.0
    f0s = []
    for s in range(0, len(x) - n, hop):
        f = x[s:s + n]
        if np.sqrt(np.mean(f ** 2)) < 0.05 * peak:
            continue
        spec = np.fft.rfft(f, 2 * n)
        r = np.fft.irfft(spec * np.conj(spec))[:n]  # r[tau] = sum x[j] x[j + tau]
        cs = np.concatenate(([0.0], np.cumsum(f ** 2)))
        tau = np.arange(n)
        d = cs[n - tau] + (cs[n] - cs[tau]) - 2 * r  # sum (x[j] - x[j + tau])^2
        cm = d[1:] * np.arange(1, n) / np.maximum(np.cumsum(d[1:]), 1e-12)
        band = cm[lo - 1:hi]
        below = np.nonzero(band < 0.15)[0]
        if len(below):
            k = below[0]
            while k + 1 < len(band) and band[k + 1] < band[k]:
                k += 1
        else:
            k = int(np.argmin(band))
            if band[k] > 0.35:  # not clearly periodic
                continue
        f0s.append(sr / (k + lo))
    return float(np.median(f0s)) if f0s else None


def semitones_apart(a: float, b: float) -> float:
    return abs(12 * math.log2(a / b))


def voice_clashes(voices: dict[str, tuple[float, str]]) -> list[str]:
    """voices: name -> (median F0 in Hz, pace). Same pace and closer than 2 semitones."""
    out = []
    names = sorted(voices)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            (fa, pa), (fb, pb) = voices[a], voices[b]
            if pa == pb and semitones_apart(fa, fb) < MIN_F0_GAP:
                out.append(f"{a} and {b}: both {pa}, {fa:.0f} Hz and {fb:.0f} Hz "
                           f"({semitones_apart(fa, fb):.1f} semitones apart, want {MIN_F0_GAP:g})")
    return out
