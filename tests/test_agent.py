import itertools
import json
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

import pytest

from studio.agent.config import AgentConfig
from studio.agent.look_steps import round2_plan
from studio.agent.manager import Diagnosis, Manager, Outcome, SubprocessLauncher, downstream
from studio.agent.plan import build_plan
from studio.agent.review import App, Invalid, resolve, serve
from studio.agent.store import Store
from studio.gpu import Scheduler
from studio.llm import FakeLLM

from .conftest import ROOT

DAY = datetime(2026, 10, 5, 9, 0).timestamp()


class Clock:
    def __init__(self, t=DAY):
        self.t = t

    def __call__(self):
        return self.t

    def dt(self):
        return datetime.fromtimestamp(self.t)


def images(task, n, shots=None):
    c = task.character
    out = []
    for i in range(n):
        shot = shots[i % len(shots)] if shots else "full_body"
        out.append({"path": f"training/look/{c}/{task.id.split('/')[-1]}/{i:04d}.png", "seed": i, "pose": ["side", "back", "waving"][i % 3],
                    "frame": "full_body" if shot == "group" else shot, "shot": shot, "expression": "happy",
                    "background": "white" if i % 2 == 0 else "scene", "caption": "full body, waving, happy expression"})
    return out


def fake_result(task, store, flags):
    s, c = task.step, task.character
    need = {n.split("/")[-1]: store.get(n)["result"] for n in task.needs}
    lang = task.param("lang")
    if s == "voice.design":
        return {"candidates": [f"training/voice/design/{c}/cand_{i:02d}.wav" for i in range(20)]}
    if s == "voice.pitch":
        return {"pitched": [p.replace(".wav", "_p.wav") for p in need["design"]["candidates"]]}
    if s == "voice.score":
        return {"scores": {p: {"wer": 0.9 if i == 0 else 0.05 + i / 100, "seconds": 4.0, "heard": ""}
                           for i, p in enumerate(need["pitch"]["pitched"])}}
    if s == "voice.ref_candidates":
        return {"candidates": [f"training/voice/dub_refs/{c}/{lang}/cand_{k}.wav" for k in range(5)], "text": "hola", "lang": lang}
    if s == "voice.ref_score":
        return {"scores": {p: {"similarity": 0.7 + k / 50, "wer": 0.1} for k, p in enumerate(need["candidates"]["candidates"])}, "lang": lang}
    if s == "voice.ref_install":
        return {"ref": f"assets/voices/{lang}/x.wav", "lang": lang}
    if s == "voice.validate":
        adv = flags.get("rvc_advised", False)
        return {"stats": {"en": {"fail_rate": 0.3 if adv else 0.02}}, "rvc_advised": adv, "passed": not adv}
    if s == "voice.rvc_data":
        return {"dir": "training/voice/rvc/x", "rvc_ready": True}
    if s == "voice.rvc_train":
        return {"model_dir": "training/voice/rvc_models/x"}
    if s == "look.mother":
        return {"images": images(task, 16)}
    if s == "look.round1":
        return {"images": images(task, 80)}
    if s == "look.round2":
        return {"images": images(task, 96, [p[4] for p in round2_plan()])}
    if s == "look.score":
        (src,) = need.values()
        return {"images": [{**i, "score": round(0.5 + (k % 7) / 20, 3)} for k, i in enumerate(src["images"])]}
    if s == "look.lora":
        v = task.param("version")
        return {"final": f"training/look/loras/{c}_{v}.safetensors", "epochs": [f"training/look/loras/{c}_{v}-00000{e}.safetensors" for e in (6, 7)]}
    if s == "look.eval":
        return {"grids": [{"epoch": f"e{e}", "grid": f"g{e}.png", "score": 0.6 + e / 100} for e in (6, 7)], "prompts": list(range(8)), "seeds": [1, 2, 3, 4]}
    return {"ok": True}


class FakeLauncher:
    """Runs nothing: a task 'finishes' on the next poll, with the result a real step would give."""

    def __init__(self, store, clock, flags=None, fail=None):
        self.store, self.clock, self.flags, self.fail = store, clock, flags or {}, fail or {}
        self.started, self.pids = [], itertools.count(10_000)
        self.live = {}

    def start(self, task, card):
        pid = next(self.pids)
        self.live[pid] = task
        self.started.append((task.id, card, self.clock.dt().hour, dict(self.store.get(task.id)["overrides"] or {})))
        return pid

    def poll(self, task_id, pid):
        task = self.live.pop(pid, None)
        if task is None:  # started by a manager that has since stopped: it finished meanwhile
            task = next(t for t in self.store.plan if t.id == task_id)
        f = self.fail.get(task.step)
        if f:
            out = f(task, self.store)
            if out is not None:
                return out
        return Outcome(True, fake_result(task, self.store, self.flags))

    def kill(self, pid):
        self.live.pop(pid, None)


def make(tmp_path, bible, clock=None, chars=("ch_01",), auto=True, flags=None, fail=None, llm=None, **cfg):
    clock = clock or Clock()
    c = AgentConfig(characters=list(chars), auto=auto, **cfg)
    plan = build_plan(bible, c)
    store = Store(clock=clock)
    store.plan = plan
    launcher = FakeLauncher(store, clock, flags, fail)
    sched = Scheduler(tmp_path / "runtime", clock=clock.dt, alive=lambda pid: True)
    mgr = Manager(tmp_path, bible, c, plan, store, sched, launcher, clock=clock, llm=llm, out=lambda m: None)
    return mgr, store, launcher, clock


def drive(mgr, clock, ticks=200, step_s=1800):
    for _ in range(ticks):
        mgr.tick()
        clock.t += step_s
        if all(r["status"] in ("done", "skipped", "failed", "blocked", "waiting") for r in mgr.store.all().values()):
            mgr.tick()
            break


def test_the_plan_follows_the_training_lab(bible):
    plan = build_plan(bible, AgentConfig())
    assert len(plan) == 6 * 30 and len({t.id for t in plan}) == len(plan)
    kiko = [t.id for t in plan if t.character == "ch_01"]
    assert kiko.index("ch_01/voice/pick") < kiko.index("ch_01/voice/reference") < kiko.index("ch_01/voice/validate")
    assert "ch_01/voice/ref_es/pick" in kiko and not any("ref_pt" in t for t in kiko)
    assert [t.id for t in plan if t.human and t.character == "ch_01"] == [
        "ch_01/voice/pick", "ch_01/voice/ref_es/pick", "ch_01/look/mother_pick", "ch_01/look/round1_select",
        "ch_01/look/round2_select", "ch_01/look/eval_pick"]


def test_languages_without_a_reference_path_are_not_planned(bible):
    plan = build_plan(bible, AgentConfig(month=3, characters=["ch_01"]))  # Portuguese is live, the bible has no pt ref
    assert not any("ref_pt" in t.id for t in plan)


def test_auto_mode_trains_a_character_from_start_to_finish(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible)
    drive(mgr, clock)
    rows = store.all()
    assert all(r["status"] in ("done", "skipped") for r in rows.values()), {k: v["status"] for k, v in rows.items() if v["status"] != "done"}
    assert rows["ch_01/voice/rvc_data"]["status"] == "skipped"          # the voice held: no RVC
    assert rows["ch_01/voice/pick"]["result"]["chosen"].endswith("cand_01_p.wav")  # lowest WER, the broken one left out
    assert rows["ch_01/look/round1_select"]["result"]["selected"]
    lora_hours = [h for tid, _, h, _ in launcher.started if "/lora_" in tid]
    assert lora_hours and all(h >= 22 or h < 8 for h in lora_hours)     # training only at night
    image_hours = [h for tid, _, h, _ in launcher.started if tid.endswith(("/mother", "/round1", "/round2", "/eval"))]
    assert all(8 <= h < 22 for h in image_hours)                        # generation by day


def test_two_characters_train_at_once_one_per_card(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible, chars=("ch_01", "ch_02"))
    drive(mgr, clock)
    cards = {tid.split("/")[0]: card for tid, card, _, _ in launcher.started if tid.endswith("/lora_v1")}
    assert cards == {"ch_01": 0, "ch_02": 1}
    starts = [(tid, h) for tid, _, h, _ in launcher.started if tid.endswith("/lora_v1")]
    assert starts[0][1] == starts[1][1]  # the same night


def test_the_voice_waits_for_a_blind_choice(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible, auto=False)
    drive(mgr, clock, ticks=10)
    row = store.get("ch_01/voice/pick")
    assert row["status"] == "waiting"
    r = row["review"]
    assert len(r["labels"]) == 19 and r["hidden"] == 1 and all(len(k) == 1 for k in r["labels"])
    with pytest.raises(Invalid, match="exactly 3"):
        resolve(store, "ch_01/voice/pick", {"pick": ["A", "B"]}, clock)
    resolve(store, "ch_01/voice/pick", {"pick": ["A", "B", "C"]}, clock)
    with pytest.raises(Invalid, match="minutes"):
        resolve(store, "ch_01/voice/pick", {"pick": ["1"]}, clock)
    clock.t += 601
    resolve(store, "ch_01/voice/pick", {"pick": ["2"]}, clock)
    chosen = store.get("ch_01/voice/pick")["result"]["chosen"]
    assert chosen in [r["labels"][k] for k in "ABC"]
    mgr.tick()
    assert store.get("ch_01/voice/reference")["status"] == "running"


def test_out_of_memory_retries_with_batch_one(tmp_path, bible):
    tries = []

    def oom_once(task, store):
        tries.append(task.id)
        return Outcome(False, log="torch.OutOfMemoryError: CUDA out of memory") if len(tries) == 1 else None

    mgr, store, launcher, clock = make(tmp_path, bible, fail={"look.lora": oom_once})
    drive(mgr, clock)
    assert store.get("ch_01/look/lora_v1")["status"] == "done"
    retry = [o for tid, _, _, o in launcher.started if tid.endswith("/lora_v1")]
    assert retry[0] == {} and retry[1]["batch"] == 1
    assert any("out of memory" in e["message"] for e in store.events())


def test_three_failures_stop_the_task_and_claude_explains(tmp_path, bible):
    llm = FakeLLM([Diagnosis(cause="the reference file is empty", fix="make the reference again")])
    mgr, store, launcher, clock = make(tmp_path, bible, fail={"voice.reference": lambda t, s: Outcome(False, log="boom")}, llm=llm)
    drive(mgr, clock)
    row = store.get("ch_01/voice/reference")
    assert row["status"] == "failed" and row["attempts"] == 3
    assert store.get("ch_01/voice/emotions")["status"] == "pending"      # nothing after it runs
    assert any(e["level"] == "diagnosis" and "empty" in e["message"] for e in store.events())
    assert store.get("ch_01/look/install")["status"] == "done"           # the look is not held up by the voice


def test_blocked_steps_wait_for_a_person_and_retry_resets_what_follows(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible, fail={"look.install": lambda t, s: Outcome(False, blocked="21/32 drawn right")})
    drive(mgr, clock)
    assert store.get("ch_01/look/install")["status"] == "blocked"
    ids = mgr.retry("ch_01/look/eval_pick")
    assert ids == ["ch_01/look/eval_pick", "ch_01/look/install"]
    assert store.get("ch_01/look/eval_pick")["status"] == "pending"
    assert downstream(mgr.plan, "ch_01/look/round2")[-1] == "ch_01/look/install"


def test_rvc_runs_only_when_the_voice_drifts(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible, flags={"rvc_advised": True})
    drive(mgr, clock)
    assert store.get("ch_01/voice/rvc_train")["status"] == "done"
    rvc_hours = [h for tid, _, h, _ in launcher.started if tid.endswith("/rvc_train")]
    assert rvc_hours and (rvc_hours[0] >= 22 or rvc_hours[0] < 8)


def test_a_restarted_manager_continues_where_it_stopped(tmp_path, bible):
    clock = Clock()
    c = AgentConfig(characters=["ch_01"], auto=True)
    plan = build_plan(bible, c)
    store = Store(tmp_path / "agent.db", clock=clock)
    store.plan = plan
    sched = Scheduler(tmp_path / "runtime", clock=clock.dt, alive=lambda pid: True)
    m1 = Manager(tmp_path, bible, c, plan, store, sched, FakeLauncher(store, clock), clock=clock, out=lambda m: None)
    for _ in range(4):
        m1.tick()
    done_before = {k for k, v in store.all().items() if v["status"] == "done"}
    store2 = Store(tmp_path / "agent.db", clock=clock)
    store2.plan = plan
    assert any(v["status"] == "running" for v in store2.all().values())  # it stopped with work under way
    m2 = Manager(tmp_path, bible, c, plan, store2, sched, FakeLauncher(store2, clock), clock=clock, out=lambda m: None)
    assert {k for k, v in store2.all().items() if v["status"] == "done"} == done_before
    drive(m2, clock)
    assert all(r["status"] in ("done", "skipped") for r in store2.all().values())


def test_a_real_worker_process_builds_a_dataset(tmp_path, bible):
    from PIL import Image
    shutil.copytree(ROOT / "bible", tmp_path / "bible")
    plan = {t.id: t for t in build_plan(bible, AgentConfig(characters=["ch_01"]))}
    store = Store(tmp_path / "runtime" / "agent.db")
    store.sync(list(plan.values()))
    pics = []
    for i in range(15):
        p = tmp_path / "training" / "look" / f"{i}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (64, 64), (242, 194, 48)).save(p)
        pics.append({"path": f"training/look/{i}.png", "caption": "full body, waving, happy expression", "shot": "full_body", "background": "white"})
    store.finish("ch_01/look/round1_select", {"selected": pics})
    launcher = SubprocessLauncher(tmp_path)
    pid = launcher.start(plan["ch_01/look/dataset_v1"], None)
    for _ in range(100):
        out = launcher.poll("ch_01/look/dataset_v1", pid)
        if out:
            break
        time.sleep(0.1)
    assert out.ok, out.log
    folder = tmp_path / out.result["dataset"] / "20_kikoch01 character"  # 15 pictures: 20 repeats for 1500 steps
    assert (folder / "0015.png").exists() and (folder / "0001.txt").read_text().startswith("kikoch01, full body")


def test_the_review_page(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible, auto=False)
    drive(mgr, clock, ticks=10)
    audio = tmp_path / "training/voice/design/ch_01"
    audio.mkdir(parents=True)
    for i in range(20):
        (audio / f"cand_{i:02d}_p.wav").write_bytes(b"RIFF" + bytes([i]))
    app = App(tmp_path, store, mgr.plan, {"ch_01": "Kiko"}, clock=clock, retry=mgr.retry)
    srv = serve(app, 0)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        home = urllib.request.urlopen(base + "/").read().decode()
        assert "Kiko" in home and "ch_01/voice/pick" in home
        page = urllib.request.urlopen(base + "/review/ch_01/voice/pick").read().decode()
        assert "cand_" not in page and "/blind/ch_01/voice/pick/A" in page  # blind: no file names
        label, rel = next(iter(store.get("ch_01/voice/pick")["review"]["labels"].items()))
        assert urllib.request.urlopen(f"{base}/blind/ch_01/voice/pick/{label}").read() == (tmp_path / rel).read_bytes()
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(base + "/file/../../etc/passwd")
        assert e.value.code == 404
        data = urllib.parse.urlencode({"pick": ["A", "B", "C"]}, doseq=True).encode()
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(base + "/review/ch_01/voice/pick", data)   # no token: refused
        assert e.value.code == 403
        data = urllib.parse.urlencode({"pick": ["A", "B", "C"], "token": app.token}, doseq=True).encode()
        assert "10" in urllib.request.urlopen(base + "/review/ch_01/voice/pick", data).read().decode()
        assert store.get("ch_01/voice/pick")["review"]["stage"] == 2
        state = json.loads(urllib.request.urlopen(base + "/state.json").read())
        assert state["ch_01/voice/pick"] == "waiting"
    finally:
        srv.shutdown()


def test_image_selection_checks_the_count_and_reports_the_mix(tmp_path, bible):
    mgr, store, launcher, clock = make(tmp_path, bible, auto=False)
    store.finish("ch_01/look/round2_score", {"images": [dict(i, score=0.8) for i in images(build_plan(bible, AgentConfig(characters=["ch_01"]))[22], 96, [p[4] for p in round2_plan()])]})
    task = mgr.by_id["ch_01/look/round2_select"]
    store.set(task.id, status="waiting", review=__import__("studio.agent.steps", fromlist=["REVIEW"]).REVIEW["look.select"](mgr.ctx(task)))
    with pytest.raises(Invalid, match="25-40"):
        resolve(store, task.id, {"pick": [str(i) for i in range(10)]}, clock)
    resolve(store, task.id, {"pick": [str(i) for i in range(30)]}, clock)
    res = store.get(task.id)["result"]
    assert len(res["selected"]) == 30 and isinstance(res["mix_warnings"], list)
