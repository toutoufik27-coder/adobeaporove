"""Thresholds. Every number here can be overridden from a TOML file (see config.example.toml)."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path


@dataclass
class Technical:
    min_megapixels: float = 4.0
    max_megapixels: float = 100.0
    # Adobe says 45 MB; decimal megabytes is the strict reading.
    max_file_mb: float = 45.0
    min_vector_megapixels: float = 15.0
    # PNG: transparent margin on any side, as a share of that side, before asking for a tighter crop.
    png_margin_review: float = 0.10
    # PNG: the object's bounding box as a share of the canvas below which the file is rejected.
    png_min_content_area: float = 0.20
    # PNG: share of fully transparent pixels below which the "transparency" is suspicious.
    png_min_transparent: float = 0.02
    jpeg_quality_review: int = 75
    jpeg_quality_reject: int = 50


@dataclass
class Quality:
    # Detail ratios at 100% (see checks/quality.py). Sharp photos measure 0.7 and up on the fine
    # ratio and 0.6 and up on the coarse one; a 3x upscale or a 1.5px blur measures around 0.5.
    sharpness_review: float = 0.60
    sharpness_reject: float = 0.47
    coarse_sharpness_review: float = 0.55
    coarse_sharpness_reject: float = 0.45
    # Luminance noise, standard deviation on a 0-255 scale, measured in smooth areas.
    noise_review: float = 3.5
    noise_reject: float = 7.0
    # Share of pixels with no detail left, ignoring plain white/black studio backgrounds.
    highlight_clip_review: float = 0.20
    shadow_clip_review: float = 0.30
    tile_size: int = 256
    max_tiles: int = 400


@dataclass
class Similarity:
    # Hamming distance between 64-bit perceptual hashes.
    near_duplicate_distance: int = 6
    similar_distance: int = 10
    # How many images of one scene may go to "pass"; the rest go to review.
    max_similar: int = 3


@dataclass
class Metadata:
    title_max: int = 200
    title_recommended: int = 70
    keywords_max: int = 49
    keywords_min: int = 5
    # Extra blocked words, one per line (brands, names...). Relative to the config file.
    extra_blocklist: str = ""


@dataclass
class Vision:
    model: str = "claude-opus-5"
    max_side: int = 1568
    workers: int = 4
    # "low" | "medium" | "high" | "xhigh" | "max"; empty keeps the API default.
    effort: str = ""


@dataclass
class Config:
    technical: Technical = field(default_factory=Technical)
    quality: Quality = field(default_factory=Quality)
    similarity: Similarity = field(default_factory=Similarity)
    metadata: Metadata = field(default_factory=Metadata)
    vision: Vision = field(default_factory=Vision)
    base_dir: Path = field(default_factory=Path.cwd)


class ConfigError(ValueError):
    pass


def load_config(path: str | Path | None) -> Config:
    config = Config()
    if path is None:
        return config
    path = Path(path)
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ConfigError(f"لا يمكن قراءة ملف الإعدادات {path}: {e}") from e
    config.base_dir = path.parent
    for section_name, values in data.items():
        section = getattr(config, section_name, None)
        if section is None or section_name == "base_dir" or not isinstance(values, dict):
            raise ConfigError(f"قسم غير معروف في الإعدادات: [{section_name}]")
        known = {f.name: f for f in fields(section)}
        for key, value in values.items():
            if key not in known:
                raise ConfigError(f"مفتاح غير معروف في الإعدادات: {section_name}.{key}")
            current = getattr(section, key)
            int_for_float = isinstance(current, float) and isinstance(value, int)
            if isinstance(value, bool) or not (isinstance(value, type(current)) or int_for_float):
                raise ConfigError(f"قيمة غير صالحة لـ {section_name}.{key}: {value!r}")
            setattr(section, key, type(current)(value))
    return config
