"""What a step sees (Ctx) and the registries the manager and the worker read.

STEPS[name](ctx) -> result dict        runs in a worker process, on the card it was given
AUTO[name](ctx) -> result dict         a person's choice made by the metrics (auto mode)
REVIEW[name](ctx) -> review state      what the review page needs for that choice
A step that cannot go on without the person (a missing path, a tool to install) raises
NeedsAction: the task waits as "blocked" with the message, it is not retried."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from ..bible.models import Bible, Character
from ..models_guard import Lock, load_model
from .config import AgentConfig
from .plan import Task

STEPS: dict[str, Callable] = {}
AUTO: dict[str, Callable] = {}
REVIEW: dict[str, Callable] = {}


class NeedsAction(Exception):
    """Something only the person can do; the message says what."""


def step(name: str):
    def deco(fn):
        STEPS[name] = fn
        return fn
    return deco


def auto(name: str):
    def deco(fn):
        AUTO[name] = fn
        return fn
    return deco


def review(name: str):
    def deco(fn):
        REVIEW[name] = fn
        return fn
    return deco


@dataclass
class Ctx:
    root: Path
    bible: Bible
    cfg: AgentConfig
    task: Task
    inputs: dict[str, dict | None]
    params: dict = field(default_factory=dict)
    log: Callable = print

    @property
    def ch(self) -> Character:
        return self.bible.characters[self.task.character]

    @property
    def name(self) -> str:
        return self.ch.name.lower()

    def need(self, suffix: str) -> dict:
        for tid, result in self.inputs.items():
            if tid.endswith("/" + suffix):
                if result is None:
                    raise NeedsAction(f"{tid} has no result")
                return result
        raise KeyError(f"{self.task.id} does not need …/{suffix}")

    def path(self, *parts: str) -> Path:
        p = self.root.joinpath("training", *parts)
        p.mkdir(parents=True, exist_ok=True)
        return p

    def rel(self, p: Path) -> str:
        return str(Path(p).resolve().relative_to(self.root.resolve()))

    def abs(self, rel: str) -> Path:
        return self.root / rel

    def lock(self) -> Lock:
        return Lock(self.root / "models.lock.json")

    def model(self, need: str) -> Path:
        return load_model(need, self.lock(), self.root / "runtime" / "verified.json")

    def model_repo(self, need: str) -> str:
        entry = self.lock().read().get(need)
        if not entry:
            raise NeedsAction(f"no {need} model yet: run `studio models install {need}`")
        return entry["repo"]


def make_ctx(root: Path, bible: Bible, cfg: AgentConfig, task: Task, store, log=print) -> Ctx:
    row = store.get(task.id)
    return Ctx(root, bible, cfg, task, {n: store.get(n)["result"] for n in task.needs},
               {**dict(task.params), **(row["overrides"] or {})}, log)
