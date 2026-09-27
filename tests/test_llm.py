import json
import stat
from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from studio.llm import AnthropicAPI, ClaudeCLI, FakeLLM, LLMError


class Answer(BaseModel):
    name: str
    count: int


def cli_out(**kw):
    base = {"type": "result", "subtype": "success", "is_error": False, "result": ""}
    base.update(kw)
    return json.dumps(base)


def test_cli_reads_the_structured_output():
    a = ClaudeCLI.parse(0, cli_out(structured_output={"name": "Kiko", "count": 3}), "", Answer)
    assert a == Answer(name="Kiko", count=3)


def test_cli_falls_back_to_json_in_the_text():
    a = ClaudeCLI.parse(0, cli_out(result='Here:\n```json\n{"name": "Beni", "count": 1}\n```'), "", Answer)
    assert a.name == "Beni"


def test_cli_errors_are_reported():
    with pytest.raises(LLMError, match="failed"):
        ClaudeCLI.parse(1, cli_out(is_error=True, subtype="error_max_turns", result="boom"), "", Answer)
    with pytest.raises(LLMError, match="exited 1"):
        ClaudeCLI.parse(1, "not json", "Invalid API key", Answer)
    with pytest.raises(LLMError, match="does not match"):
        ClaudeCLI.parse(0, cli_out(structured_output={"name": "Kiko"}), "", Answer)


def test_cli_runs_without_tools_or_saved_sessions():
    argv = ClaudeCLI(model="opus").argv("SYSTEM", Answer)
    assert argv[:4] == ["claude", "-p", "--output-format", "json"]
    assert json.loads(argv[argv.index("--json-schema") + 1])["required"] == ["name", "count"]
    assert argv[argv.index("--tools") + 1] == "" and "--no-session-persistence" in argv
    assert argv[argv.index("--system-prompt") + 1] == "SYSTEM" and argv[-2:] == ["--model", "opus"]


def test_cli_sends_the_prompt_on_stdin(tmp_path):
    fake = tmp_path / "claude"
    fake.write_text('#!/bin/sh\nread -r line\nprintf \'{"is_error": false, "structured_output": {"name": "%s", "count": 2}}\' "$line"\n')
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    assert ClaudeCLI(binary=str(fake)).ask("sys", "Nilo\n", Answer) == Answer(name="Nilo", count=2)


class FakeClient:
    def __init__(self, response):
        self.kw = None
        self.beta = SimpleNamespace(messages=SimpleNamespace(parse=self._parse))
        self.response = response

    def _parse(self, **kw):
        self.kw = kw
        return self.response


def test_api_call_shape():
    c = FakeClient(SimpleNamespace(stop_reason="end_turn", parsed_output=Answer(name="Tuka", count=4)))
    assert AnthropicAPI(client=c).ask("the bible", "write", Answer).name == "Tuka"
    kw = c.kw
    assert kw["model"] == "claude-opus-5" and kw["output_format"] is Answer
    assert kw["thinking"] == {"type": "adaptive"} and kw["output_config"] == {"effort": "high"}
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}


def test_api_refusals_and_cut_answers_are_errors():
    with pytest.raises(LLMError, match="declined"):
        AnthropicAPI(client=FakeClient(SimpleNamespace(stop_reason="refusal", parsed_output=None, stop_details=None))).ask("s", "p", Answer)
    with pytest.raises(LLMError, match="max_tokens"):
        AnthropicAPI(client=FakeClient(SimpleNamespace(stop_reason="max_tokens", parsed_output=None))).ask("s", "p", Answer)


def test_api_without_a_key_says_so(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(LLMError, match="ANTHROPIC_API_KEY"):
        AnthropicAPI().ask("s", "p", Answer)


def test_fake_llm_validates_and_records():
    f = FakeLLM([{"name": "Zuzu", "count": 5}, lambda s, p, schema: schema(name=p, count=0)])
    assert f.ask("s", "p", Answer).count == 5
    assert f.ask("s", "Mira", Answer).name == "Mira"
    assert [c[2] for c in f.calls] == ["Answer", "Answer"]
    with pytest.raises(LLMError):
        f.ask("s", "p", Answer)
