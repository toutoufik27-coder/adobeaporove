"""The voice steps (training lab, levels 0-2). GPU models run in the worker; each step
reads the results of the steps before it and writes paths relative to the project."""
from __future__ import annotations

import random
import re
import secrets
import shutil
import statistics
import subprocess
import wave
from pathlib import Path

from ..text import word_error_rate
from ..voice import (DESIGN_LINE, MIN_SIMILARITY, RVC_FAIL_RATE, Chatterbox, Recipe, Resemblyzer, Whisper,
                     design_candidates, pitch_argv)
from .lines import EMOTION_LINES, REF_SENTENCES_EN, passage, validation_lines
from .steps import AUTO, REVIEW, Ctx, NeedsAction, auto, review, step  # noqa: F401

BROKEN_WER = 0.5      # a design candidate Whisper cannot follow is not offered to your ears
DUB_CANDIDATES = 5
RVC_MIN_S = 8 * 60


def run(argv: list[str]) -> None:
    p = subprocess.run(argv, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(f"{argv[0]} failed: {p.stderr[-2000:]}")


def need_filter(name: str) -> None:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    if not re.search(rf"\s{name}\s", out):
        raise NeedsAction(f"this ffmpeg has no '{name}' filter: install an ffmpeg built with it "
                          f"(Ubuntu's `apt install ffmpeg` has it)")


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return round(w.getnframes() / w.getframerate(), 3)


def reference_argv(parts: list[Path], out: Path, max_s: float = 15.0) -> list[str]:
    """One clean reference from several clips: same rate, long pauses shortened to 0.25 s,
    at most max_s seconds."""
    argv = ["ffmpeg", "-hide_banner", "-y"]
    for p in parts:
        argv += ["-i", str(p)]
    pre = ";".join(f"[{i}:a]aresample=24000,aformat=sample_fmts=s16:channel_layouts=mono[a{i}]" for i in range(len(parts)))
    joined = "".join(f"[a{i}]" for i in range(len(parts)))
    graph = (f"{pre};{joined}concat=n={len(parts)}:v=0:a=1,"
             "silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.3:"
             f"stop_threshold=-45dB:stop_silence=0.25,atrim=0:{max_s}[out]")
    return argv + ["-filter_complex", graph, "-map", "[out]", "-ar", "24000", "-c:a", "pcm_s16le", str(out)]


def _tts(ctx: Ctx) -> Chatterbox:
    return Chatterbox(ctx.model("voice"))


def _seed(ctx: Ctx) -> int:
    return int(ctx.ch.id[3:]) * 1000


# ---------------------------------------------------------------- level 0: design
@step("voice.design")
def design(ctx: Ctx) -> dict:
    repo = ctx.model_repo("voice_design")
    if "parler" not in repo.lower():
        raise NeedsAction(f"the voice-design model is {repo}, not Parler-TTS (the guard refused it): pick one of its "
                          f"preset voices by ear and save it as {ctx.ch.voice.refs['en']}")
    paths = design_candidates(ctx.ch, ctx.path("voice", "design", ctx.name), str(ctx.model("voice_design")))
    return {"candidates": [ctx.rel(p) for p in paths], "model": repo}


@step("voice.pitch")
def pitch(ctx: Ctx) -> dict:
    need_filter("rubberband")
    out = []
    for rel in ctx.need("design")["candidates"]:
        src = ctx.abs(rel)
        dst = src.with_name(src.stem + "_p.wav")
        run(pitch_argv(src, dst, ctx.ch.voice.pitch_semitones))
        out.append(ctx.rel(dst))
    return {"pitched": out, "semitones": ctx.ch.voice.pitch_semitones}


@step("voice.score")
def score(ctx: Ctx) -> dict:
    asr = Whisper(ctx.model("whisper"))
    scores = {}
    for rel in ctx.need("pitch")["pitched"]:
        heard = asr(ctx.abs(rel), "en")
        scores[rel] = {"wer": round(word_error_rate(DESIGN_LINE, heard), 3), "seconds": wav_seconds(ctx.abs(rel)), "heard": heard}
    return {"scores": scores}


def _usable(ctx: Ctx) -> dict[str, dict]:
    scores = ctx.need("score")["scores"]
    ok = {k: v for k, v in scores.items() if v["wer"] <= BROKEN_WER}
    return ok or scores


@auto("voice.pick")
def pick_auto(ctx: Ctx) -> dict:
    s = _usable(ctx)
    mid = statistics.median(v["seconds"] for v in s.values())
    chosen = min(s, key=lambda k: (s[k]["wer"], abs(s[k]["seconds"] - mid)))
    return {"chosen": chosen, "seed": _cand_seed(chosen)}


@review("voice.pick")
def pick_review(ctx: Ctx) -> dict:
    """Blind: letters, shuffled, no file names; the page never shows which seed is which."""
    items = list(_usable(ctx))
    random.Random(secrets.randbits(64)).shuffle(items)
    labels = {chr(65 + i): rel for i, rel in enumerate(items)}
    hidden = len(ctx.need("score")["scores"]) - len(items)
    return {"kind": "blind_audio", "stage": 1, "labels": labels, "keep": 3, "pause_s": 600, "hidden": hidden}


def _cand_seed(rel: str) -> int:
    m = re.search(r"cand_(\d+)", rel)
    return int(m.group(1)) if m else -1


# ---------------------------------------------------------------- level 1: references
@step("voice.reference")
def reference(ctx: Ctx) -> dict:
    ch = ctx.ch
    chosen = ctx.abs(ctx.need("pick")["chosen"])
    tts, work = _tts(ctx), ctx.path("voice", "reference", ctx.name)
    parts = [chosen]
    for i, line in enumerate(REF_SENTENCES_EN):
        out = work / f"s{i}.wav"
        tts(line, "en", chosen, ch.voice.exaggeration, ch.voice.cfg_weight, _seed(ctx) + i, out)
        parts.append(out)
    ref = ctx.abs(ch.voice.refs["en"])
    ref.parent.mkdir(parents=True, exist_ok=True)
    run(reference_argv(parts, ref))
    secs = wav_seconds(ref)
    if secs < 10:
        raise RuntimeError(f"the reference is {secs:.1f}s; the plan asks for 10-15 s of clean speech")
    recipe = ctx.abs(ch.voice.recipe) if ch.voice.recipe else ctx.path("voice", "recipes") / f"{ctx.name}.json"
    Recipe(ch.id, ctx.model_repo("voice_design"), ch.voice.parler_description, DESIGN_LINE,
           ctx.need("pick")["seed"], ch.voice.pitch_semitones).save(recipe)
    return {"ref": ctx.rel(ref), "seconds": secs, "recipe": ctx.rel(recipe)}


@step("voice.emotions")
def emotions(ctx: Ctx) -> dict:
    ch = ctx.ch
    ref = ctx.abs(ch.voice.refs["en"])
    tts, out = _tts(ctx), {}
    for i, (feeling, (line, change)) in enumerate(EMOTION_LINES.items()):
        dst = ref.with_name(f"{ref.stem}_{feeling}{ref.suffix}")
        tts(line, "en", ref, min(2.0, max(0.25, ch.voice.exaggeration + change)), ch.voice.cfg_weight, _seed(ctx) + 50 + i, dst)
        out[feeling] = ctx.rel(dst)
    return {"emotions": out}


@step("voice.ref_candidates")
def ref_candidates(ctx: Ctx) -> dict:
    lang = ctx.params["lang"]
    try:
        text = passage(lang)
    except KeyError as e:
        raise NeedsAction(str(e)) from e
    ref_en, tts = ctx.abs(ctx.ch.voice.refs["en"]), _tts(ctx)
    work = ctx.path("voice", "dub_refs", ctx.name, lang)
    out = []
    for k in range(DUB_CANDIDATES):  # cfg_weight=0 carries less of the English accent over
        dst = work / f"cand_{k}.wav"
        tts(text, lang, ref_en, ctx.ch.voice.exaggeration, 0.0, _seed(ctx) + 100 + k, dst)
        out.append(ctx.rel(dst))
    return {"candidates": out, "text": text, "lang": lang}


@step("voice.ref_score")
def ref_score(ctx: Ctx) -> dict:
    c = ctx.need("candidates")
    sim, asr = Resemblyzer(), Whisper(ctx.model("whisper"))
    ref_en = ctx.abs(ctx.ch.voice.refs["en"])
    scores = {rel: {"similarity": round(sim(ref_en, ctx.abs(rel)), 3),
                    "wer": round(word_error_rate(c["text"], asr(ctx.abs(rel), c["lang"])), 3)} for rel in c["candidates"]}
    return {"scores": scores, "lang": c["lang"]}


@auto("voice.ref_pick")
def ref_pick_auto(ctx: Ctx) -> dict:
    s = ctx.need("score")["scores"]
    return {"chosen": max(s, key=lambda k: s[k]["similarity"] - s[k]["wer"])}


@review("voice.ref_pick")
def ref_pick_review(ctx: Ctx) -> dict:
    s = ctx.need("score")["scores"]
    return {"kind": "audio_pick", "lang": ctx.params["lang"], "reference": ctx.ch.voice.refs["en"],
            "items": [{"path": k, **v} for k, v in s.items()]}


@step("voice.ref_install")
def ref_install(ctx: Ctx) -> dict:
    lang = ctx.params["lang"]
    dst = ctx.abs(ctx.ch.voice.refs[lang])
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(ctx.abs(ctx.need("pick")["chosen"]), dst)
    return {"ref": ctx.rel(dst), "lang": lang}


# ---------------------------------------------------------------- the definition of done
def _langs(ctx: Ctx) -> list[str]:
    dubs = [r["lang"] for tid, r in ctx.inputs.items() if "/ref_" in tid and r]
    return ["en", *dubs]


@step("voice.validate")
def validate(ctx: Ctx) -> dict:
    ch = ctx.ch
    tts, sim, asr = _tts(ctx), Resemblyzer(), Whisper(ctx.model("whisper"))
    stats = {}
    for lang in _langs(ctx):
        try:
            lines = validation_lines(lang)
        except KeyError as e:
            raise NeedsAction(str(e)) from e
        ref = ctx.abs(ch.voice.refs[lang])
        work = ctx.path("voice", "validate", ctx.name, lang)
        sims, wers = [], []
        for i, text in enumerate(lines):
            dst = work / f"line_{i:02d}.wav"
            tts(text, lang, ref, ch.voice.exaggeration, ch.voice.cfg_weight, _seed(ctx) + 200 + i, dst)
            sims.append(sim(ref, dst))
            wers.append(word_error_rate(text, asr(dst, lang)))
        stats[lang] = {"lines": len(lines), "mean_similarity": round(statistics.fmean(sims), 3),
                       "fail_rate": round(sum(s < MIN_SIMILARITY for s in sims) / len(sims), 3),
                       "mean_wer": round(statistics.fmean(wers), 3)}
    advised = any(s["fail_rate"] > RVC_FAIL_RATE for s in stats.values())
    passed = all(s["mean_similarity"] >= MIN_SIMILARITY and s["fail_rate"] <= RVC_FAIL_RATE for s in stats.values())
    return {"stats": stats, "rvc_advised": advised, "passed": passed}


# ---------------------------------------------------------------- level 2: RVC
@step("voice.rvc_data")
def rvc_data(ctx: Ctx) -> dict:
    """Two test lines per clip (about 4 s), English at three levels of feeling, the dubs
    at two; only clips that pass the similarity check are kept."""
    ch = ctx.ch
    tts, sim = _tts(ctx), Resemblyzer()
    work = ctx.path("voice", "rvc", ctx.name)
    kept, total, n = 0, 0.0, 0
    for lang in _langs_from(ctx.need("validate")):
        lines = validation_lines(lang)
        pairs = [f"{a} {b}" for a, b in zip(lines, lines[1:] + lines[:1])]
        levels = (0.4, 0.7, 1.0) if lang == "en" else (0.5, 0.9)
        ref = ctx.abs(ch.voice.refs[lang])
        for ex in levels:
            for text in pairs:
                n += 1
                dst = work / f"{lang}_{n:04d}.wav"
                secs = tts(text, lang, ref, ex, ch.voice.cfg_weight, _seed(ctx) + 500 + n, dst)
                if sim(ref, dst) >= MIN_SIMILARITY:
                    kept += 1
                    total += secs
                else:
                    dst.unlink()
    return {"dir": ctx.rel(work), "clips": kept, "made": n, "seconds": round(total, 1), "rvc_ready": total >= RVC_MIN_S}


@step("voice.rvc_train")
def rvc_train(ctx: Ctx) -> dict:
    cmd = ctx.cfg.rvc_train_cmd
    if not cmd:
        raise NeedsAction("RVC has no standard command line: put yours in agent.json as rvc_train_cmd, "
                          "using {dataset}, {name} and {out}")
    out = ctx.path("voice", "rvc_models", ctx.name)
    argv = [a.format(dataset=ctx.abs(ctx.need("rvc_data")["dir"]), name=ctx.name, out=out) for a in cmd]
    subprocess.run(argv, check=True)
    return {"model_dir": ctx.rel(out)}


@step("voice.done")
def done(ctx: Ctx) -> dict:
    v = ctx.need("validate")
    rvc = ctx.need("rvc_train")
    missing = [l for l, p in ctx.ch.voice.refs.items() if l in _langs_from(v) and not ctx.abs(p).exists()]
    return {"passed": v["passed"], "stats": v["stats"], "rvc": rvc.get("model_dir"), "missing_refs": missing,
            "note": "" if v["passed"] or rvc.get("model_dir") else "the voice drifts: consider RVC (rvc_train_cmd)"}


def _langs_from(v: dict) -> list[str]:
    return list(v.get("stats", {}))
