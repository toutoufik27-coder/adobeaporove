"""ledger.db: what has been made and how it did. Gate 0 reads it (lessons used, format and
value shares, lead rotation), the novelty gate reads past scripts, and the published
numbers per character decide who leads next (problem 16)."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .episode import Episode

SCHEMA = """
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, month INTEGER NOT NULL,
  format TEXT NOT NULL, lesson_id TEXT NOT NULL, value TEXT NOT NULL, lead TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, script TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appearances (
  episode_id TEXT NOT NULL REFERENCES episodes(id), character_id TEXT NOT NULL,
  role TEXT NOT NULL, lines INTEGER NOT NULL, PRIMARY KEY (episode_id, character_id)
);
CREATE TABLE IF NOT EXISTS metrics (
  episode_id TEXT NOT NULL REFERENCES episodes(id), measured_at TEXT NOT NULL,
  views INTEGER NOT NULL, avg_view_pct REAL NOT NULL, returning_share REAL NOT NULL
);
"""


@dataclass(frozen=True)
class Past:
    id: str
    format: str
    lesson_id: str
    value: str
    lead: str
    title: str
    script: str


class Ledger:
    def __init__(self, path: Path | str = ":memory:"):
        self.db = sqlite3.connect(str(path))
        self.db.executescript(SCHEMA)

    def next_id(self) -> str:
        row = self.db.execute("SELECT id FROM episodes ORDER BY id DESC LIMIT 1").fetchone()
        return f"ep_{(int(row[0][3:]) + 1 if row else 1):04d}"

    def add(self, ep: Episode, month: int) -> None:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.db:
            self.db.execute("INSERT INTO episodes VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (ep.id, now, month, ep.format, ep.lesson_id, ep.value, ep.lead, ep.title, ep.status, ep.text()))
            counts: dict[str, int] = {}
            for line in ep.lines():
                counts[line.speaker] = counts.get(line.speaker, 0) + 1
            for ch in ep.cast:
                self.db.execute("INSERT INTO appearances VALUES (?,?,?,?)",
                                (ep.id, ch, "lead" if ch == ep.lead else "featured", counts.get(ch, 0)))

    def recent(self, n: int) -> list[Past]:
        """The last n episodes, most recent first."""
        rows = self.db.execute("SELECT id, format, lesson_id, value, lead, title, script FROM episodes "
                               "ORDER BY id DESC LIMIT ?", (n,)).fetchall()
        return [Past(*r) for r in rows]

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM episodes").fetchone()[0]

    def record_metrics(self, episode_id: str, views: int, avg_view_pct: float, returning_share: float) -> None:
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with self.db:
            self.db.execute("INSERT INTO metrics VALUES (?,?,?,?,?)", (episode_id, now, views, avg_view_pct, returning_share))

    def lead_scores(self) -> dict[str, tuple[int, float, float]]:
        """character -> (episodes led with metrics, mean view %, mean returning share), latest measurement per episode."""
        rows = self.db.execute("""
            SELECT e.lead, COUNT(*), AVG(m.avg_view_pct), AVG(m.returning_share)
            FROM episodes e JOIN metrics m ON m.episode_id = e.id
            WHERE m.measured_at = (SELECT MAX(measured_at) FROM metrics WHERE episode_id = e.id)
            GROUP BY e.lead""").fetchall()
        return {r[0]: (r[1], r[2], r[3]) for r in rows}
