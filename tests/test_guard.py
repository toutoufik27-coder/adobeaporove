
import pytest

from studio.models_guard import BANNED, PLAN, GuardError, Lock, guard_scan, install, license_ok, load_model

from .conftest import ROOT


class FakeHub:
    def __init__(self, tmp, licenses):
        self.tmp, self.licenses, self.downloads = tmp, licenses, []

    def card(self, repo):
        lic = self.licenses[repo]
        if isinstance(lic, Exception):
            raise lic
        return lic, "a" * 40

    def download(self, repo, file, revision):
        self.downloads.append((repo, revision))
        p = self.tmp / repo.replace("/", "__")
        p.write_bytes(repo.encode())
        return p


def lic_all(value):
    return {repo: value for cands in PLAN.values() for repo, _ in cands}


def test_the_allow_list():
    assert license_ok("apache-2.0") and license_ok("MIT") and license_ok("openrail++")
    assert not license_ok("other") and not license_ok(None) and not license_ok("cc-by-nc-4.0")
    assert not license_ok(["mit", "cc-by-nc-4.0"])


def test_a_refused_license_moves_to_the_next_candidate(tmp_path):
    lic = lic_all("apache-2.0")
    first, second = [r for r, _ in PLAN["voice_design"]]
    lic[first] = "cc-by-nc-4.0"
    hub, lock, log = FakeHub(tmp_path, lic), Lock(tmp_path / "models.lock.json"), []
    install("voice_design", lock, hub, log.append)
    entry = lock.read()["voice_design"]
    assert entry["repo"] == second and entry["revision"] == "a" * 40 and len(entry["sha256"]) == 64
    assert log[0].startswith("BLOCKED") and hub.downloads == [(second, "a" * 40)]  # pinned to the card's commit


def test_an_unreachable_repository_is_skipped(tmp_path):
    lic = lic_all("apache-2.0")
    lic[PLAN["pose"][0][0]] = RuntimeError("404")
    install("pose", Lock(tmp_path / "l.json"), FakeHub(tmp_path, lic), lambda m: None)


def test_when_everything_is_refused_the_plan_changes_or_stops(tmp_path):
    hub = FakeHub(tmp_path, lic_all("other"))
    assert install("music", Lock(tmp_path / "l.json"), hub, lambda m: None) is None  # public-domain melodies
    with pytest.raises(GuardError):
        install("image_base", Lock(tmp_path / "l.json"), hub, lambda m: None)
    assert hub.downloads == []


def test_load_model_refuses_what_is_not_locked_or_was_changed(tmp_path):
    hub, lock = FakeHub(tmp_path, lic_all("mit")), Lock(tmp_path / "models.lock.json")
    path = install("voice", lock, hub, lambda m: None)
    cache = tmp_path / "verified.json"
    assert load_model("voice", lock, cache) == path
    assert load_model("voice", lock, cache) == path  # second time from the cache
    with pytest.raises(GuardError, match="not in"):
        load_model("whisper", lock)
    path.write_bytes(b"someone swapped the weights")
    with pytest.raises(GuardError, match="changed"):
        load_model("voice", lock, cache)


def test_guard_scan_finds_banned_names(tmp_path):
    name = next(iter(BANNED))
    (tmp_path / "gen.py").write_text(f"MODEL = 'models/{name[:4]}.{name[4:]}.safetensors'\n")
    (tmp_path / "ok.py").write_text("print('hello')\n")
    hits = guard_scan(tmp_path)
    assert len(hits) == 1 and hits[0].startswith("gen.py:1:")


def test_real_names_are_caught_and_lookalikes_are_not(tmp_path):
    n = list(BANNED)  # the names are only built here, so this file passes the scan itself
    bad = [f"repo = 'black-forest-labs/{n[0][:4].upper()}.1-{n[0][5:]}'", f"voice = 'coqui/{n[1].upper()}-v2'",
           f"m = 'facebook/{n[2]}-small'", f"url = 'https://{n[3]}.com/models/1'"]
    good = ["from chatterbox.tts import ChatterboxTTS", "boxtts = 1", "my_music_generator = None"]
    (tmp_path / "a.py").write_text("\n".join(bad + good) + "\n")
    assert [h.split(":")[1] for h in guard_scan(tmp_path)] == ["1", "2", "3", "4"]


def test_this_repository_is_clean():
    assert guard_scan(ROOT) == []
