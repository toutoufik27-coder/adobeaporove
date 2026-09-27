"""The license guard, four automatic layers (setup section of the training lab):

1. models.lock.json: every model by exact repository, commit, file, license and sha256.
   The pipeline runs with nothing else.
2. install: the license is read from the model card on Hugging Face before anything is
   downloaded; if it is not on the allow-list the next candidate is tried.
3. load_model(): the one loader for the whole pipeline. It refuses a file that is not in
   the lock or whose fingerprint changed, even if someone copied it into the folder.
4. guard_scan(): searches the code and settings for banned names and stops the line.

Two additions to the plan's install_models.py: the download is pinned to the commit
whose card was read (a repository can change its license later), and a license given
as a list must be allowed in every entry."""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

ALLOWED = {"apache-2.0", "mit", "openrail++", "cc-by-4.0", "cc0-1.0", "bsd-3-clause"}

# names that must never appear in code or settings; separators between the parts are
# ignored (FLUX.1-dev, flux1_dev) but a name must start a word: "ChatterboxTTS" is not XTTS
BANNED = {
    "flux1dev": "FLUX.1-dev: non-commercial license",
    "xtts": "Coqui XTTS: non-commercial (CPML)",
    "musicgen": "MusicGen weights: non-commercial",
    "civitai": "civitai.com: licenses vary per upload and are not checked",
}

# need -> candidates in order of preference (repo, file); a None file means the whole repo
PLAN: dict[str, list[tuple[str, str | None]]] = {
    "image_base": [("stabilityai/stable-diffusion-xl-base-1.0", "sd_xl_base_1.0.safetensors")],
    "voice_design": [("parler-tts/parler-tts-mini-v1", None), ("hexgrad/Kokoro-82M", None)],
    "voice": [("ResembleAI/chatterbox", None)],
    "voice_rvc": [("lj1995/VoiceConversionWebUI", None)],
    "whisper": [("openai/whisper-large-v3-turbo", None), ("openai/whisper-large-v3", None)],
    "segment": [("facebook/sam2.1-hiera-large", None)],
    "pose": [("xinsir/controlnet-openpose-sdxl-1.0", None), ("thibaud/controlnet-openpose-sdxl-1.0", None)],
    "ip_adapter": [("h94/IP-Adapter", "sdxl_models/ip-adapter_sdxl.safetensors")],
    "music": [("ACE-Step/ACE-Step-v1-3.5B", None)],
}
# when every candidate is refused, the pipeline changes plan instead of stopping
FALLBACK = {
    "voice_rvc": "skip level 2, stay on level 1 (Chatterbox with the reference)",
    "pose": "IP-Adapter with the reference image alone",
    "music": "public-domain nursery melodies + the YouTube Audio Library",
}


class GuardError(Exception):
    """A model or a file the guard refuses."""


class Hub(Protocol):
    def card(self, repo: str) -> tuple[object, str]:
        """(license from the model card, commit sha)"""

    def download(self, repo: str, file: str | None, revision: str) -> Path: ...


class HuggingFace:
    """The real hub (pip install kids-studio[models])."""

    def card(self, repo: str) -> tuple[object, str]:
        from huggingface_hub import model_info
        info = model_info(repo)
        lic = getattr(info.card_data, "license", None) if info.card_data else None
        return lic, info.sha

    def download(self, repo: str, file: str | None, revision: str) -> Path:
        from huggingface_hub import hf_hub_download, snapshot_download
        if file:
            return Path(hf_hub_download(repo, file, revision=revision))
        return Path(snapshot_download(repo, revision=revision))


def license_ok(lic: object) -> bool:
    items = lic if isinstance(lic, list) else [lic]
    return bool(items) and all(isinstance(x, str) and x.lower() in ALLOWED for x in items)


def sha256(path: Path) -> str:
    """Of a file, or of a folder (every file, in path order, name and content)."""
    h = hashlib.sha256()
    files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
    for f in files:
        if path.is_dir():
            h.update(str(f.relative_to(path)).encode() + b"\0")
        with open(f, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
    return h.hexdigest()


@dataclass
class Lock:
    path: Path

    def read(self) -> dict:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8")).get("models", {})

    def write(self, models: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"models": models}, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def install(need: str, lock: Lock, hub: Hub, log=print) -> Path | None:
    """The first candidate with an allowed license, pinned and fingerprinted. None when all
    are refused and the need has a fallback plan; GuardError when it has none."""
    for repo, file in PLAN[need]:
        try:
            lic, rev = hub.card(repo)
        except Exception as e:  # a renamed, removed or gated repository: the next candidate
            log(f"UNREACHABLE {repo}: {e} -> trying next")
            continue
        if not license_ok(lic):
            log(f"BLOCKED {repo}: license={lic} -> trying next")
            continue
        path = hub.download(repo, file, rev)
        models = lock.read()
        models[need] = {"repo": repo, "file": file, "revision": rev, "license": lic,
                        "path": str(path), "sha256": sha256(path)}
        lock.write(models)
        log(f"OK {need}: {repo}@{rev[:10]} ({lic})")
        return path
    if need in FALLBACK:
        log(f"NO MODEL for {need}: {FALLBACK[need]}")
        return None
    raise GuardError(f"no commercially licensed model for {need!r}")


def load_model(need: str, lock: Lock, verified: Path | None = None) -> Path:
    """The path of a locked model after its fingerprint is checked. `verified` caches the
    check by size and modification time, so a 7 GB file is hashed once, not every run."""
    entry = lock.read().get(need)
    if not entry:
        raise GuardError(f"{need} is not in {lock.path.name}: install it with `studio models install {need}`")
    if not license_ok(entry.get("license")):
        raise GuardError(f"{need}: license {entry.get('license')} is not allowed")
    path = Path(entry["path"])
    if not path.exists():
        raise GuardError(f"{need}: {path} is missing")
    stamp = _stamp(path)
    cache = json.loads(verified.read_text()) if verified and verified.exists() else {}
    if cache.get(str(path)) != [entry["sha256"], stamp]:
        if sha256(path) != entry["sha256"]:
            raise GuardError(f"{need}: {path} changed since it was installed (sha256 differs)")
        if verified:
            cache[str(path)] = [entry["sha256"], stamp]
            verified.parent.mkdir(parents=True, exist_ok=True)
            verified.write_text(json.dumps(cache, indent=1))
    return path


def _stamp(path: Path) -> list:
    files = [path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file())
    return [len(files), sum(f.stat().st_size for f in files), max((f.stat().st_mtime_ns for f in files), default=0)]


SCAN_SUFFIXES = {".py", ".json", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".sh", ".txt", ".env"}
SKIP_DIRS = {".git", ".venv", "venv", "__pycache__", "node_modules", "models", ".pytest_cache"}


def guard_scan(root: Path) -> list[str]:
    """Every banned name in code and settings, as 'file:line: reason'. This module is
    skipped: it is where the names are listed."""
    me = Path(__file__).resolve()
    hits = []
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.suffix not in SCAN_SUFFIXES or f.resolve() == me:
            continue
        if any(part in SKIP_DIRS for part in f.relative_to(root).parts):
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            low = line.lower()
            for name, rx in _PATTERNS.items():
                if rx.search(low):
                    hits.append(f"{f.relative_to(root)}:{n}: {BANNED[name]}")
    return hits


def _pattern(name: str) -> re.Pattern:
    runs = re.findall(r"[a-z]+|[0-9]+", name)
    return re.compile(r"(?<![a-z0-9])" + r"[\W_]*".join(runs))


_PATTERNS = {name: _pattern(name) for name in BANNED}
