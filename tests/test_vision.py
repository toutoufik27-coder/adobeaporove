from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from quality_guard.checks import vision
from quality_guard.checks.vision import SCHEMA, VisionReviewer, apply_review
from quality_guard.config import Config
from quality_guard.findings import FileReport, Level, Metadata, Verdict


def report(**meta) -> FileReport:
    r = FileReport(path="x", name="x.jpg", kind="jpeg", size_bytes=0, sha256="abc")
    r.metadata = Metadata(**meta)
    return r


CLEAN = {
    "issues": [], "looks_ai_generated": False, "photorealistic": True, "people": "none",
    "commercial_appeal": "high", "appeal_note_ar": "", "irrelevant_keywords": [],
}


def test_schema_requires_every_field():
    assert set(SCHEMA["required"]) == set(SCHEMA["properties"])
    assert set(CLEAN) == set(SCHEMA["properties"])


def test_clean_review_passes():
    r = report()
    apply_review(r, CLEAN)
    assert r.vision_checked and r.verdict == Verdict.PASS


def test_issues_go_to_review_never_reject():
    r = report()
    apply_review(r, {**CLEAN, "issues": [
        {"category": "ai_anatomy", "confidence": "high", "where": "اليد اليسرى", "explanation_ar": "ستة أصابع"},
        {"category": "logo_trademark", "confidence": "medium", "where": "القميص", "explanation_ar": "شعار"},
    ]})
    assert {f.rule for f in r.findings} == {"vision.ai_anatomy", "vision.logo_trademark"}
    assert all(f.level == Level.REVIEW for f in r.findings)
    assert r.verdict == Verdict.REVIEW


def test_people_need_release_unless_listed_or_ai():
    r = report()
    apply_review(r, {**CLEAN, "people": "recognizable"})
    assert "vision.people_release" in {f.rule for f in r.findings}
    r = report(releases="model-release-1.pdf")
    apply_review(r, {**CLEAN, "people": "recognizable"})
    assert r.verdict == Verdict.PASS
    r = report(ai_generated=True)
    apply_review(r, {**CLEAN, "people": "recognizable"})
    assert r.verdict == Verdict.PASS


def test_refusal_and_errors_need_review():
    r = report()
    apply_review(r, {"refusal": True})
    assert {f.rule for f in r.findings} == {"vision.refused"}
    r = report()
    apply_review(r, {"error": "timeout"})
    assert {f.rule for f in r.findings} == {"vision.failed"} and not r.vision_checked


class FakeMessages:
    def __init__(self, stop_reason="end_turn", payload=CLEAN):
        self.calls = []
        self.stop_reason = stop_reason
        self.payload = payload

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="text", text=json.dumps(self.payload))],
            usage=SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0,
                                  cache_creation_input_tokens=0),
        )


@pytest.fixture
def reviewer(tmp_path, monkeypatch):
    pytest.importorskip("anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setattr(vision, "prepare_views", lambda *a: ("b64", "b64"))
    r = VisionReviewer(Config(), tmp_path / "cache.json")
    r.client = SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages()))
    return r


def test_request_shape_and_cache(reviewer, tmp_path):
    rep = report(title="Lemons", keywords=["lemon"])
    assert reviewer.fetch(tmp_path / "x.jpg", rep) == CLEAN
    call = reviewer.client.beta.messages.calls[0]
    assert call["model"] == "claude-opus-5"
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["output_config"]["format"]["schema"] is SCHEMA
    assert [b["type"] for b in call["messages"][0]["content"]] == ["image", "text", "image", "text"]
    assert "Keywords: lemon" in call["messages"][0]["content"][3]["text"]
    # A second run is served from the cache file.
    again = VisionReviewer(Config(), tmp_path / "cache.json")
    again.client = SimpleNamespace(beta=SimpleNamespace(messages=FakeMessages(payload={"unused": True})))
    assert again.fetch(tmp_path / "x.jpg", rep) == CLEAN
    assert again.client.beta.messages.calls == []


def test_refusal_is_reported(reviewer, tmp_path):
    reviewer.client.beta.messages.stop_reason = "refusal"
    assert reviewer.fetch(tmp_path / "x.jpg", report()) == {"refusal": True}


def test_other_models_skip_fallbacks(reviewer, tmp_path):
    reviewer.config.model = "claude-haiku-4-5"
    reviewer.fetch(tmp_path / "x.jpg", report())
    assert "fallbacks" not in reviewer.client.beta.messages.calls[0]


def test_missing_credentials_disable_vision_instead_of_failing_every_image(tmp_path, monkeypatch):
    pytest.importorskip("anthropic")
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_PROFILE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))  # no `ant auth login` profile either
    with pytest.raises(vision.VisionUnavailable):
        VisionReviewer(Config(), None)
