import multiprocessing as mp
from datetime import datetime

import pytest

from studio.gpu import Busy, Job, Scheduler, fits, in_window, parse_smi

DAY = datetime(2026, 9, 27, 14, 0)
NIGHT = datetime(2026, 9, 27, 23, 30)


def sched(tmp_path, when=DAY, dead=()):
    return Scheduler(tmp_path, clock=lambda: when, alive=lambda pid: pid not in dead)


def test_training_waits_for_the_night(tmp_path):
    with pytest.raises(Busy, match="night"):
        sched(tmp_path).acquire(Job("ch_01", "train_lora"), pid=1)
    assert sched(tmp_path, NIGHT).acquire(Job("ch_01", "train_lora"), pid=1) == 0
    assert in_window("day", DAY) and not in_window("day", NIGHT) and in_window("any", NIGHT)


def test_lora_training_follows_the_plans_split(tmp_path):
    s = sched(tmp_path, NIGHT)
    assert s.acquire(Job("ch_03", "train_lora"), pid=1) == 0   # Kiko, Tuka, Zuzu on GPU 0
    assert s.acquire(Job("ch_04", "train_lora"), pid=2) == 1   # Beni, Mira, Nilo on GPU 1


def test_training_has_the_card_to_itself(tmp_path):
    s = sched(tmp_path, NIGHT)
    s.acquire(Job("ch_01", "train_lora"), pid=1)
    s.acquire(Job("ch_02", "train_lora"), pid=2)
    with pytest.raises(Busy):
        s.acquire(Job("line", "voice"), pid=3)


def test_the_voice_runs_beside_a_render(tmp_path):
    s = sched(tmp_path)
    assert s.acquire(Job("sh_014", "render", card=1), pid=1) == 1
    assert s.acquire(Job("s14_l1", "voice"), pid=2) == 1
    assert len(s.running(1)) == 2


def test_vram_is_counted(tmp_path):
    s = sched(tmp_path)
    s.acquire(Job("bg1", "image", card=0), pid=1)
    s.acquire(Job("parts", "segment", card=0), pid=2)
    with pytest.raises(Busy):
        s.acquire(Job("l1", "voice", card=0), pid=3)  # 11 + 6 + 6 GB > 24 - 1.5
    assert s.acquire(Job("bg2", "image"), pid=3) == 1  # unpinned: the other card
    assert not fits(Job("x", "image"), [{"vram": 11.0, "exclusive": False}, {"vram": 4.0, "exclusive": False}])


def test_jobs_of_dead_processes_are_forgotten(tmp_path):
    sched(tmp_path).acquire(Job("bg1", "image", card=0), pid=111)
    assert sched(tmp_path, dead={111}).running(0) == []


def test_release_frees_the_card(tmp_path):
    s = sched(tmp_path)
    s.acquire(Job("bg1", "image", card=0), pid=1)
    s.release(0, pid=1)
    assert s.running(0) == []


def _grab(path, q):
    s = Scheduler(path, clock=lambda: NIGHT, alive=lambda pid: True)
    try:
        q.put(s.acquire(Job("ch_01", "train_lora"), pid=mp.current_process().pid))
    except Busy:
        q.put("busy")


def test_two_processes_can_never_both_take_the_card(tmp_path):
    q = mp.Queue()
    ps = [mp.Process(target=_grab, args=(tmp_path, q)) for _ in range(4)]
    for p in ps:
        p.start()
    for p in ps:
        p.join()
    got = sorted(str(q.get()) for _ in ps)
    assert got == ["0", "busy", "busy", "busy"]


def test_nvidia_smi_output():
    cards = parse_smi("0, NVIDIA GeForce RTX 3090, 20480, 24576, 97, 71\n1, NVIDIA GeForce RTX 3090, 512, 24576, 0, 38\n")
    assert cards[0]["used_mb"] == 20480 and cards[1]["temp_c"] == 38


def test_a_command_runs_on_the_card_it_was_given(tmp_path):
    import sys
    s = sched(tmp_path)
    code = s.run(Job("s14_l1", "voice"), [sys.executable, "-c", "import os,sys; sys.exit(int(os.environ['CUDA_VISIBLE_DEVICES']) + 40)"])
    assert code == 41 and s.running(1) == []  # voices prefer GPU 1, and the card is released after
    with pytest.raises(Busy):
        sched(tmp_path, NIGHT).run(Job("sh_014", "render"), [sys.executable, "-c", "pass"])
    assert sched(tmp_path, NIGHT).run(Job("sh_014", "render"), [sys.executable, "-c", "pass"], any_time=True) == 0
