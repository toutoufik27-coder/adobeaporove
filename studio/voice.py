"""Voices, levels 0-2 of the training lab.

Level 0, design: Parler-TTS reads the character's description; 20 candidates with
different seeds; the chosen one is pitched up with rubberband (never above +5
semitones) and becomes the reference. The recipe (model, description, seed, pitch) is
saved: it is the proof of where the voice came from, and it remakes the voice.

Level 1, speech: Chatterbox (English) and Chatterbox Multilingual (the dubs) speak each
line with the character's reference, one line at a time so the voice does not drift.
The line's feeling picks an emotional reference when one exists (kiko_happy.wav).
Every line is made in three takes and the best one kept (voice_quality): Resemblyzer
similarity to the reference >= 0.75, Whisper must hear the written words, and no
measurable defect (clipping, a gap, a cut-off end, skipped words). If no take passes, three
more; then it is flagged for a person. The kept take goes through the studio chain.

Level 2, RVC: advised when more than 15 % of the lines fail the similarity check.

The GPU models are adapters, imported only when used; the loop, the checks and the
decisions are plain code and are tested with fakes."""
from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from .bible.models import Character
from .episode import Episode
from .lipsync import wav_seconds
from .text import word_error_rate
from .voice_quality import ROUNDS, TAKES, defects, finish_line, match_names, pitch_filter, take_score

MIN_SIMILARITY = 0.75
MAX_WER = 0.15
RVC_FAIL_RATE = 0.15
MAX_PITCH = 5
DESIGN_LINE = "Wow! What is that? Let's find out! Ha ha, come on, follow me!"


def pitch_ratio(semitones: float) -> float:
    if semitones > MAX_PITCH:
        raise ValueError(f"+{semitones} semitones sounds like a chipmunk: choose a higher candidate instead (max +{MAX_PITCH})")
    return 2 ** (semitones / 12)


def pitch_argv(src: Path, dst: Path, semitones: float) -> list[str]:
    """The design candidate pitched in two stages (voice_quality.pitch_filter: the formants
    follow only part of the shift, so it sounds like a child and not a chipmunk), levelled."""
    pitch_ratio(semitones)  # the +5 cap
    return ["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-af",
            f"{pitch_filter(semitones)},loudnorm=I=-16:TP=-1.5", "-ar", "24000", "-c:a", "pcm_s16le", str(dst)]


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
        """Writes a PCM wav to out, returns its length in seconds."""


@dataclass(frozen=True)
class Take:
    path: Path
    seed: int
    seconds: float
    similarity: float
    wer: float
    defects: tuple[str, ...]

    @property
    def passed(self) -> bool:
        return self.similarity >= MIN_SIMILARITY and self.wer <= MAX_WER and not self.defects

    @property
    def score(self) -> float:
        return take_score(self.similarity, self.wer, list(self.defects))


@dataclass(frozen=True)
class LineVoice:
    line_id: str
    path: str
    seconds: float
    similarity: float
    wer: float
    takes: int
    passed: bool
    defects: tuple[str, ...] = ()
    seed: int = 0


def speak_line(line_id: str, text: str, lang: str, ch: Character, ref: Path, main_ref: Path, out: Path,
               synth: Synth, similarity, transcribe, seed: int, names: list[str] = (),
               check=defects, finish=finish_line, enhance=None) -> LineVoice:
    """Best of three takes (a second round of three if none passes), then the studio chain.
    check(path, text, lang, pace) lists measurable defects; enhance(src, dst) is optional;
    finish(src, dst) is the chain (None keeps the take as it is)."""
    takes: list[Take] = []
    work = out.parent / "takes"
    for rnd in range(ROUNDS):
        for k in range(TAKES):
            s = seed + rnd * TAKES + k
            raw = work / f"{out.stem}_t{s}.wav"
            secs = synth(text, lang, ref, ch.voice.exaggeration, ch.voice.cfg_weight, s, raw)
            heard = match_names(transcribe(raw, lang), list(names))
            takes.append(Take(raw, s, secs, round(similarity(main_ref, raw), 3),
                              round(word_error_rate(text, heard), 3), tuple(check(raw, text, lang, ch.voice.pace))))
        if any(t.passed for t in takes):
            break
    best = max(takes, key=lambda t: (t.passed, t.score))
    out.parent.mkdir(parents=True, exist_ok=True)
    kept = enhance(best.path, work / f"{out.stem}_enhanced.wav") if enhance else best.path
    if finish:
        finish(kept, out)
        seconds = wav_seconds(out)
    else:
        shutil.copy(kept, out)
        seconds = best.seconds
    return LineVoice(line_id, str(out), round(seconds, 3), best.similarity, best.wer, len(takes), best.passed,
                     best.defects, best.seed)


def voice_episode(root: Path, bible, ep: Episode, lang: str, out_dir: Path, synth: Synth, similarity, transcribe,
                  log=print, check=defects, finish=finish_line, enhance=None) -> dict:
    """Every line of one language. Returns the report; writes lengths.json for `studio plan`."""
    names = [c.name for c in bible.characters.values()]
    results = []
    for line in ep.lines():
        ch = bible.characters[line.speaker]
        text = line.text if lang == ep.language else ep.translations[lang][line.id]
        seed = int(ch.id[3:]) * 1000  # a fixed seed per character
        r = speak_line(line.id, text, lang, ch, ref_for(root, ch, lang, line.emotion), ref_for(root, ch, lang),
                       out_dir / f"{line.id}.wav", synth, similarity, transcribe, seed, names, check, finish, enhance)
        if not r.passed:
            why = "; ".join(r.defects) or f"similarity {r.similarity}, WER {r.wer}"
            log(f"FLAGGED {line.id} {ch.name}: {why} (best of {r.takes} takes)")
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
    """Chatterbox for English, Chatterbox Multilingual for the dubs (MIT), loaded from the
    folder the license guard installed (never downloaded behind its back)."""

    def __init__(self, ckpt_dir: Path | None = None, device: str = "cuda"):
        self.ckpt, self.device, self._en, self._mtl = ckpt_dir, device, None, None

    def _load(self, cls):
        return cls.from_local(str(self.ckpt), self.device) if self.ckpt else cls.from_pretrained(device=self.device)

    def __call__(self, text, lang, ref, exaggeration, cfg_weight, seed, out) -> float:
        import torch
        import torchaudio as ta
        torch.manual_seed(seed)
        if lang == "en":
            if self._en is None:
                from chatterbox.tts import ChatterboxTTS
                self._en = self._load(ChatterboxTTS)
            model = self._en
            wav = model.generate(text, audio_prompt_path=str(ref), exaggeration=exaggeration, cfg_weight=cfg_weight)
        else:
            if self._mtl is None:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                self._mtl = self._load(ChatterboxMultilingualTTS)
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
    """What was actually said: the Whisper weights the license guard installed, through
    the transformers speech-recognition pipeline."""

    def __init__(self, model_dir: Path, device: str = "cuda:0"):
        import torch
        from transformers import pipeline
        self.asr = pipeline("automatic-speech-recognition", model=str(model_dir), torch_dtype=torch.float16, device=device)

    def __call__(self, wav: Path, lang: str) -> str:
        return self.asr(str(wav), generate_kwargs={"language": lang, "task": "transcribe"})["text"]


class Enhancer:
    """Optional (`studio voice --enhance`): Resemble Enhance (MIT) on each kept take, before
    the studio chain. Chatterbox speaks at 24 kHz, so nothing above 12 kHz exists; this
    model rebuilds the top of the spectrum (44.1 kHz), the "air" a studio recording has.
    On the finished lines, not on the references: Chatterbox reads its prompt at 24 kHz
    anyway. Loaded from the folder the license guard installed; not run in the tests."""

    def __init__(self, model_dir: Path, device: str = "cuda"):
        self.dir, self.device = model_dir, device

    def __call__(self, src: Path, dst: Path) -> Path:
        import torchaudio
        from resemble_enhance.enhancer.inference import enhance
        dwav, sr = torchaudio.load(str(src))
        wav, new_sr = enhance(dwav.mean(dim=0), sr, self.device, nfe=64, solver="midpoint", lambd=0.1, tau=0.5,
                              run_dir=self.dir / "enhancer_stage2")
        dst.parent.mkdir(parents=True, exist_ok=True)
        torchaudio.save(str(dst), wav.unsqueeze(0).cpu(), new_sr, encoding="PCM_S", bits_per_sample=16)
        return dst


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
