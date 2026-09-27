"""The manager: one loop, run by `studio agent run`, that never holds a GPU itself.

Every tick it collects the workers that finished, then walks the plan: a task whose
needs are done starts when its time window is open and a card has room (the same
scheduler and lock files as `studio gpu run`, so manual jobs and the agent share the
cards safely). Training therefore starts at night, two characters at once (one per
card); generation and voices run by day; a person's choice waits on the review page.

A failed step is retried with a growing pause, three times; known failures change the
retry (out of memory -> batch 1); after that it stops, says why, and, if a model is
configured, Claude explains the log. The state lives in runtime/agent.db, so a restart
or a power cut loses nothing: a worker still running is waited for, a dead one retried."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel

from ..gpu import Busy, Job, Scheduler, _alive, in_window
from .config import AgentConfig
from .plan import Task
from . import look_steps, voice_steps  # noqa: F401  (they register their steps)
from .steps import AUTO, REVIEW, make_ctx
from .store import FINISHED, Store

CPU_SLOTS = 3
RETRY_BASE_S = 120

# known failures -> what the next attempt changes
RULES = [
    (re.compile(r"CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED", re.I),
     {"batch": 1, "low_vram": True}, "out of memory: the next try uses batch 1 and the low-memory options"),
]


@dataclass
class Outcome:
    ok: bool
    result: dict | None = None
    blocked: str | None = None
    log: str = ""


def result_path(root: Path, task_id: str) -> Path:
    return root / "runtime" / "agent" / "results" / (task_id.replace("/", "__") + ".json")


def log_path(root: Path, task_id: str) -> Path:
    return root / "runtime" / "agent" / "logs" / (task_id.replace("/", "__") + ".log")


def _tail(p: Path, n: int = 4000) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")[-n:]
    except OSError:
        return ""


class SubprocessLauncher:
    """A worker per task: `python -m studio.agent.worker TASK`, seeing only its card."""

    def __init__(self, root: Path):
        self.root = root
        self.procs: dict[int, subprocess.Popen] = {}

    def start(self, task: Task, card: int | None) -> int:
        rp = result_path(self.root, task.id)
        rp.unlink(missing_ok=True)
        lp = log_path(self.root, task.id)
        lp.parent.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, CUDA_VISIBLE_DEVICES="" if card is None else str(card))
        with open(lp, "a", encoding="utf-8") as log:
            log.write(f"\n==== {datetime.now():%Y-%m-%d %H:%M:%S} {task.id} card={card}\n")
            log.flush()
            p = subprocess.Popen([sys.executable, "-m", "studio.agent.worker", "--root", str(self.root), task.id],
                                 stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        self.procs[p.pid] = p
        return p.pid

    def poll(self, task_id: str, pid: int) -> Outcome | None:
        p = self.procs.get(pid)
        if p is not None:
            if p.poll() is None:
                return None
            del self.procs[pid]
        elif _alive(pid):  # a worker from before a restart: still at work
            return None
        rp = result_path(self.root, task_id)
        if not rp.exists():
            return Outcome(False, log=_tail(log_path(self.root, task_id)) or "the worker died without a word")
        data = json.loads(rp.read_text(encoding="utf-8"))
        if data.get("ok"):
            return Outcome(True, data.get("result") or {})
        return Outcome(False, blocked=data.get("blocked"), log=data.get("error") or _tail(log_path(self.root, task_id)))

    def kill(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


class Diagnosis(BaseModel):
    cause: str
    fix: str


class Manager:
    def __init__(self, root: Path, bible, cfg: AgentConfig, plan: list[Task], store: Store, sched: Scheduler,
                 launcher, clock=time.time, llm=None, out=print):
        self.root, self.bible, self.cfg, self.plan = root, bible, cfg, plan
        self.store, self.sched, self.launcher, self.clock, self.llm, self.out = store, sched, launcher, clock, llm, out
        self.by_id = {t.id: t for t in plan}
        store.sync(plan)

    # ---------------------------------------------------------------- the loop
    def tick(self) -> None:
        now = self.clock()
        self._reap(now)
        rows = self.store.all()
        cpu_running = sum(1 for r in rows.values() if r["status"] == "running" and r["card"] is None)
        for task in self.plan:
            row = rows[task.id]
            if row["status"] != "pending" or row["not_before"] > now:
                continue
            needs = [rows[n] for n in task.needs]
            if any(n["status"] not in FINISHED for n in needs):
                continue
            if task.when and not any(n["status"] == "done" and (n["result"] or {}).get(task.when) for n in needs):
                self.store.finish(task.id, {"reason": f"{task.when} was not set"}, "skipped")
                self.store.event(task.id, "info", f"skipped: {task.when} was not set")
                rows[task.id]["status"] = "skipped"
                continue
            if task.human:
                self._human(task)
            elif not task.gpu or task.gpu == "cpu":
                if cpu_running < CPU_SLOTS and self._launch(task, None, now):
                    cpu_running += 1
            else:
                self._launch_gpu(task, now)
            rows[task.id] = self.store.get(task.id)

    def run(self, stop=lambda: False) -> None:
        self.out(f"agent: {len(self.plan)} tasks; review page http://127.0.0.1:{self.cfg.review_port}")
        while not stop():
            self.tick()
            time.sleep(self.cfg.tick_s)

    # ---------------------------------------------------------------- launching
    def job(self, task: Task) -> Job:
        # LoRA jobs are named by character: the plan's split puts them on their card
        return Job(task.character if task.gpu == "train_lora" else task.id, task.gpu)

    def _launch_gpu(self, task: Task, now: float) -> None:
        job = self.job(task)
        if not in_window(job.window, datetime.fromtimestamp(now)):
            return
        card = self.sched.free_card(job)
        if card is not None:
            self._launch(task, card, now)

    def _launch(self, task: Task, card: int | None, now: float) -> bool:
        pid = self.launcher.start(task, card)
        if card is not None:
            job = self.job(task)
            try:
                self.sched.acquire(Job(job.name, job.kind, card), pid=pid, force_window=True)
            except Busy:  # another process took the room between the check and now
                self.launcher.kill(pid)
                return False
        self.store.set(task.id, status="running", pid=pid, card=card, started=now)
        self.store.event(task.id, "info", f"started{'' if card is None else f' on GPU {card}'}")
        return True

    # ---------------------------------------------------------------- finishing
    def _reap(self, now: float) -> None:
        for row in self.store.by_status("running"):
            out = self.launcher.poll(row["id"], row["pid"])
            if out is None:
                continue
            if row["card"] is not None:
                self.sched.release(row["card"], pid=row["pid"])
            if out.ok:
                self.store.finish(row["id"], out.result)
                self.store.event(row["id"], "info", "done")
            elif out.blocked:
                self.store.set(row["id"], status="blocked", error=out.blocked, pid=None, card=None)
                self.store.event(row["id"], "action", out.blocked)
                self.notify(f"{row['id']} needs you: {out.blocked}")
            else:
                self._failed(row, out.log, now)

    def _failed(self, row: dict, log: str, now: float) -> None:
        attempts = row["attempts"] + 1
        overrides = dict(row["overrides"] or {})
        for rx, change, why in RULES:
            if rx.search(log) and any(overrides.get(k) != v for k, v in change.items()):
                overrides.update(change)
                self.store.event(row["id"], "warn", why)
        tail = log[-3000:]
        if attempts >= self.cfg.max_attempts:
            self.store.set(row["id"], status="failed", attempts=attempts, overrides=overrides, error=tail, pid=None, card=None)
            self.store.event(row["id"], "error", f"failed {attempts} times; stopped")
            self.notify(f"{row['id']} failed {attempts} times: see `studio agent status`")
            self._diagnose(row["id"], tail)
        else:
            wait = RETRY_BASE_S * 2 ** (attempts - 1)
            self.store.set(row["id"], status="pending", attempts=attempts, overrides=overrides, error=tail,
                           not_before=now + wait, pid=None, card=None)
            self.store.event(row["id"], "warn", f"attempt {attempts} failed; again in {wait // 60} min")

    def _diagnose(self, task_id: str, log: str) -> None:
        if not self.llm:
            return
        try:
            d = self.llm.ask(
                "You help run a local training pipeline for a children's cartoon (SDXL LoRA with kohya_ss, "
                "Parler-TTS, Chatterbox, Whisper, RVC) on two RTX 3090. Read the failure and say the likely cause "
                "and the one fix to try, briefly, for a non-expert.",
                f"Step: {task_id}\nLog tail:\n{log}", Diagnosis)
            self.store.event(task_id, "diagnosis", f"{d.cause} — {d.fix}")
        except Exception as e:  # the explanation is a help, never a new failure
            self.store.event(task_id, "warn", f"no diagnosis: {e}")

    # ---------------------------------------------------------------- people
    def ctx(self, task: Task):
        return make_ctx(self.root, self.bible, self.cfg, task, self.store, log=self.out)

    def _human(self, task: Task) -> None:
        ctx = self.ctx(task)
        if self.cfg.auto:
            result = {**AUTO[task.step](ctx), "auto": True}
            self.store.finish(task.id, result)
            self.store.event(task.id, "warn", "chosen by the metrics (auto mode): check it before publishing")
            return
        self.store.set(task.id, status="waiting", review=REVIEW[task.step](ctx))
        self.store.event(task.id, "action", "waiting for your choice")
        self.notify(f"your turn: {task.id} — http://127.0.0.1:{self.cfg.review_port}/review/{task.id}")

    def retry(self, task_id: str) -> list[str]:
        return reset(self.store, self.plan, task_id)

    def notify(self, message: str) -> None:
        self.out(message)
        if self.cfg.notify_cmd:
            try:
                subprocess.Popen([*self.cfg.notify_cmd, message], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                pass

    # ---------------------------------------------------------------- reading
    def progress(self) -> dict[str, dict[str, tuple[int, int]]]:
        """character -> {"voice": (finished, total), "look": (finished, total)}"""
        rows = self.store.all()
        out: dict[str, dict[str, list[int]]] = {}
        for t in self.plan:
            part = t.id.split("/")[1]
            c = out.setdefault(t.character, {}).setdefault(part, [0, 0])
            c[1] += 1
            c[0] += rows[t.id]["status"] in FINISHED
        return {ch: {k: tuple(v) for k, v in parts.items()} for ch, parts in out.items()}


def downstream(plan: list[Task], task_id: str) -> list[str]:
    """The task and everything that depends on it, in plan order."""
    hit = {task_id}
    for t in plan:
        if any(n in hit for n in t.needs):
            hit.add(t.id)
    return [t.id for t in plan if t.id in hit]


def reset(store: Store, plan: list[Task], task_id: str) -> list[str]:
    """Run a task again, and everything after it (their inputs change). A running task is
    left alone."""
    ids = [i for i in downstream(plan, task_id) if store.get(i)["status"] != "running"]
    for i in ids:
        store.set(i, status="pending", attempts=0, not_before=0, error=None, pid=None, card=None, review=None, result=None)
    store.event(task_id, "info", f"retry asked ({len(ids)} tasks reset)")
    return ids
