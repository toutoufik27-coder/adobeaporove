"""agent.json at the project root; every field is optional."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class AgentConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    characters: list[str] = Field(default_factory=list, description="empty: every core character")
    month: int = Field(0, description="production month: which dub languages need a voice")
    auto: bool = Field(False, description="pick by the metrics instead of asking (listen and look before publishing)")
    llm: Literal["cli", "api"] | None = Field(None, description="Claude explains failures the rules do not know")
    kohya_dir: str | None = Field(None, description="folder of sd-scripts (sdxl_train_network.py)")
    rvc_train_cmd: list[str] | None = Field(None, description="argv with {dataset} {name} {out}; RVC has no stable CLI")
    notify_cmd: list[str] | None = Field(None, description='e.g. ["notify-send", "Kiko Studio"]')
    review_port: int = 8765
    tick_s: float = 15.0
    max_attempts: int = 3


def load_config(root: Path) -> AgentConfig:
    p = root / "agent.json"
    return AgentConfig.model_validate(json.loads(p.read_text(encoding="utf-8"))) if p.exists() else AgentConfig()
