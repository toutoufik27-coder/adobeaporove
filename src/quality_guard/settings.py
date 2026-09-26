"""The app's remembered choices, in ~/.quality-guard/settings.json."""

from __future__ import annotations

import json
import os
from pathlib import Path

from .config import Config

DIR = Path(os.environ.get("QGUARD_HOME", Path.home() / ".quality-guard"))
FILE = DIR / "settings.json"

# The thresholds the app lets you tune, with the range its sliders allow.
TUNABLE = {
    "quality.sharpness_review": (0.40, 0.90, 0.01),
    "quality.noise_review": (1.0, 8.0, 0.1),
    "technical.jpeg_quality_review": (50, 95, 1),
    "technical.png_margin_review": (0.02, 0.30, 0.01),
    "similarity.similar_distance": (4, 16, 1),
    "similarity.max_similar": (1, 10, 1),
}


def load() -> dict:
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save(data: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, FILE)


def remember_folder(data: dict, folder: str) -> None:
    recent = [f for f in data.get("recent", []) if f != folder]
    data["recent"] = [folder, *recent][:6]


def apply_thresholds(config: Config, values: dict) -> None:
    """Set the tunable thresholds present in values, clamped to their slider range."""
    for key, value in values.items():
        if key not in TUNABLE or isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        section_name, name = key.split(".")
        section = getattr(config, section_name)
        low, high, _ = TUNABLE[key]
        current = getattr(section, name)
        setattr(section, name, type(current)(min(max(value, low), high)))


def thresholds(config: Config) -> dict:
    out = {}
    for key, (low, high, step) in TUNABLE.items():
        section_name, name = key.split(".")
        out[key] = {"value": getattr(getattr(config, section_name), name), "min": low, "max": high, "step": step}
    return out


def defaults() -> dict:
    fresh = Config()
    return {key: getattr(getattr(fresh, key.split(".")[0]), key.split(".")[1]) for key in TUNABLE}

