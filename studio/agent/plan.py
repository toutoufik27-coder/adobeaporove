"""The training lab as a task graph, per character.

Voice: 20 Parler candidates -> pitch -> Whisper score -> blind pick (you) -> English
reference + recipe -> emotional references -> a reference per dub language (candidates
with cfg_weight=0, score, pick) -> 50 test lines per language -> RVC only when more than
15 % fail -> definition of done.

Look: mother image candidates -> pick (you) -> round 1 (IP-Adapter + OpenPose) -> select
12-18 (you) -> LoRA v1 at night -> round 2 with v1 -> select 25-40 (you) -> LoRA v2 at
night -> evaluation grid for every saved epoch -> pick the epoch (you) -> installed."""
from __future__ import annotations

from dataclasses import dataclass

from ..bible.models import Bible
from .config import AgentConfig


@dataclass(frozen=True)
class Task:
    id: str
    character: str
    step: str
    needs: tuple[str, ...] = ()
    gpu: str | None = None      # scheduler kind; None runs on the CPU
    human: bool = False
    when: str | None = None     # run only if a need's result sets this flag
    params: tuple[tuple[str, object], ...] = ()

    def param(self, key: str, default=None):
        return dict(self.params).get(key, default)


def dub_languages(bible: Bible, cfg: AgentConfig, cid: str) -> list[str]:
    """Live dub languages that have a reference path in the character's bible file."""
    ch = bible.characters[cid]
    primary = bible.world.primary_language
    return [l for l in bible.world.active_languages(cfg.month) if l != primary and l in ch.voice.refs]


def voice_tasks(bible: Bible, cfg: AgentConfig, cid: str) -> list[Task]:
    v = f"{cid}/voice"
    t = [
        Task(f"{v}/design", cid, "voice.design", gpu="voice_design"),
        Task(f"{v}/pitch", cid, "voice.pitch", (f"{v}/design",)),
        Task(f"{v}/score", cid, "voice.score", (f"{v}/pitch",), gpu="whisper"),
        Task(f"{v}/pick", cid, "voice.pick", (f"{v}/score",), human=True),
        Task(f"{v}/reference", cid, "voice.reference", (f"{v}/pick",), gpu="voice"),
        Task(f"{v}/emotions", cid, "voice.emotions", (f"{v}/reference",), gpu="voice"),
    ]
    refs = []
    for lang in dub_languages(bible, cfg, cid):
        r = f"{v}/ref_{lang}"
        p = (("lang", lang),)
        t += [
            Task(f"{r}/candidates", cid, "voice.ref_candidates", (f"{v}/reference",), gpu="voice", params=p),
            Task(f"{r}/score", cid, "voice.ref_score", (f"{r}/candidates",), gpu="voice_check", params=p),
            Task(f"{r}/pick", cid, "voice.ref_pick", (f"{r}/score",), human=True, params=p),
            Task(f"{r}/install", cid, "voice.ref_install", (f"{r}/pick",), params=p),
        ]
        refs.append(f"{r}/install")
    t += [
        Task(f"{v}/validate", cid, "voice.validate", (f"{v}/emotions", *refs), gpu="voice_check"),
        Task(f"{v}/rvc_data", cid, "voice.rvc_data", (f"{v}/validate",), gpu="voice_check", when="rvc_advised"),
        Task(f"{v}/rvc_train", cid, "voice.rvc_train", (f"{v}/rvc_data",), gpu="train_rvc", when="rvc_ready"),
        Task(f"{v}/done", cid, "voice.done", (f"{v}/validate", f"{v}/rvc_train")),
    ]
    return t


def look_tasks(bible: Bible, cfg: AgentConfig, cid: str) -> list[Task]:
    k = f"{cid}/look"
    t = [
        Task(f"{k}/mother", cid, "look.mother", gpu="image"),
        Task(f"{k}/mother_score", cid, "look.score", (f"{k}/mother",)),
        Task(f"{k}/mother_pick", cid, "look.mother_pick", (f"{k}/mother_score",), human=True),
    ]
    prev = f"{k}/mother_pick"
    for rnd, (lo, hi) in ((1, (12, 18)), (2, (25, 40))):
        ver = f"v{rnd}"
        gen = ("look.round1", (prev,)) if rnd == 1 else ("look.round2", (f"{k}/lora_v1",))
        t += [
            Task(f"{k}/round{rnd}", cid, gen[0], gen[1], gpu="image"),
            Task(f"{k}/round{rnd}_score", cid, "look.score", (f"{k}/round{rnd}",)),
            Task(f"{k}/round{rnd}_select", cid, "look.select", (f"{k}/round{rnd}_score",), human=True,
                 params=(("round", rnd), ("min", lo), ("max", hi))),
            Task(f"{k}/dataset_{ver}", cid, "look.dataset", (f"{k}/round{rnd}_select",), params=(("version", ver),)),
            Task(f"{k}/lora_{ver}", cid, "look.lora", (f"{k}/dataset_{ver}",), gpu="train_lora", params=(("version", ver),)),
        ]
    t += [
        Task(f"{k}/eval", cid, "look.eval", (f"{k}/lora_v2",), gpu="image"),
        Task(f"{k}/eval_pick", cid, "look.eval_pick", (f"{k}/eval",), human=True),
        Task(f"{k}/install", cid, "look.install", (f"{k}/eval_pick",)),
    ]
    return t


def build_plan(bible: Bible, cfg: AgentConfig) -> list[Task]:
    ids = cfg.characters or sorted(c.id for c in bible.characters.values() if c.group == "core")
    unknown = [c for c in ids if c not in bible.characters]
    if unknown:
        raise ValueError(f"unknown characters in agent.json: {', '.join(unknown)}")
    plan = [task for cid in ids for task in voice_tasks(bible, cfg, cid) + look_tasks(bible, cfg, cid)]
    known = {t.id for t in plan}
    for task in plan:
        for n in task.needs:
            if n not in known:
                raise AssertionError(f"{task.id} needs unknown {n}")
    return plan
