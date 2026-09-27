"""Voices, levels 0-2 of the training lab.

Level 0, design: Parler-TTS reads the character's description; 20 candidates with
different seeds; the chosen one is pitched up with rubberband (never above +5
semitones) and becomes the reference. The recipe (model, description, seed, pitch) is
saved: it is the proof of where the voice came from, and it remakes the voice.

Level 1, speech: Chatterbox (English) and Chatterbox Multilingual (the dubs) speak each
line with the character's reference, one line at a time so the voice does not drift.
The line's feeling picks an emotional reference when one exists (kiko_happy.wav).
Every line is checked: Resemblyzer similarity to the reference >= 0.75, and Whisper
must hear the written words. A line that fails is made again with the next seed, up
to three times, then it is flagged for a person.

Level 2, RVC: advised when more than 15 % of the lines fail the similarity check.

The GPU models are adapters, imported only when used; the loop, the checks and the
decisions are plain code and are tested with fakes."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from .bible.models import Character
from .episode import Episode
from .text import word_error_rate

MIN_SIMILARITY = 0.75
MAX_WER = 0.15
ATTEMPTS = 3
RVC_FAIL_RATE = 0.15
MAX_PITCH = 5
DESIGN_LINE = "Wow! What is that? Let's find out! Ha ha, come on, follow me!"


def pitch_ratio(semitones: float) -> float:
    if semitones > MAX_PITCH:
        raise ValueError(f"+{semitones} semitones sounds like a chipmunk: choose a higher candidate instead (max +{MAX_PITCH})")
    return 2 ** (semitones / 12)


def pitch_argv(src: Path, dst: Path, semitones: float) -> list[str]:
    """The reference: pitched (formants move too, hence the +5 cap) and levelled."""
    return ["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-af",
            f"rubberband=pitch={pitch_ratio(semitones):.4f},loudnorm=I=-16:TP=-1.5", "-ar", "24000", str(dst)]


@dataclass(frozen=True)
class Recipe:
    character: str
    model: str
    description: str
    line: str
    seed: int
    pitch_semitones: float

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2) + "\n", encoding="utf-8")


def ref_for(root: Path, ch: Character, lang: str, emotion: str = "neutral") -> Path:
    """The reference for this language, or its emotional variant when one was made."""
    if lang not in ch.voice.refs:
        raise ValueError(f"{ch.name} has no {lang} reference: make one with cfg_weight=0 first")
    base = root / ch.voice.refs[lang]
    emotional = base.with_name(f"{base.stem}_{emotion}{base.suffix}")
    return emotional if emotion != "neutral" and emotional.exists() else base


class Synth(Protocol):
    def __call__(self, text: str, lang: str, ref: Path, exaggeration: float, cfg_weight: float, seed: int, out: Path) -> float:
        """Writes 16-bit PCM wav to out, returns its length in seconds."""


@dataclass(frozen=True)
class LineVoice:
    line_id: str
    path: str
    seconds: float
    similarity: float
    wer: float
    attempts: int
    passed: bool


def speak_line(line_id: str, text: str, lang: str, ch: Character, ref: Path, main_ref: Path, out: Path,
               synth: Synth, similarity, transcribe, seed: int) -> LineVoice:
    best = None
    for attempt in range(ATTEMPTS):
        seconds = synth(text, lang, ref, ch.voice.exaggeration, ch.voice.cfg_weight, seed + attempt, out)
        sim = similarity(main_ref, out)
        wer = word_error_rate(text, transcribe(out, lang))
        ok = sim >= MIN_SIMILARITY and wer <= MAX_WER
        best = LineVoice(line_id, str(out), round(seconds, 3), round(sim, 3), round(wer, 3), attempt + 1, ok)
        if ok:
            break
    return best


def voice_episode(root: Path, bible, ep: Episode, lang: str, out_dir: Path, synth: Synth, similarity, transcribe,
                  log=print) -> dict:
    """Every line of one language. Returns the report; writes lengths.json for `studio plan`."""
    results = []
    for line in ep.lines():
        ch = bible.characters[line.speaker]
        text = line.text if lang == ep.language else ep.translations[lang][line.id]
        seed = int(ch.id[3:]) * 1000  # a fixed seed per character
        r = speak_line(line.id, text, lang, ch, ref_for(root, ch, lang, line.emotion), ref_for(root, ch, lang),
                       out_dir / f"{line.id}.wav", synth, similarity, transcribe, seed)
        if not r.passed:
            log(f"FLAGGED {line.id} {ch.name}: similarity {r.similarity}, WER {r.wer} after {r.attempts} tries")
        results.append(r)
    failed = [r for r in results if r.similarity < MIN_SIMILARITY]
    report = {
        "language": lang,
        "lines": [asdict(r) for r in results],
        "flagged": [r.line_id for r in results if not r.passed],
        "rvc_advised": len(failed) > RVC_FAIL_RATE * len(results),
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "lengths.json").write_text(json.dumps({r.line_id: r.seconds for r in results}, indent=1) + "\n")
    (out_dir / "voice_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return report


# ---------------------------------------------------------------- GPU adapters
class Chatterbox:
    """Chatterbox for English, Chatterbox Multilingual for the dubs (MIT)."""

    def __init__(self, device: str = "cuda"):
        self.device, self._en, self._mtl = device, None, None

    def __call__(self, text, lang, ref, exaggeration, cfg_weight, seed, out) -> float:
        import torch
        import torchaudio as ta
        torch.manual_seed(seed)
        if lang == "en":
            if self._en is None:
                from chatterbox.tts import ChatterboxTTS
                self._en = ChatterboxTTS.from_pretrained(device=self.device)
            model = self._en
            wav = model.generate(text, audio_prompt_path=str(ref), exaggeration=exaggeration, cfg_weight=cfg_weight)
        else:
            if self._mtl is None:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                self._mtl = ChatterboxMultilingualTTS.from_pretrained(device=self.device)
            model = self._mtl
            wav = model.generate(text, language_id=lang, audio_prompt_path=str(ref),
                                 exaggeration=exaggeration, cfg_weight=cfg_weight)
        out.parent.mkdir(parents=True, exist_ok=True)
        ta.save(str(out), wav.cpu(), model.sr, encoding="PCM_S", bits_per_sample=16)
        return wav.shape[-1] / model.sr


class Resemblyzer:
    """Similarity of two voices (Apache 2.0); embeddings are L2-normalised, so a dot is a cosine."""

    def __init__(self):
        from resemblyzer import VoiceEncoder
        self.enc, self._refs = VoiceEncoder(), {}

    def __call__(self, ref: Path, wav: Path) -> float:
        from resemblyzer import preprocess_wav
        if ref not in self._refs:
            self._refs[ref] = self.enc.embed_utterance(preprocess_wav(ref))
        return float(self._refs[ref] @ self.enc.embed_utterance(preprocess_wav(wav)))


class Whisper:
    """What was actually said (openai-whisper, MIT)."""

    def __init__(self, model_path: str = "large-v3-turbo", device: str = "cuda"):
        import whisper
        self.model = whisper.load_model(model_path, device=device)

    def __call__(self, wav: Path, lang: str) -> str:
        return self.model.transcribe(str(wav), language=lang)["text"]


def design_candidates(ch: Character, out_dir: Path, model_path: str, n: int = 20, device: str = "cuda") -> list[Path]:
    """Level 0: n candidates from the Parler-TTS description, one seed each."""
    import soundfile as sf
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer
    model = ParlerTTSForConditionalGeneration.from_pretrained(model_path).to(device)
    tok = AutoTokenizer.from_pretrained(model_path)
    d = tok(ch.voice.parler_description, return_tensors="pt").input_ids.to(device)
    p = tok(DESIGN_LINE, return_tensors="pt").input_ids.to(device)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for seed in range(n):
        torch.manual_seed(seed)
        audio = model.generate(input_ids=d, prompt_input_ids=p).cpu().numpy().squeeze()
        path = out_dir / f"cand_{seed:02d}.wav"
        sf.write(str(path), audio, model.config.sampling_rate)
        paths.append(path)
    return paths
