"""Where the project lives. Every path in the bible is relative to the project root."""
from __future__ import annotations

import os
from pathlib import Path


def project_root(start: Path | None = None) -> Path:
    """The directory holding bible/ (STUDIO_ROOT overrides the search)."""
    env = os.environ.get("STUDIO_ROOT")
    if env:
        return Path(env).resolve()
    here = (start or Path.cwd()).resolve()
    for d in (here, *here.parents):
        if (d / "bible" / "world.json").is_file():
            return d
    # the repository itself
    return Path(__file__).resolve().parent.parent
