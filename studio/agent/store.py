"""runtime/agent.db: the state of every task, so the agent survives a restart or a power
cut and picks up where it was."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from functools import wraps
from pathlib import Path

from .plan import Task

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, character TEXT NOT NULL, step TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending running waiting done skipped failed blocked
  attempts INTEGER NOT NULL DEFAULT 0, not_before REAL NOT NULL DEFAULT 0,
  card INTEGER, pid INTEGER, started REAL, finished REAL,
  result TEXT, error TEXT, review TEXT, overrides TEXT
);
CREATE TABLE IF NOT EXISTS events (ts REAL NOT NULL, task TEXT, level TEXT NOT NULL, message TEXT NOT NULL);
"""
FINISHED = ("done", "skipped")


def _locked(fn):
    @wraps(fn)
    def inner(self, *a, **kw):
        with self.lock:
            return fn(self, *a, **kw)
    return inner
JSON_COLS = ("result", "review", "overrides")


class Store:
    def __init__(self, path: Path | str = ":memory:", clock=time.time):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.clock = clock
        self.lock = threading.RLock()  # the review page and the loop share one connection

    @_locked
    def sync(self, plan: list[Task]) -> int:
        """Adds tasks the plan has and the store does not; never resets existing ones."""
        with self.db:
            cur = self.db.executemany("INSERT OR IGNORE INTO tasks (id, character, step, status) VALUES (?,?,?, 'pending')",
                                      [(t.id, t.character, t.step) for t in plan])
        return cur.rowcount

    @_locked
    def get(self, task_id: str) -> dict:
        row = self.db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        d = dict(row)
        for k in JSON_COLS:
            d[k] = json.loads(d[k]) if d[k] else ({} if k != "result" else None)
        return d

    @_locked
    def all(self) -> dict[str, dict]:
        return {r["id"]: self.get(r["id"]) for r in self.db.execute("SELECT id FROM tasks ORDER BY rowid")}

    @_locked
    def by_status(self, *status: str) -> list[dict]:
        q = f"SELECT id FROM tasks WHERE status IN ({','.join('?' * len(status))}) ORDER BY rowid"
        return [self.get(r["id"]) for r in self.db.execute(q, status)]

    @_locked
    def set(self, task_id: str, **fields) -> None:
        for k in JSON_COLS:
            if k in fields and fields[k] is not None and not isinstance(fields[k], str):
                fields[k] = json.dumps(fields[k], ensure_ascii=False)
        cols = ", ".join(f"{k}=?" for k in fields)
        with self.db:
            if self.db.execute(f"UPDATE tasks SET {cols} WHERE id=?", (*fields.values(), task_id)).rowcount != 1:
                raise KeyError(task_id)

    @_locked
    def finish(self, task_id: str, result: dict, status: str = "done") -> None:
        self.set(task_id, status=status, result=result, finished=self.clock(), pid=None, card=None, error=None)

    @_locked
    def event(self, task_id: str | None, level: str, message: str) -> None:
        with self.db:
            self.db.execute("INSERT INTO events VALUES (?,?,?,?)", (self.clock(), task_id, level, message))

    @_locked
    def events(self, since: float = 0) -> list[dict]:
        return [dict(r) for r in self.db.execute("SELECT * FROM events WHERE ts>=? ORDER BY ts", (since,))]
