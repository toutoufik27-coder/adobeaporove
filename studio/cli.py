"""studio: the command line of the production line.

  studio bible check [--month N]          the design law over the whole bible
  studio simulate [--episodes N]           plan N ideas in a row: does the curriculum hold?
  studio idea next [--month N]             the next idea gate 0 accepts
  studio write [--backend cli|api]         write, gate and translate the next episode
  studio gate text EPISODE [--lang L]      gate 1 (and novelty) on an episode.json
  studio voice EPISODE [--enhance]         every line: best of 3 takes, studio chain, 48 kHz / 24-bit
  studio act EPISODE                       the acting director: acting.json (gestures on words, reactions)
  studio plan EPISODE LENGTHS              timeline + Blender shot plan from measured audio
  studio guard scan                        banned model names in code and settings
  studio models install NEED|all           install models whose license is allowed
  studio models verify                     fingerprints of every locked model
  studio gpu status                        both cards: live numbers and registered jobs
  studio agent init|run|status|serve|retry|log|report
                                           the training agent: voices and looks, on both cards
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
    acting_path = Path(args.episode).with_name("acting.json")
    acting = None
    if acting_path.exists():
        from .acting import load as load_acting
        acting = load_acting(acting_path)
    plan = {"timeline": json.loads(tl.to_json()), "shots": shot_plan(bible, ep, tl, acting),
            "acting": bool(acting)}
    out = Path(args.out) if args.out else Path(args.episode).with_name("shots.json")
    out.write_text(json.dumps(plan, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(tl.shots)} shots, {tl.duration:.1f}s, {'directed acting' if acting else 'default acting'} -> {out}")
    return 0


def cmd_act(args) -> int:
    """The acting director: Claude plans the performance of every line; code checks it."""
    from .acting import direct, save
    from .episode import Episode
    from .llm import LLMError, backend
    root = _root(args)
    bible = load_bible(root)
    ep = Episode.load(Path(args.episode))
    try:
        plan, report = direct(bible, ep, backend(args.backend, args.model), rounds=args.rounds)
    except LLMError as e:
        print(f"act: {e}", file=sys.stderr)
        return 1
    out = Path(args.episode).with_name("acting.json")
    save(plan, out)
    for i in report.issues:
        print(i)
    beats = sum(len(la.beats) for la in plan.lines)
    reactions = sum(len(la.listeners) for la in plan.lines)
    print(f"{len(plan.lines)} lines, {beats} acting beats, {reactions} reactions -> {out}")
    return 0


def cmd_voice(args) -> int:
    """Voices an episode on a free card: best of three takes per line, the studio chain."""
    from .episode import Episode
    from .gpu import Busy, Job, Scheduler
    from .models_guard import GuardError, Lock, load_model
    from .voice import Chatterbox, Enhancer, Resemblyzer, Whisper, voice_episode
    root = _root(args)
    bible = load_bible(root)
    ep = Episode.load(Path(args.episode))
    lock, cache = Lock(root / "models.lock.json"), root / "runtime" / "verified.json"
    langs = [args.lang] if args.lang else [ep.language, *ep.translations]
    try:
        with Scheduler(root / "runtime").card(Job(f"{ep.id}/voice", "voice_check"), wait_s=args.wait):
            tts = Chatterbox(load_model("voice", lock, cache))
            sim, asr = Resemblyzer(), Whisper(load_model("whisper", lock, cache))
            enh = Enhancer(load_model("enhance", lock, cache)) if args.enhance else None
            for lang in langs:
                out = Path(args.episode).parent / "audio" / lang
                rep = voice_episode(root, bible, ep, lang, out, tts, sim, asr, enhance=enh)
                print(f"{lang}: {len(rep['lines'])} lines, {len(rep['flagged'])} flagged for a person -> {out}")
    except (Busy, GuardError) as e:
        print(f"voice: {e}", file=sys.stderr)
        return 1
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


def _agent(root: Path):
    from .agent.config import load_config
    from .agent.manager import Manager, SubprocessLauncher
    from .agent.plan import build_plan
    from .agent.store import Store
    from .gpu import Scheduler
    from .llm import backend
    bible = load_bible(root)
    cfg = load_config(root)
    plan = build_plan(bible, cfg)
    store = Store(root / "runtime" / "agent.db")
    mgr = Manager(root, bible, cfg, plan, store, Scheduler(root / "runtime"), SubprocessLauncher(root),
                  llm=backend(cfg.llm) if cfg.llm else None)
    return bible, cfg, plan, store, mgr


def cmd_agent_init(args) -> int:
    from .agent.config import AgentConfig
    root = _root(args)
    cfg_path = root / "agent.json"
    if not cfg_path.exists():
        cfg_path.write_text(json.dumps(AgentConfig().model_dump(), indent=2) + "\n", encoding="utf-8")
        print(f"wrote {cfg_path}: set kohya_dir, and rvc_train_cmd if you will need RVC")
    bible, cfg, plan, store, mgr = _agent(root)
    per = {}
    for t in plan:
        per[t.character] = per.get(t.character, 0) + 1
    print(f"{len(plan)} tasks: " + ", ".join(f"{bible.characters[c].name} {n}" for c, n in per.items()))
    return 0


def cmd_agent_run(args) -> int:
    import fcntl

    from .agent.review import App, serve
    root = _root(args)
    bible, cfg, plan, store, mgr = _agent(root)
    lock = open(root / "runtime" / "agent.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("the agent is already running (runtime/agent.lock)", file=sys.stderr)
        return 1
    app = App(root, store, plan, {c.id: c.name for c in bible.characters.values()}, retry=mgr.retry)
    srv = serve(app, cfg.review_port if args.port is None else args.port)
    print(f"review page: http://127.0.0.1:{srv.server_address[1]}")
    if args.once:
        mgr.tick()
        srv.shutdown()
        return 0
    try:
        mgr.run()
    except KeyboardInterrupt:
        print("\nstopped. Workers already started keep going; `studio agent run` picks everything up again.")
    return 0


def cmd_agent_status(args) -> int:
    bible, cfg, plan, store, mgr = _agent(_root(args))
    for ch, parts in mgr.progress().items():
        print(f"{bible.characters[ch].name:6} voice {parts['voice'][0]:2}/{parts['voice'][1]}   look {parts['look'][0]:2}/{parts['look'][1]}")
    _voices(bible, _root(args))
    labels = {"waiting": "YOUR TURN", "blocked": "NEEDS YOU", "failed": "FAILED", "running": "RUNNING"}
    for status, label in labels.items():
        for r in store.by_status(status):
            extra = f" (GPU {r['card']})" if status == "running" and r["card"] is not None else ""
            why = f": {(r['error'] or '').strip().splitlines()[-1][:160]}" if status in ("blocked", "failed") and r["error"] else ""
            print(f"{label:10} {r['id']}{extra}{why}")
    return 0


def _voices(bible, root: Path) -> None:
    """The pitch of every finished English reference, and voices that would sound alike."""
    from .voice_quality import f0_median, voice_clashes
    measured = {}
    for c in bible.characters.values():
        ref = root / c.voice.refs.get("en", "")
        if c.voice.refs.get("en") and ref.exists():
            try:
                f0 = f0_median(ref)
            except ImportError:
                return
            if f0:
                measured[c.name] = (f0, c.voice.pace)
    if measured:
        print("voices: " + ", ".join(f"{n} {f:.0f} Hz ({p})" for n, (f, p) in measured.items()))
        for clash in voice_clashes(measured):
            print("TOO CLOSE  " + clash)


def cmd_agent_serve(args) -> int:
    import time as _time

    from .agent.review import App, serve
    root = _root(args)
    bible, cfg, plan, store, mgr = _agent(root)
    srv = serve(App(root, store, plan, {c.id: c.name for c in bible.characters.values()}, retry=mgr.retry),
                cfg.review_port if args.port is None else args.port)
    print(f"review page: http://127.0.0.1:{srv.server_address[1]}")
    try:
        while True:
            _time.sleep(3600)
    except KeyboardInterrupt:
        return 0


def cmd_agent_retry(args) -> int:
    *_, mgr = _agent(_root(args))
    ids = mgr.retry(args.task)
    print("reset: " + ", ".join(ids))
    return 0


def cmd_agent_log(args) -> int:
    from .agent.manager import log_path
    p = log_path(_root(args), args.task)
    print(p.read_text(encoding="utf-8", errors="replace")[-args.chars:] if p.exists() else f"no log yet: {p}")
    return 0


def cmd_agent_report(args) -> int:
    import time as _time
    *_, store, _mgr = _agent(_root(args))
    for e in store.events(_time.time() - args.hours * 3600):
        print(f"{_time.strftime('%m-%d %H:%M', _time.localtime(e['ts']))} {e['level']:9} {e['task'] or ''} {e['message']}")
    return 0


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

    c = sub.add_parser("act", help="the acting director: an acting plan for every line (acting.json)")
    c.add_argument("episode")
    c.add_argument("--backend", choices=["cli", "api"], default="cli")
    c.add_argument("--model")
    c.add_argument("--rounds", type=int, default=2)
    c.set_defaults(fn=cmd_act)

    c = sub.add_parser("voice", help="voice an episode: best of 3 takes per line, studio chain")
    c.add_argument("episode")
    c.add_argument("--lang")
    c.add_argument("--enhance", action="store_true", help="Resemble Enhance before the chain (studio models install enhance)")
    c.add_argument("--wait", type=float, default=0)
    c.set_defaults(fn=cmd_voice)

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

    agent = sub.add_parser("agent").add_subparsers(dest="sub", required=True)
    agent.add_parser("init").set_defaults(fn=cmd_agent_init)
    c = agent.add_parser("run")
    c.add_argument("--once", action="store_true", help="one pass, then exit")
    c.add_argument("--port", type=int)
    c.set_defaults(fn=cmd_agent_run)
    agent.add_parser("status").set_defaults(fn=cmd_agent_status)
    c = agent.add_parser("serve")
    c.add_argument("--port", type=int)
    c.set_defaults(fn=cmd_agent_serve)
    c = agent.add_parser("retry")
    c.add_argument("task")
    c.set_defaults(fn=cmd_agent_retry)
    c = agent.add_parser("log")
    c.add_argument("task")
    c.add_argument("--chars", type=int, default=6000)
    c.set_defaults(fn=cmd_agent_log)
    c = agent.add_parser("report")
    c.add_argument("--hours", type=float, default=24)
    c.set_defaults(fn=cmd_agent_report)
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
