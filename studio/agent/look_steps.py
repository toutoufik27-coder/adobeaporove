"""The look steps (training lab, SDXL LoRA in two rounds)."""
from __future__ import annotations

import itertools
import shutil
import statistics
import subprocess
from pathlib import Path

from ..lora import EVAL_SEEDS, MIX, STYLE, build_dataset, check_mix, eval_prompts, kohya_argv, trigger
from .images import Generator, contact_sheet, look_prompt, palette_score, render_pose
from .steps import Ctx, NeedsAction, auto, review, step

MOTHER_SEEDS = 16
ROUND1_POSES = [("side", "full_body"), ("three_quarter", "full_body"), ("back", "full_body"), ("sitting", "full_body"),
                ("arms_up", "full_body"), ("waving", "full_body"), ("pointing", "full_body"), ("think_chin", "half_body")]
ROUND1_EXPRESSIONS = ["smiling", "surprised"]
ROUND1_SEEDS = 5
ROUND2_EXPRESSIONS = ["happy", "sad", "surprised", "frustrated", "a little scared", "curious"]
ROUND2_ANGLES = ["front", "three_quarter", "side", "back"]
ROUND2_SEEDS = 2
SCENES = ["garden background", "living room background", "park background", "workshop background", "hill background"]
GROUP_SCENE = "busy playground background with other children"
POSE_WORDS = {"a_pose": "front view, standing", "front": "front view, standing", "side": "side view, walking",
              "three_quarter": "three-quarter view, standing", "back": "back view, standing",
              "sitting": "sitting on the floor", "arms_up": "jumping, arms up", "waving": "waving",
              "pointing": "pointing", "think_chin": "thinking, hand on chin"}
FRAME_WORDS = {"full_body": "full body", "half_body": "half body", "close_up": "close-up"}
MIN_CORRECT = 28  # of 32, at strength 0.8


def _optional(ctx: Ctx, need: str) -> Path | None:
    return ctx.model(need) if need in ctx.lock().read() else None


def _caption(pose: str, frame: str, expression: str, background: str) -> str:
    """What changes between pictures; never what is fixed on the character."""
    return f"{FRAME_WORDS[frame]}, {POSE_WORDS[pose]}, {expression} expression, {background}"


def _item(ctx: Ctx, path: Path, seed: int, pose: str, frame: str, expression: str, background: str, shot: str | None = None) -> dict:
    return {"path": ctx.rel(path), "seed": seed, "pose": pose, "frame": frame, "shot": shot or frame,
            "expression": expression, "background": "white" if background.startswith("plain white") else "scene",
            "caption": _caption(pose, frame, expression, background)}


# ---------------------------------------------------------------- the mother image
@step("look.mother")
def mother(ctx: Ctx) -> dict:
    gen = Generator(ctx.model("image_base"), pose=_optional(ctx, "pose"), low_vram=bool(ctx.params.get("low_vram")))
    pose = render_pose("a_pose")
    prompt = f"{look_prompt(ctx.ch)}, full body, front view, standing, arms slightly out, plain white background"
    work = ctx.path("look", ctx.name, "mother")
    items = [_item(ctx, gen(prompt, s, work / f"cand_{s:02d}.png", pose=pose), s, "a_pose", "full_body", "neutral",
                   "plain white background") for s in range(MOTHER_SEEDS)]
    return {"images": items, "prompt": prompt}


@step("look.score")
def score(ctx: Ctx) -> dict:
    (src,) = ctx.inputs.values()
    v = ctx.ch.visual
    return {"images": [{**i, "score": palette_score(ctx.abs(i["path"]), v.palette, v.primary_color)} for i in src["images"]]}


def _scored(ctx: Ctx) -> list[dict]:
    (src,) = ctx.inputs.values()
    return src["images"]


@auto("look.mother_pick")
def mother_auto(ctx: Ctx) -> dict:
    return {"chosen": max(_scored(ctx), key=lambda i: i["score"])["path"]}


@review("look.mother_pick")
def mother_review(ctx: Ctx) -> dict:
    return {"kind": "image_pick", "items": sorted(_scored(ctx), key=lambda i: -i["score"])}


# ---------------------------------------------------------------- round 1: from one image to 15
@step("look.round1")
def round1(ctx: Ctx) -> dict:
    chosen = ctx.abs(ctx.need("mother_pick")["chosen"])
    refs = ctx.abs(ctx.ch.assets.turnaround)
    refs.mkdir(parents=True, exist_ok=True)
    shutil.copy(chosen, refs / "mother.png")
    from PIL import Image
    mother_img = Image.open(chosen).convert("RGB")
    gen = Generator(ctx.model("image_base"), pose=_optional(ctx, "pose"), ip_adapter=ctx.model("ip_adapter"),
                    low_vram=bool(ctx.params.get("low_vram")))
    work = ctx.path("look", ctx.name, "round1")
    items, n = [], 0
    for (pose, frame), expression, _ in itertools.product(ROUND1_POSES, ROUND1_EXPRESSIONS, range(ROUND1_SEEDS)):
        n += 1
        bg = "plain white background" if n % 2 else SCENES[n % len(SCENES)]
        prompt = f"{look_prompt(ctx.ch)}, {_caption(pose, frame, expression, bg)}"
        out = gen(prompt, 100 + n, work / f"{n:04d}.png", pose=render_pose(pose, frame), reference=mother_img)
        items.append(_item(ctx, out, 100 + n, pose, frame, expression, bg))
    return {"images": items}


# ---------------------------------------------------------------- round 2: with LoRA v1
def round2_plan() -> list[tuple[str, str, str, str, str]]:
    """(expression, angle, frame, background, shot) aiming at 40/30/20/10 and half white."""
    out = []
    for i, (expr, angle) in enumerate(itertools.product(ROUND2_EXPRESSIONS, ROUND2_ANGLES)):
        slot = i % 10
        frame, shot = (("full_body", "full_body") if slot < 4 else ("half_body", "half_body") if slot < 7
                       else ("close_up", "close_up") if slot < 9 else ("full_body", "group"))
        if angle == "back" and frame == "close_up":  # a close-up of the back of a head teaches nothing
            frame, shot = "half_body", "half_body"
        bg = GROUP_SCENE if shot == "group" else "plain white background" if i % 2 == 0 else SCENES[i % len(SCENES)]
        out.append((expr, angle, frame, bg, shot))
    return out


@step("look.round2")
def round2(ctx: Ctx) -> dict:
    lora = ctx.abs(ctx.need("lora_v1")["final"])
    gen = Generator(ctx.model("image_base"), pose=_optional(ctx, "pose"), low_vram=bool(ctx.params.get("low_vram")))
    gen.use_lora(lora, 0.8)
    work = ctx.path("look", ctx.name, "round2")
    items, n = [], 0
    for (expr, angle, frame, bg, shot), _ in itertools.product(round2_plan(), range(ROUND2_SEEDS)):
        n += 1
        pose = "front" if angle == "front" else angle
        prompt = f"{trigger(ctx.ch)}, {_caption(pose, frame, expr, bg)}, {STYLE}"
        out = gen(prompt, 500 + n, work / f"{n:04d}.png", pose=render_pose(pose, frame))
        items.append(_item(ctx, out, 500 + n, pose, frame, expr, bg, shot))
    return {"images": items, "lora": ctx.rel(lora)}


# ---------------------------------------------------------------- selecting
@auto("look.select")
def select_auto(ctx: Ctx) -> dict:
    """Best palette scores, spread over poses (round 1) or over the shot mix (round 2)."""
    items = sorted(_scored(ctx), key=lambda i: -i["score"])
    lo, hi = ctx.params["min"], ctx.params["max"]
    want = (lo + hi) // 2
    chosen: list[dict] = []
    if ctx.params["round"] == 1:
        per_pose: dict[str, int] = {}
        for i in items:
            if per_pose.get(i["pose"], 0) < 3 and len(chosen) < want:
                chosen.append(i)
                per_pose[i["pose"]] = per_pose.get(i["pose"], 0) + 1
    else:
        for shot, share in MIX.items():
            chosen += [i for i in items if i["shot"] == shot][: round(share * want)]
    rest = [i for i in items if i not in chosen]
    chosen += rest[: max(0, lo - len(chosen))]
    return _selection(ctx, chosen[:hi])


def _selection(ctx: Ctx, chosen: list[dict]) -> dict:
    warnings = check_mix([i["shot"] for i in chosen], [i["background"] for i in chosen], ctx.params["round"]) \
        if ctx.params["round"] == 2 else []
    return {"selected": chosen, "mix_warnings": warnings}


@review("look.select")
def select_review(ctx: Ctx) -> dict:
    return {"kind": "image_select", "round": ctx.params["round"], "min": ctx.params["min"], "max": ctx.params["max"],
            "items": sorted(_scored(ctx), key=lambda i: -i["score"])}


# ---------------------------------------------------------------- datasets and training
@step("look.dataset")
def dataset(ctx: Ctx) -> dict:
    (sel,) = ctx.inputs.values()
    items = [(ctx.abs(i["path"]), i["caption"]) for i in sel["selected"]]
    root = build_dataset(ctx.ch, items, ctx.path("look", "dataset"), ctx.params["version"])
    return {"dataset": ctx.rel(root), "images": len(items)}


@step("look.lora")
def lora(ctx: Ctx) -> dict:
    kd = Path(ctx.cfg.kohya_dir) if ctx.cfg.kohya_dir else None
    if not kd or not (kd / "sdxl_train_network.py").exists():
        raise NeedsAction("set kohya_dir in agent.json to the sd-scripts folder that has sdxl_train_network.py")
    version = ctx.params["version"]
    (ds,) = ctx.inputs.values()
    out = ctx.path("look", "loras")
    argv = kohya_argv(ctx.ch, ctx.abs(ds["dataset"]), out, version, ctx.model("image_base"))
    if ctx.params.get("batch"):
        argv = [f"--train_batch_size={ctx.params['batch']}" if a.startswith("--train_batch_size=") else a for a in argv]
    subprocess.run(argv, cwd=kd, check=True)
    stem = f"{ctx.name}_{version}"
    final = out / f"{stem}.safetensors"
    if not final.exists():
        raise RuntimeError(f"kohya finished without {final.name}")
    epochs = sorted(out.glob(f"{stem}-*.safetensors")) + [final]
    return {"final": ctx.rel(final), "epochs": [ctx.rel(p) for p in epochs]}


# ---------------------------------------------------------------- evaluation
@step("look.eval")
def evaluate(ctx: Ctx) -> dict:
    gen = Generator(ctx.model("image_base"), low_vram=bool(ctx.params.get("low_vram")))
    prompts = eval_prompts(ctx.ch)
    v = ctx.ch.visual
    grids = []
    for rel in ctx.need("lora_v2")["epochs"]:
        epoch = ctx.abs(rel)
        gen.use_lora(epoch, 0.8)
        work = ctx.path("look", ctx.name, "eval", epoch.stem)
        paths = [gen(p, s, work / f"s{s}_p{k}.png") for s in EVAL_SEEDS for k, p in enumerate(prompts)]
        grid = contact_sheet(paths, work / "grid.png", cols=len(prompts))
        grids.append({"epoch": rel, "grid": ctx.rel(grid),
                      "score": round(statistics.fmean(palette_score(p, v.palette, v.primary_color) for p in paths), 4)})
    return {"grids": grids, "prompts": prompts, "seeds": list(EVAL_SEEDS)}


@auto("look.eval_pick")
def eval_auto(ctx: Ctx) -> dict:
    best = max(ctx.need("eval")["grids"], key=lambda g: g["score"])
    return {"epoch": best["epoch"], "correct": None}


@review("look.eval_pick")
def eval_review(ctx: Ctx) -> dict:
    e = ctx.need("eval")
    return {"kind": "eval_pick", "grids": e["grids"], "cells": len(e["prompts"]) * len(e["seeds"]), "min_correct": MIN_CORRECT}


@step("look.install")
def install(ctx: Ctx) -> dict:
    pick = ctx.need("eval_pick")
    correct = pick.get("correct")
    if correct is not None and correct < MIN_CORRECT:
        raise NeedsAction(f"{correct}/32 drawn right; the plan needs {MIN_CORRECT}. Try an earlier epoch (6-7) or "
                          f"strength 0.7; if the {ctx.ch.visual.signature.split('_')[0]} is lost, add 5 close pictures "
                          f"of it to round 2. Then press retry on look/eval_pick")
    dst = ctx.abs(ctx.ch.assets.lora)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(ctx.abs(pick["epoch"]), dst)
    return {"lora": ctx.rel(dst), "epoch": pick["epoch"], "correct": correct, "auto": pick.get("auto", False)}
