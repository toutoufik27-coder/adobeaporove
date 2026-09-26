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
    # Estimated from the quantization tables; below this the blocks are visible at 100%.
    jpeg_quality_reject: int = 40


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
    # Mean brightness (0-255) beyond which a photo is over- or underexposed.
    bright_mean_review: float = 225.0
    dark_mean_review: float = 35.0
    # A border this bright/dark over this share of its length is a studio background, not clipping.
    white_background_level: int = 245
    black_background_level: int = 10
    background_border_share: float = 0.6
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
class LocalAI:
    # Text and face detection on this computer (needs `pip install ".[gpu]"`); GPU when available.
    enabled: bool = True
    ocr: bool = True
    faces: bool = True
    gpu: bool = True
    ocr_max_side: int = 2560
    # Below this OCR confidence text is treated as unreadable (garbled when the image is AI-generated).
    ocr_confidence: float = 0.4
    face_score: float = 0.85
    # A face whose short side is this share of the image's short side is treated as recognizable.
    face_min_share: float = 0.025


@dataclass
class Performance:
    # Files analysed at once; 0 sizes the pool from the CPU cores and memory of this computer.
    jobs: int = 0


@dataclass
class Config:
    technical: Technical = field(default_factory=Technical)
    quality: Quality = field(default_factory=Quality)
    similarity: Similarity = field(default_factory=Similarity)
    metadata: Metadata = field(default_factory=Metadata)
    vision: Vision = field(default_factory=Vision)
    local_ai: LocalAI = field(default_factory=LocalAI)
    performance: Performance = field(default_factory=Performance)
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
            int_for_float = isinstance(current, float) and isinstance(value, int) and not isinstance(value, bool)
            if isinstance(value, bool) != isinstance(current, bool) or not (
                isinstance(value, type(current)) or int_for_float
            ):
                raise ConfigError(f"قيمة غير صالحة لـ {section_name}.{key}: {value!r}")
            setattr(section, key, type(current)(value))
    resolve_blocklist(config)
    return config


def resolve_blocklist(config: Config) -> Path | None:
    """The extra blocklist as an absolute path; a missing file is a configuration error."""
    name = config.metadata.extra_blocklist
    if not name:
        return None
    path = Path(name).expanduser()
    if not path.is_absolute():
        path = config.base_dir / path
    if not path.is_file():
        raise ConfigError(f"ملف الكلمات الممنوعة غير موجود: {path}")
    return path
