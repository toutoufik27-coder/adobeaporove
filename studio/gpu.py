"""Two RTX 3090 (24 GB each), shared by training, generation, voices and rendering.

The plan's answer to "both cards busy and training stalled": one lock per card and a
simple queue; training at night, generation and rendering by day; the voice is small
and runs beside a render. Implemented without a daemon: each card has a state file
(runtime/gpu<N>.json) listing the jobs on it, and a process that wants the card locks
that file (flock), drops entries of processes that died, checks the VRAM and the time
window, and registers itself. Two scripts started at once can never both think a
card is free.

The VRAM figures are starting estimates for 24 GB cards; measure with nvidia-smi and
adjust them in one place."""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

CARDS = (0, 1)
VRAM_GB = 24.0
RESERVE_GB = 1.5  # CUDA context, fragmentation

# kind -> (VRAM in GB, exclusive card, window)
KINDS: dict[str, tuple[float, bool, str]] = {
    "train_lora": (22.0, True, "night"),    # SDXL LoRA, bf16, batch 2, gradient checkpointing
    "train_rvc": (10.0, True, "night"),
    "image": (11.0, False, "day"),          # SDXL inference + ControlNet/IP-Adapter
    "segment": (6.0, False, "day"),         # SAM 2
    "voice_design": (5.0, False, "any"),    # Parler-TTS mini
    "voice": (6.0, False, "any"),           # Chatterbox / Multilingual
    "whisper": (6.0, False, "any"),
    "render": (4.0, False, "day"),          # Blender Eevee, flat puppets
}

# the training lab's split: which card a kind of work prefers
PREFERRED = {"image": 0, "render": 0, "segment": 0, "voice_design": 0, "voice": 1, "whisper": 1, "train_rvc": 1}
LORA_CARD = {"ch_01": 0, "ch_03": 0, "ch_05": 0, "ch_02": 1, "ch_04": 1, "ch_06": 1}

NIGHT = (22, 8)  # 22:00 to 08:00


class Busy(Exception):
    """No card can take the job now."""


@dataclass(frozen=True)
class Job:
    name: str
    kind: str
    card: int | None = None  # pinned card, else the scheduler chooses

    @property
    def vram(self) -> float:
        return KINDS[self.kind][0]

    @property
    def exclusive(self) -> bool:
        return KINDS[self.kind][1]

    @property
    def window(self) -> str:
        return KINDS[self.kind][2]


def in_window(window: str, now: datetime) -> bool:
    night = now.hour >= NIGHT[0] or now.hour < NIGHT[1]
    return window == "any" or (window == "night") == night


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def fits(job: Job, running: list[dict]) -> bool:
    if any(r["exclusive"] for r in running):
        return False
    if job.exclusive:
        return not running
    used = sum(r["vram"] for r in running)
    return used + job.vram <= VRAM_GB - RESERVE_GB


class Scheduler:
    def __init__(self, runtime: Path, clock=datetime.now, alive=_alive):
        self.dir = runtime
        self.dir.mkdir(parents=True, exist_ok=True)
        self.clock, self.alive = clock, alive

    def _path(self, card: int) -> Path:
        return self.dir / f"gpu{card}.json"

    @contextlib.contextmanager
    def _locked(self, card: int):
        p = self._path(card)
        with open(p, "a+") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                f.seek(0)
                text = f.read()
                running = [r for r in (json.loads(text) if text.strip() else []) if self.alive(r["pid"])]
                box = {"running": running}
                yield box
                f.seek(0)
                f.truncate()
                f.write(json.dumps(box["running"], indent=1))
                f.flush()
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def running(self, card: int) -> list[dict]:
        with self._locked(card) as box:
            return list(box["running"])

    def cards_for(self, job: Job) -> list[int]:
        if job.card is not None:
            return [job.card]
        if job.kind == "train_lora" and job.name in LORA_CARD:
            return [LORA_CARD[job.name]]
        first = PREFERRED.get(job.kind, 0)
        return [first] + [c for c in CARDS if c != first]

    def acquire(self, job: Job, pid: int | None = None, force_window: bool = False) -> int:
        now = self.clock()
        if not force_window and not in_window(job.window, now):
            raise Busy(f"{job.kind} runs at {job.window} ({NIGHT[0]}:00-{NIGHT[1]:02d}:00 is night); it is {now:%H:%M}")
        for card in self.cards_for(job):
            with self._locked(card) as box:
                if fits(job, box["running"]):
                    box["running"].append({"pid": pid or os.getpid(), "name": job.name, "kind": job.kind,
                                           "vram": job.vram, "exclusive": job.exclusive, "since": now.isoformat(timespec="seconds")})
                    return card
        raise Busy(f"no card has {job.vram:g} GB free{' to itself' if job.exclusive else ''} for {job.name}")

    def release(self, card: int, pid: int | None = None, name: str | None = None) -> None:
        pid = pid or os.getpid()
        with self._locked(card) as box:
            box["running"] = [r for r in box["running"] if not (r["pid"] == pid and (name is None or r["name"] == name))]

    @contextlib.contextmanager
    def card(self, job: Job, wait_s: float = 0, poll_s: float = 30, any_time: bool = False):
        """`with sched.card(job) as n:` - CUDA_VISIBLE_DEVICES=n inside, released after."""
        deadline = time.monotonic() + wait_s
        while True:
            try:
                n = self.acquire(job, force_window=any_time)
                break
            except Busy:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(poll_s)
        old = os.environ.get("CUDA_VISIBLE_DEVICES")
        os.environ["CUDA_VISIBLE_DEVICES"] = str(n)
        try:
            yield n
        finally:
            if old is None:
                os.environ.pop("CUDA_VISIBLE_DEVICES", None)
            else:
                os.environ["CUDA_VISIBLE_DEVICES"] = old
            self.release(n, name=job.name)

    def run(self, job: Job, argv: list[str], wait_s: float = 0, any_time: bool = False) -> int:
        """Run a command on a card; the child sees only that card."""
        with self.card(job, wait_s, any_time=any_time) as n:
            env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(n))
            return subprocess.run(argv, env=env).returncode


def nvidia_smi() -> list[dict]:
    """Live numbers per card, or [] where there is no NVIDIA driver."""
    if not shutil.which("nvidia-smi"):
        return []
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    return parse_smi(out)


def parse_smi(text: str) -> list[dict]:
    cards = []
    for row in text.strip().splitlines():
        i, name, used, total, util, temp = [c.strip() for c in row.split(",")]
        cards.append({"index": int(i), "name": name, "used_mb": int(used), "total_mb": int(total),
                      "util": int(util), "temp_c": int(temp)})
    return cards
