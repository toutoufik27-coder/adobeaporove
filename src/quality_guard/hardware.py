"""What this computer can do: cores, memory and an NVIDIA GPU, used to size the worker pool."""

from __future__ import annotations

import ctypes
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache

# Peak memory of one worker on a 24 MP photo is ~0.45 GB and ~0.75 GB on 50 MP (measured);
# budgeting 1.5 GB leaves room for 100 MP files and for the rest of the system.
GB_PER_WORKER = 1.5
MAX_WORKERS = 32


@dataclass(frozen=True)
class Hardware:
    cores: int
    ram_gb: float
    gpu: str  # "" when no NVIDIA GPU was found
    gpu_ram_gb: float

    def auto_jobs(self) -> int:
        by_cores = max(1, self.cores - 1)
        by_ram = max(1, int(self.ram_gb // GB_PER_WORKER)) if self.ram_gb else 3
        return max(1, min(by_cores, by_ram, MAX_WORKERS))

    def to_dict(self) -> dict:
        return {"cores": self.cores, "ram_gb": round(self.ram_gb, 1), "gpu": self.gpu,
                "gpu_ram_gb": round(self.gpu_ram_gb, 1), "jobs": self.auto_jobs()}


def _ram_gb() -> float:
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                        ("avail", ctypes.c_ulonglong), ("page_total", ctypes.c_ulonglong),
                        ("page_avail", ctypes.c_ulonglong), ("virtual_total", ctypes.c_ulonglong),
                        ("virtual_avail", ctypes.c_ulonglong), ("extended", ctypes.c_ulonglong)]

        status = MemoryStatus()
        status.length = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
            return status.total / 1024**3
        return 0.0
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    except (ValueError, OSError, AttributeError):
        return 0.0


def _nvidia_smi() -> tuple[str, float]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return "", 0.0
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip().splitlines()
    except (OSError, subprocess.SubprocessError):
        return "", 0.0
    if not out:
        return "", 0.0
    name, _, mem = out[0].partition(",")
    try:
        return name.strip(), float(mem) / 1024
    except ValueError:
        return name.strip(), 0.0


@lru_cache(maxsize=1)
def cuda_available() -> bool:
    """PyTorch can use the GPU (the local AI checks need it for speed). Imports torch, so it's slow once."""
    try:
        import torch  # noqa: PLC0415 - optional, heavy
    except ImportError:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


@lru_cache(maxsize=1)
def detect() -> Hardware:
    gpu, gpu_ram = _nvidia_smi()
    return Hardware(cores=os.cpu_count() or 2, ram_gb=_ram_gb(), gpu=gpu, gpu_ram_gb=gpu_ram)
