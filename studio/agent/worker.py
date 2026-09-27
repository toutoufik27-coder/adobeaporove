"""One task in its own process: `python -m studio.agent.worker --root ROOT TASK_ID`.
The manager has already given it a card (CUDA_VISIBLE_DEVICES); the result is written
to runtime/agent/results/ for the manager to collect."""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from ..bible import load_bible
from . import look_steps, voice_steps  # noqa: F401  (they register their steps)
from .config import load_config
from .manager import result_path
from .plan import build_plan
from .steps import STEPS, NeedsAction, make_ctx
from .store import Store


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("task")
    args = ap.parse_args(argv)
    root = Path(args.root)
    bible, cfg = load_bible(root), load_config(root)
    task = {t.id: t for t in build_plan(bible, cfg)}[args.task]
    store = Store(root / "runtime" / "agent.db")
    try:
        result = STEPS[task.step](make_ctx(root, bible, cfg, task, store))
        payload = {"ok": True, "result": result}
    except NeedsAction as e:
        payload = {"ok": False, "blocked": str(e)}
    except Exception:
        traceback.print_exc()
        payload = {"ok": False, "error": traceback.format_exc()[-4000:]}
    out = result_path(root, task.id)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(out)
    print(json.dumps({k: v for k, v in payload.items() if k != "error"}, ensure_ascii=False)[:2000])
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
