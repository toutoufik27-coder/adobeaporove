"""Pictures for the look training: poses for ControlNet OpenPose, prompts from the bible,
a palette score that throws out wrong colours before a person looks, contact sheets,
and the SDXL generator (diffusers, on the card the worker was given)."""
from __future__ import annotations

import math
import re
from pathlib import Path

from ..bible.models import Character
from ..colors import hex_to_rgb, rgb_to_lab
from ..lora import STYLE

SIZE = 1024
# COCO-18, as OpenPose draws it: nose, neck, R shoulder/elbow/wrist, L shoulder/elbow/wrist,
# R hip/knee/ankle, L hip/knee/ankle, R eye, L eye, R ear, L ear. "Right" is the child's
# right: the left of the picture when they face us. None = not visible.
_FRONT = [(.50, .22), (.50, .36), (.40, .38), (.36, .50), (.34, .61), (.60, .38), (.64, .50), (.66, .61),
          (.45, .62), (.45, .75), (.45, .88), (.55, .62), (.55, .75), (.55, .88), (.47, .19), (.53, .19), (.43, .21), (.57, .21)]


def _pose(**change) -> list:
    names = ["nose", "neck", "r_sh", "r_el", "r_wr", "l_sh", "l_el", "l_wr", "r_hip", "r_kn", "r_an",
             "l_hip", "l_kn", "l_an", "r_eye", "l_eye", "r_ear", "l_ear"]
    pts = list(_FRONT)
    for k, v in change.items():
        pts[names.index(k)] = v
    return pts


POSES = {
    "a_pose": _pose(r_el=(.33, .47), r_wr=(.27, .56), l_el=(.67, .47), l_wr=(.73, .56)),
    "front": _pose(),
    "waving": _pose(r_el=(.32, .30), r_wr=(.30, .17)),
    "pointing": _pose(r_el=(.29, .39), r_wr=(.19, .39)),
    "arms_up": _pose(r_el=(.36, .26), r_wr=(.34, .13), l_el=(.64, .26), l_wr=(.66, .13),
                     r_kn=(.43, .71), r_an=(.45, .80), l_kn=(.57, .71), l_an=(.55, .80)),
    "think_chin": _pose(r_el=(.38, .44), r_wr=(.48, .29)),
    "sitting": _pose(r_hip=(.45, .70), l_hip=(.55, .70), r_kn=(.39, .74), r_an=(.40, .88), l_kn=(.61, .74), l_an=(.60, .88)),
    "three_quarter": _pose(nose=(.55, .22), r_sh=(.42, .38), l_sh=(.57, .38), l_el=(.60, .50), l_wr=(.62, .61),
                           r_eye=(.51, .19), l_eye=(.57, .19), r_ear=(.44, .21), l_ear=None),
    # facing the right of the picture: the child's right side is towards us
    "side": _pose(nose=(.60, .22), neck=(.51, .36), r_sh=(.51, .38), r_el=(.53, .50), r_wr=(.56, .60),
                  l_sh=(.50, .38), l_el=None, l_wr=None, r_hip=(.50, .62), l_hip=(.50, .62),
                  r_kn=(.55, .75), r_an=(.57, .88), l_kn=(.47, .75), l_an=(.44, .88),
                  r_eye=(.57, .19), l_eye=None, r_ear=(.50, .21), l_ear=None),
    # from behind: no face, and the child's right is on the right of the picture
    "back": [None, (.50, .36), (.60, .38), (.64, .50), (.66, .61), (.40, .38), (.36, .50), (.34, .61),
             (.55, .62), (.55, .75), (.55, .88), (.45, .62), (.45, .75), (.45, .88), None, None, (.57, .21), (.43, .21)],
}
FRAMES = {"full_body": (0.0, 1.0), "half_body": (0.10, 0.62), "close_up": (0.10, 0.42)}
_LIMBS = [(2, 3), (2, 6), (3, 4), (4, 5), (6, 7), (7, 8), (2, 9), (9, 10), (10, 11), (2, 12), (12, 13), (13, 14),
          (2, 1), (1, 15), (15, 17), (1, 16), (16, 18)]
_COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
           (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
           (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]


def framed(points: list, frame: str) -> list:
    """The pose cropped to a framing: half body and close-up zoom on the top of the body."""
    top, bottom = FRAMES[frame]
    k = bottom - top
    out = []
    for p in points:
        if p is None:
            out.append(None)
            continue
        x, y = (p[0] - 0.5) / k + 0.5, (p[1] - top) / k
        out.append((x, y) if 0 <= x <= 1 and 0 <= y <= 1 else None)
    return out


def render_pose(name: str, frame: str = "full_body", size: int = SIZE):
    """An OpenPose skeleton picture for ControlNet (limbs at 60 % over black, joints on top)."""
    from PIL import Image, ImageDraw
    pts = framed(POSES[name], frame)
    img = Image.new("RGB", (size, size), (0, 0, 0))
    d = ImageDraw.Draw(img)
    w = max(2, size // 128)
    for i, (a, b) in enumerate(_LIMBS):
        pa, pb = pts[a - 1], pts[b - 1]
        if pa and pb:
            c = tuple(int(v * 0.6) for v in _COLORS[i])
            d.line([(pa[0] * size, pa[1] * size), (pb[0] * size, pb[1] * size)], fill=c, width=w * 2)
    for i, p in enumerate(pts):
        if p:
            d.ellipse([p[0] * size - w, p[1] * size - w, p[0] * size + w, p[1] * size + w], fill=_COLORS[i])
    return img


# ---------------------------------------------------------------- prompts
_HAIR = {"black": "#141414", "dark brown": "#2B1B12", "brown": "#4A2E1F", "auburn": "#6B3A1E", "blonde": "#D9B26A",
         "red": "#A33A1A", "grey": "#9A9A9A"}
_SILHOUETTE = {"round_full": "round chubby body", "tall_thin": "tall thin body", "wide_sturdy": "wide sturdy body",
               "soft_flowing": "soft rounded shape", "small_round_bouncy": "small round body",
               "straight_upright": "straight upright posture"}


def _words(s: str) -> str:
    return s.replace("_", " ")


def hair_colour(hex_: str) -> str:
    lab = rgb_to_lab(hex_to_rgb(hex_))
    return min(_HAIR, key=lambda n: math.dist(lab, rgb_to_lab(hex_to_rgb(_HAIR[n]))))


def skin_tone(hex_: str) -> str:
    L = rgb_to_lab(hex_to_rgb(hex_))[0]
    for limit, name in ((80, "fair"), (68, "light"), (55, "medium"), (42, "tan"), (30, "brown")):
        if L > limit:
            return name
    return "dark brown"


def signature_phrase(ch: Character) -> str:
    return _words(re.split(r"_(?:that|always|before|when)_", ch.visual.signature)[0])


def kind(ch: Character) -> str:
    d = ch.voice.parler_description.lower()
    return "girl" if "girl" in d else "boy" if "boy" in d else "child"


def look_prompt(ch: Character) -> str:
    """The character in words for the base model, before any LoRA knows the trigger."""
    v = ch.visual
    outfit = ", ".join(_words(o) for o in v.outfit_fixed.values())
    return (f"a {ch.age_apparent}-year-old cartoon {kind(ch)}, {_SILHOUETTE.get(v.silhouette, _words(v.silhouette))}, "
            f"{_words(v.hair.style)} {hair_colour(v.hair.color)} hair, {skin_tone(v.skin)} skin, {outfit}, "
            f"{signature_phrase(ch)}, {STYLE}")


NEGATIVE = ("realistic, photo, 3d render, extra fingers, extra limbs, deformed hands, text, watermark, logo, "
            "scary, dark, blurry, cropped head")


# ---------------------------------------------------------------- checks and sheets
def palette_score(path: Path, palette: list[str], primary: str) -> float:
    """0..1: how much of the drawing (not the white background, not the outlines) is in the
    character's palette, halved when the primary colour is almost absent."""
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((64, 64), Image.Resampling.BOX)
    pal = [rgb_to_lab(hex_to_rgb(c)) for c in palette]
    prim = rgb_to_lab(hex_to_rgb(primary))
    cache: dict = {}
    body = inside = near_primary = 0
    for rgb in getattr(img, "get_flattened_data", img.getdata)():
        if rgb not in cache:
            cache[rgb] = rgb_to_lab(rgb)
        L, a, b = cache[rgb]
        if (L > 93 and abs(a) < 6 and abs(b) < 6) or L < 18:  # background or outline
            continue
        body += 1
        if min(math.dist((L, a, b), p) for p in pal) < 15:
            inside += 1
        if math.dist((L, a, b), prim) < 15:
            near_primary += 1
    if not body:
        return 0.0
    score = inside / body
    return round(score if near_primary / body >= 0.05 else score / 2, 4)


def contact_sheet(paths: list[Path], out: Path, cols: int = 8, cell: int = 256, labels: list[str] | None = None) -> Path:
    from PIL import Image, ImageDraw
    rows = math.ceil(len(paths) / cols)
    sheet = Image.new("RGB", (cols * cell, rows * cell), (255, 255, 255))
    d = ImageDraw.Draw(sheet)
    for i, p in enumerate(paths):
        im = Image.open(p).convert("RGB")
        im.thumbnail((cell, cell))
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
        if labels:
            d.text((x + 6, y + 6), labels[i], fill=(200, 0, 0))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


# ---------------------------------------------------------------- the GPU side
class Generator:
    """SDXL on the worker's card: ControlNet OpenPose for the pose, IP-Adapter for the
    mother image (round 1), the character LoRA (round 2 and the evaluation)."""

    def __init__(self, base: Path, pose: Path | None = None, ip_adapter: Path | None = None, low_vram: bool = False):
        import torch
        from diffusers import ControlNetModel, StableDiffusionXLControlNetPipeline, StableDiffusionXLPipeline
        self.torch = torch
        if pose:
            cn = ControlNetModel.from_pretrained(str(pose), torch_dtype=torch.float16)
            self.pipe = StableDiffusionXLControlNetPipeline.from_single_file(str(base), controlnet=cn, torch_dtype=torch.float16)
        else:
            self.pipe = StableDiffusionXLPipeline.from_single_file(str(base), torch_dtype=torch.float16)
        if ip_adapter:
            self.pipe.load_ip_adapter(str(ip_adapter), subfolder="sdxl_models", weight_name="ip-adapter_sdxl.safetensors")
            self.pipe.set_ip_adapter_scale(0.6)
        if low_vram:
            self.pipe.enable_model_cpu_offload()
        else:
            self.pipe.to("cuda")
        self.has_pose, self.has_ip, self.lora = pose is not None, ip_adapter is not None, None

    def use_lora(self, path: Path | None, scale: float = 0.8) -> None:
        if self.lora:
            self.pipe.unload_lora_weights()
        self.lora = path
        if path:
            self.pipe.load_lora_weights(str(path.parent), weight_name=path.name)
            self.pipe.fuse_lora(lora_scale=scale)

    def __call__(self, prompt: str, seed: int, out: Path, pose=None, reference=None, steps: int = 30) -> Path:
        kw = dict(prompt=prompt, negative_prompt=NEGATIVE, num_inference_steps=steps, width=SIZE, height=SIZE,
                  generator=self.torch.Generator("cuda").manual_seed(seed))
        if self.has_pose:
            kw.update(image=pose, controlnet_conditioning_scale=0.8)
        if self.has_ip:
            kw.update(ip_adapter_image=reference)
        out.parent.mkdir(parents=True, exist_ok=True)
        self.pipe(**kw).images[0].save(out)
        return out
