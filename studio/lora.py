"""The look: SDXL LoRA per character with kohya_ss, in two rounds (training lab).

What code can decide is decided here:
- the trigger word (kikoch01) and the dataset folder name kohya reads repeats from;
- captions describe what changes (pose, feeling, background) and never what is fixed:
  a caption that names the overalls or the backpack separates them from the trigger
  word, and the LoRA "forgets" them;
- horizontal flips only for symmetric characters (Zuzu's tilted hat, Nilo's lens);
- repeats so the run lands in the safe 1500-2500 steps;
- the dataset mix (40 % full body, 30 % half, 20 % close-up, 10 % with others; half on
  a white background), checked before hours of GPU are spent;
- the fixed evaluation grid: 8 prompts x 4 seeds for every saved epoch."""
from __future__ import annotations

import math
import re
import shutil
from collections import Counter
from pathlib import Path

from .bible.models import Character

STEPS = (1500, 2500)
EPOCHS, BATCH = 10, 2
IMAGES = {1: (12, 18), 2: (25, 40)}
MIX = {"full_body": 0.40, "half_body": 0.30, "close_up": 0.20, "group": 0.10}
MIX_TOL = 0.10
STYLE = "flat 2D children's cartoon, thick clean outlines, soft cel shading, simple shapes"
_STOP = {"always", "worn", "on", "a", "the", "with", "her", "his", "their", "that", "when", "before", "every", "step",
         "and", "of", "to", "up", "short", "neck", "cord", "changes", "colour", "feeling", "running", "falls", "jingles"}
# a colour alone is not the item: "yellow flowers" is a free caption, "overalls" is not
_COLOURS = {"red", "yellow", "blue", "green", "orange", "purple", "pink", "white", "black", "brown", "grey", "gray"}


def trigger(ch: Character) -> str:
    return f"{re.sub(r'[^a-z]', '', ch.name.lower())}ch{ch.id[3:]}"


def fixed_words(ch: Character) -> set[str]:
    """Words for what never changes on the character: they must not be in any caption."""
    parts = [*ch.visual.outfit_fixed.values(), ch.visual.signature, ch.visual.hair.style]
    words = {w for p in parts for w in re.split(r"[_\s-]+", p.lower()) if w and w not in _STOP | _COLOURS}
    plural = {w + "s" for w in words} | {w[:-1] for w in words if w.endswith("s")}
    return words | plural


def caption_problems(ch: Character, caption: str) -> list[str]:
    words = set(re.findall(r"[a-z]+", caption.lower()))
    out = [f"names the fixed '{w}': it will separate from {trigger(ch)}" for w in sorted(words & fixed_words(ch))]
    if not caption.lower().startswith(trigger(ch)):
        out.append(f"must start with the trigger word {trigger(ch)}")
    return out


def repeats_for(n_images: int, epochs: int = EPOCHS, batch: int = BATCH) -> int:
    """The smallest repeat count that reaches the safe number of steps."""
    r = max(1, math.ceil(STEPS[0] * batch / (n_images * epochs)))
    steps = n_images * r * epochs / batch
    if steps > STEPS[1]:
        raise ValueError(f"{n_images} images reach {steps:.0f} steps even at {r} repeats: use fewer epochs")
    return r


def check_mix(shots: list[str], backgrounds: list[str], round_: int = 2) -> list[str]:
    """shots: full_body | half_body | close_up | group per image; backgrounds: white | scene."""
    n = len(shots)
    lo, hi = IMAGES[round_]
    out = [] if lo <= n <= hi else [f"{n} images; round {round_} keeps {lo}-{hi}"]
    got = Counter(shots)
    for kind, share in MIX.items():
        have = got.get(kind, 0) / max(1, n)
        if abs(have - share) > MIX_TOL:
            out.append(f"{kind}: {have:.0%} of the images, aim for {share:.0%}")
    white = backgrounds.count("white") / max(1, len(backgrounds))
    if abs(white - 0.5) > MIX_TOL:
        out.append(f"white backgrounds are {white:.0%}; half white, half varied, or the background leaks into the character")
    return out


def build_dataset(ch: Character, items: list[tuple[Path, str]], out_root: Path, version: str) -> Path:
    """items: (image, caption without the trigger). Refuses captions that name fixed traits."""
    bad = {str(p): caption_problems(ch, f"{trigger(ch)}, {c}") for p, c in items}
    bad = {k: v for k, v in bad.items() if v}
    if bad:
        raise ValueError("captions to fix first:\n" + "\n".join(f"{k}: {'; '.join(v)}" for k, v in bad.items()))
    folder = out_root / ch.name.lower() / version / f"{repeats_for(len(items))}_{trigger(ch)} character"
    folder.mkdir(parents=True, exist_ok=True)
    for i, (img, cap) in enumerate(items, 1):
        shutil.copy(img, folder / f"{i:04d}{img.suffix.lower()}")
        (folder / f"{i:04d}.txt").write_text(f"{trigger(ch)}, {cap.strip()}\n", encoding="utf-8")
    return folder.parent


def kohya_argv(ch: Character, dataset: Path, out_dir: Path, version: str, base_model: Path) -> list[str]:
    """The training lab's settings for a 3090 (bf16, 8-bit AdamW, cached latents)."""
    argv = ["accelerate", "launch", "sdxl_train_network.py",
            f"--pretrained_model_name_or_path={base_model}", f"--train_data_dir={dataset}",
            f"--output_dir={out_dir}", f"--output_name={ch.name.lower()}_{version}",
            "--network_module=networks.lora", "--network_dim=32", "--network_alpha=16",
            "--unet_lr=1e-4", "--text_encoder_lr=5e-5", "--optimizer_type=AdamW8bit", "--lr_scheduler=cosine",
            "--resolution=1024,1024", "--enable_bucket", f"--train_batch_size={BATCH}",
            f"--max_train_epochs={EPOCHS}", "--save_every_n_epochs=1",
            "--mixed_precision=bf16", "--save_precision=bf16", "--cache_latents", "--gradient_checkpointing",
            "--xformers", "--caption_extension=.txt", "--seed=42"]
    if ch.visual.symmetric:
        argv.append("--flip_aug")
    return argv


def eval_prompts(ch: Character) -> list[str]:
    """The fixed grid: the same 8 prompts x 4 seeds for every saved epoch."""
    t = trigger(ch)
    return [f"{t}, {p}, {STYLE}" for p in (
        "full body, standing, front view, plain white background",
        "full body, three-quarter view, waving, garden background",
        "full body, back view, walking away, plain white background",
        "sitting on the floor, laughing, living room background",
        "jumping, arms up, open mouth smile, park background",
        "close-up, surprised expression, looking left, plain white background",
        "half body, thinking, hand on chin, workshop background",
        "full body, running, side view, hill background",
    )]


EVAL_SEEDS = (1, 2, 3, 4)
