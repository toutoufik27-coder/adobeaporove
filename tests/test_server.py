"""The app's HTTP API, driven the way the page drives it."""

from __future__ import annotations

import http.client
import json
import threading
import time
from http.server import ThreadingHTTPServer

import pytest
from PIL import ImageFilter

from quality_guard import settings as app_settings
from quality_guard.config import Config
from quality_guard.server import App, make_handler


@pytest.fixture
def app_server(tmp_path, monkeypatch):
    monkeypatch.setattr(app_settings, "DIR", tmp_path / "home")
    monkeypatch.setattr(app_settings, "FILE", tmp_path / "home" / "settings.json")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    config = Config()
    config.performance.jobs = 1
    app = App(config, config_from_file=False)
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield app, server.server_address[1]
    server.shutdown()
    server.server_close()


def call(port, method, path, body=None, token=None, host=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    headers = {"Content-Type": "application/json", "Host": host or f"127.0.0.1:{port}"}
    if token:
        headers["X-QG-Token"] = token
    conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    return res.status, res.getheader("Content-Type", ""), data


def test_security_checks(app_server):
    app, port = app_server
    assert call(port, "GET", "/api/state")[0] == 401
    assert call(port, "GET", "/api/state", token="wrong")[0] == 401
    assert call(port, "GET", "/api/state", token=app.token, host="evil.example")[0] == 403
    status, ctype, body = call(port, "GET", "/")
    assert status == 200 and "text/html" in ctype and b"Quality Guard" in body
    assert call(port, "GET", "/../pyproject.toml")[0] == 404
    assert call(port, "GET", "/fonts/../../server.py")[0] == 404
    assert call(port, "GET", "/fonts/reemkufi-arabic.woff2")[1] == "font/woff2"


def test_full_session(app_server, tmp_path, photo):
    app, port = app_server
    batch = tmp_path / "batch"
    batch.mkdir()
    photo.save(batch / "good.jpg", quality=95)
    photo.filter(ImageFilter.GaussianBlur(3)).save(batch / "soft.jpg", quality=95)
    photo.resize((1000, 750)).save(batch / "small.jpg", quality=95)
    t = app.token

    state = json.loads(call(port, "GET", "/api/state", token=t)[2])
    assert state["hardware"]["jobs"] >= 1 and "quality.sharpness_review" in state["thresholds"]

    assert call(port, "POST", "/api/scan", {"input": str(tmp_path / "nope")}, token=t)[0] == 400
    assert call(port, "POST", "/api/scan", {"input": str(batch), "local_ai": False}, token=t)[0] == 200
    for _ in range(300):
        progress = json.loads(call(port, "GET", "/api/progress", token=t)[2])
        if progress["status"] != "running":
            break
        time.sleep(0.1)
    assert progress["status"] == "done", progress
    results = json.loads(call(port, "GET", "/api/results", token=t)[2])
    verdicts = {f["file"]: f["verdict"] for f in results["files"]}
    assert verdicts == {"good.jpg": "pass", "soft.jpg": "reject", "small.jpg": "reject"}
    assert results["reasons"][0]["level"] == 2

    good = next(f for f in results["files"] if f["file"] == "good.jpg")
    status, ctype, body = call(port, "GET", f"/api/thumb/{good['id']}?t={t}")
    assert status == 200 and ctype == "image/jpeg" and body[:2] == b"\xff\xd8"
    assert call(port, "GET", f"/api/file/{good['id']}?t={t}")[0] == 200
    assert call(port, "GET", f"/api/file/{good['id']}")[0] == 401

    soft = next(f for f in results["files"] if f["file"] == "soft.jpg")
    res = json.loads(call(port, "POST", "/api/override", {"id": soft["id"], "verdict": "pass"}, token=t)[2])
    assert res["verdict"] == "pass" and res["overridden"] and res["counts"]["pass"] == 2
    applied = json.loads(call(port, "POST", "/api/apply", {}, token=t)[2])
    out = tmp_path / "batch-quality-guard"
    assert applied["out"] == str(out)
    assert sorted(p.name for p in (out / "pass").iterdir()) == ["good.jpg", "soft.jpg"]
    assert (out / "report.html").is_file()

    # Settings persist and clamp to the slider range.
    state = json.loads(call(port, "POST", "/api/settings", {"thresholds": {"quality.noise_review": 99}}, token=t)[2])
    assert state["thresholds"]["quality.noise_review"]["value"] == 8.0
    saved = json.loads((tmp_path / "home" / "settings.json").read_text(encoding="utf-8"))
    assert saved["thresholds"]["quality.noise_review"] == 8.0 and saved["recent"] == [str(batch.resolve())]


def test_api_key_is_remembered_only_when_asked(app_server, tmp_path, monkeypatch):
    app, port = app_server
    t = app.token
    state = json.loads(call(port, "POST", "/api/settings", {"api_key": "sk-ant-test", "remember": False}, token=t)[2])
    assert state["vision"]["key"] and not state["vision"]["remembered"]
    saved = json.loads((tmp_path / "home" / "settings.json").read_text(encoding="utf-8"))
    assert "api_key" not in saved
    state = json.loads(call(port, "POST", "/api/settings", {"remember": True}, token=t)[2])
    assert state["vision"]["remembered"]
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
