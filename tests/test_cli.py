import json
import shutil

from studio.cli import main

from .conftest import FIXTURES, ROOT


def test_bible_check_guard_and_simulate(capsys):
    assert main(["--root", str(ROOT), "bible", "check"]) == 0
    assert main(["--root", str(ROOT), "guard", "scan"]) == 0
    assert main(["--root", str(ROOT), "simulate", "--episodes", "40", "--show", "0"]) == 0
    assert "0 errors" in capsys.readouterr().out


def test_idea_next_on_a_fresh_project(tmp_path, capsys):
    shutil.copytree(ROOT / "bible", tmp_path / "bible")
    assert main(["--root", str(tmp_path), "idea", "next"]) == 0
    idea = json.loads(capsys.readouterr().out.split("\n}")[0] + "}")
    assert idea["lead"] == "ch_01" and (tmp_path / "ledger.db").exists()


def test_plan_writes_the_shot_plan(tmp_path, capsys):
    ep = tmp_path / "episode.json"
    shutil.copy(FIXTURES / "pilot.json", ep)
    data = json.loads(ep.read_text())
    lengths = {l["id"]: 1.4 for b in data["beats"] for l in b["lines"]}
    (tmp_path / "lengths.json").write_text(json.dumps(lengths))
    assert main(["--root", str(ROOT), "plan", str(ep), str(tmp_path / "lengths.json")]) == 0
    plan = json.loads((tmp_path / "shots.json").read_text())
    assert plan["shots"] and plan["timeline"]["fps"] == 24


def test_gate_text_fails_a_pilot_against_the_six_minute_format(capsys):
    assert main(["--root", str(ROOT), "gate", "text", str(FIXTURES / "pilot.json")]) == 1
    assert "structure.length" in capsys.readouterr().out


def test_gpu_status_without_a_driver(tmp_path, capsys):
    assert main(["--root", str(tmp_path), "gpu", "status"]) == 0
    assert "GPU 0" in capsys.readouterr().out
