"""The gates. No episode skips one; each returns issues, and an error blocks the episode.
0 idea · novelty · 1 text (per language) · 2 behaviour (model) · 3 adversarial review
(model, no writing context) · 4 image · 5 assembly."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Issue:
    gate: str
    level: str  # "error" | "warning"
    code: str
    message: str
    line_id: str | None = None

    def __str__(self) -> str:
        where = f" [{self.line_id}]" if self.line_id else ""
        return f"{self.gate} {self.level.upper()} {self.code}{where}: {self.message}"


@dataclass
class GateReport:
    gate: str
    issues: list[Issue] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not any(i.level == "error" for i in self.issues)

    def error(self, code: str, message: str, line_id: str | None = None) -> None:
        self.issues.append(Issue(self.gate, "error", code, message, line_id))

    def warn(self, code: str, message: str, line_id: str | None = None) -> None:
        self.issues.append(Issue(self.gate, "warning", code, message, line_id))

    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]
