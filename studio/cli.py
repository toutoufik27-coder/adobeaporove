"""studio: the command line of the production line.

  studio bible check [--month N]          the design law over the whole bible
  studio simulate [--episodes N]           plan N ideas in a row: does the curriculum hold?
  studio idea next [--month N]             the next idea gate 0 accepts
  studio write [--backend cli|api]         write, gate and translate the next episode
  studio gate text EPISODE [--lang L]      gate 1 (and novelty) on an episode.json
  studio plan EPISODE LENGTHS              timeline + Blender shot plan from measured audio
  studio guard scan                        banned model names in code and settings
  studio models install NEED|all           install models whose license is allowed
  studio models verify                     fingerprints of every locked model
  studio gpu status                        both cards: live numbers and registered jobs
  studio gpu run [--any-time] KIND NAME -- CMD...   run a command on a free card, in its window
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .bible import BibleError, check_bible, load_bible
from .paths import project_root


def _root(args) -> Path:
    return Path(args.root) if args.root else project_root()


def _ledger(root: Path):
    from .ledger import Ledger
    return Ledger(root / "ledger.db")


def cmd_bible_check(args) -> int:
    bible = load_bible(_root(args))
    findings = check_bible(bible, args.month)
    for f in findings:
        print(f)
    errors = sum(f.level == "error" for f in findings)
    print(f"{len(bible.characters)} characters, {len(bible.formats)} formats, {len(bible.curriculum.lessons)} lessons: "
          f"{errors} errors, {len(findings) - errors} warnings")
    return 1 if errors else 0


def cmd_simulate(args) -> int:
    from collections import Counter

    from .gates.idea import simulate
    bible = load_bible(_root(args))
    per = args.per_month
    ideas = simulate(bible, args.episodes, lambda n: n // per)
    names = {c.id: c.name for c in bible.characters.values()}
    for n, i in enumerate(ideas, 1):
        if n <= args.show:
            print(f"{n:4d} m{(n - 1) // per} {i.format:18} {i.lesson_id:28} {i.value:18} {names[i.lead]}")
    print("formats:", dict(Counter(i.format for i in ideas)))
    print("leads:  ", dict(Counter(names[i.lead] for i in ideas)))
    return 0


def cmd_idea_next(args) -> int:
    from .gates.idea import check_idea, choose_idea
    root = _root(args)
    bible = load_bible(root)
    ledger = _ledger(root)
    history = ledger.recent(10**6)
    idea = choose_idea(bible, history, args.month, ledger.lead_scores())
    print(idea.model_dump_json(indent=2))
    report = check_idea(bible, idea, history)
    for i in report.issues:
        print(i)
    return 0 if report.passed else 1


def cmd_write(args) -> int:
    from .llm import backend
    from .writer import WriteFailed, write_episode
    root = _root(args)
    bible = load_bible(root)
    try:
        res = write_episode(bible, _ledger(root), backend(args.backend, args.model), args.month,
                            out_dir=root / "episodes", max_rounds=args.rounds)
    except WriteFailed as e:
        print(f"FAILED: {e}", file=sys.stderr)
        if e.result.path:
            print(f"draft and issues: {e.result.path}", file=sys.stderr)
        return 1
    for r in res.reports:
        for i in r.issues:
            print(i)
    print(f"gated: {res.path} ({res.rounds} rounds)")
    return 0


def cmd_gate_text(args) -> int:
    from .episode import Episode
    from .gates.novelty import check_novelty
    from .gates.text import check_text
    root = _root(args)
    bible = load_bible(root)
    ep = Episode.load(Path(args.episode))
    langs = [args.lang] if args.lang else [ep.language, *ep.translations]
    reports = [check_text(bible, ep, l) for l in langs]
    history = [p for p in _ledger(root).recent(10**6) if p.id != ep.id] if (root / "ledger.db").exists() else []
    reports.append(check_novelty(bible, ep, history))
    for r in reports:
        for i in r.issues:
            print(i)
        print(f"{r.gate}: {'passed' if r.passed else 'FAILED'}")
    return 0 if all(r.passed for r in reports) else 1


def cmd_plan(args) -> int:
    from .episode import Episode
    from .performance import shot_plan
    from .timing import build_timeline
    root = _root(args)
    bible = load_bible(root)
    ep = Episode.load(Path(args.episode))
    lengths = json.loads(Path(args.lengths).read_text())
    tl = build_timeline(ep, lengths, bible.world.fps)
    plan = {"timeline": json.loads(tl.to_json()), "shots": shot_plan(bible, ep, tl)}
    out = Path(args.out) if args.out else Path(args.episode).with_name("shots.json")
    out.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(tl.shots)} shots, {tl.duration:.1f}s -> {out}")
    return 0


def cmd_guard_scan(args) -> int:
    from .models_guard import guard_scan
    hits = guard_scan(_root(args))
    for h in hits:
        print("BANNED", h)
    print("guard: clean" if not hits else f"guard: {len(hits)} banned names: the line stops here")
    return 1 if hits else 0


def cmd_models_install(args) -> int:
    from .models_guard import PLAN, GuardError, HuggingFace, Lock, install
    lock = Lock(_root(args) / "models.lock.json")
    needs = list(PLAN) if args.need == "all" else [args.need]
    try:
        for need in needs:
            install(need, lock, HuggingFace())
    except GuardError as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 1
    return 0


def cmd_models_verify(args) -> int:
    from .models_guard import GuardError, Lock, load_model
    root = _root(args)
    lock = Lock(root / "models.lock.json")
    bad = 0
    for need in lock.read():
        try:
            print(f"OK   {need}: {load_model(need, lock, root / 'runtime' / 'verified.json')}")
        except GuardError as e:
            bad += 1
            print(f"FAIL {e}")
    return 1 if bad else 0


def cmd_gpu_status(args) -> int:
    from .gpu import CARDS, Scheduler, nvidia_smi
    sched = Scheduler(_root(args) / "runtime")
    live = {c["index"]: c for c in nvidia_smi()}
    for n in CARDS:
        c = live.get(n)
        head = f"GPU {n}: {c['name']} {c['used_mb'] / 1024:.1f}/{c['total_mb'] / 1024:.0f} GB, {c['util']}%, {c['temp_c']}°C" \
            if c else f"GPU {n}: (no nvidia-smi)"
        print(head)
        for r in sched.running(n):
            print(f"   {r['kind']:12} {r['name']:20} {r['vram']:>5.1f} GB  pid {r['pid']}  since {r['since']}")
    return 0


def cmd_gpu_run(args) -> int:
    from .gpu import Busy, Job, Scheduler
    if args.cmd and args.cmd[0].startswith("-") and args.cmd[0] != "--":
        print(f"{args.cmd[0]}: options go before KIND: studio gpu run [--any-time] KIND NAME -- CMD", file=sys.stderr)
        return 2
    cmd = args.cmd[1:] if args.cmd[:1] == ["--"] else args.cmd
    if not cmd:
        print("nothing to run: studio gpu run KIND NAME -- command ...", file=sys.stderr)
        return 2
    try:
        return Scheduler(_root(args) / "runtime").run(Job(args.name, args.kind, args.card), cmd, wait_s=args.wait,
                                                       any_time=args.any_time)
    except Busy as e:
        print(f"BUSY: {e}", file=sys.stderr)
        return 75


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="studio", description="Kiko & Friends production line")
    p.add_argument("--root", help="project folder (default: the one holding bible/world.json)")
    sub = p.add_subparsers(dest="cmd", required=True)

    bible = sub.add_parser("bible").add_subparsers(dest="sub", required=True)
    c = bible.add_parser("check")
    c.add_argument("--month", type=int, default=0)
    c.set_defaults(fn=cmd_bible_check)

    c = sub.add_parser("simulate")
    c.add_argument("--episodes", type=int, default=120)
    c.add_argument("--per-month", type=int, default=20)
    c.add_argument("--show", type=int, default=24)
    c.set_defaults(fn=cmd_simulate)

    idea = sub.add_parser("idea").add_subparsers(dest="sub", required=True)
    c = idea.add_parser("next")
    c.add_argument("--month", type=int, default=0)
    c.set_defaults(fn=cmd_idea_next)

    c = sub.add_parser("write")
    c.add_argument("--backend", choices=["cli", "api"], default="cli")
    c.add_argument("--model")
    c.add_argument("--month", type=int, default=0)
    c.add_argument("--rounds", type=int, default=3)
    c.set_defaults(fn=cmd_write)

    gate = sub.add_parser("gate").add_subparsers(dest="sub", required=True)
    c = gate.add_parser("text")
    c.add_argument("episode")
    c.add_argument("--lang")
    c.set_defaults(fn=cmd_gate_text)

    c = sub.add_parser("plan")
    c.add_argument("episode")
    c.add_argument("lengths", help="JSON: line id -> seconds of audio")
    c.add_argument("--out")
    c.set_defaults(fn=cmd_plan)

    guard = sub.add_parser("guard").add_subparsers(dest="sub", required=True)
    guard.add_parser("scan").set_defaults(fn=cmd_guard_scan)

    models = sub.add_parser("models").add_subparsers(dest="sub", required=True)
    c = models.add_parser("install")
    c.add_argument("need")
    c.set_defaults(fn=cmd_models_install)
    models.add_parser("verify").set_defaults(fn=cmd_models_verify)

    gpu = sub.add_parser("gpu").add_subparsers(dest="sub", required=True)
    gpu.add_parser("status").set_defaults(fn=cmd_gpu_status)
    c = gpu.add_parser("run")
    c.add_argument("kind")
    c.add_argument("name")
    c.add_argument("--card", type=int)
    c.add_argument("--wait", type=float, default=0, help="seconds to wait for a free card")
    c.add_argument("--any-time", action="store_true", help="ignore the day/night window (VRAM is still checked)")
    c.add_argument("cmd", nargs=argparse.REMAINDER)
    c.set_defaults(fn=cmd_gpu_run)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except BibleError as e:
        print(f"bible: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
