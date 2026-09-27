"""The model that writes and reviews. Code decides what an episode is about (gate 0);
the model only writes the lines and reviews them, and every answer is structured data
validated against a pydantic model, never free text parsed by hand.

Backends:
- ClaudeCLI: the `claude` command in print mode, on the Claude subscription the plan
  already pays for. No tools, no saved session, a JSON schema for the answer.
- AnthropicAPI: the API (pip install kids-studio[api], ANTHROPIC_API_KEY in the
  environment). Structured output, adaptive thinking, and server-side fallback when a
  request is declined.
- FakeLLM: scripted answers for the tests."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from collections.abc import Callable
from typing import Protocol, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)


class LLMError(Exception):
    """No valid answer: a failed call, a refusal, or an answer that is not the schema."""


class LLM(Protocol):
    def ask(self, system: str, prompt: str, schema: type[T]) -> T: ...


def _validate(schema: type[T], data: object, raw: str) -> T:
    try:
        return schema.model_validate(data)
    except ValidationError as e:
        raise LLMError(f"the answer does not match {schema.__name__}: {e}\n--- answer ---\n{raw[:2000]}") from e


def _json_in(text: str) -> object:
    """JSON from a text answer, with or without a ``` fence."""
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    body = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(body)


class ClaudeCLI:
    def __init__(self, model: str | None = None, binary: str = "claude", timeout_s: int = 900):
        self.model, self.binary, self.timeout_s = model, binary, timeout_s

    def argv(self, system: str, schema: type[BaseModel]) -> list[str]:
        argv = [self.binary, "-p", "--output-format", "json",
                "--json-schema", json.dumps(schema.model_json_schema()),
                "--system-prompt", system, "--tools", "", "--no-session-persistence"]
        if self.model:
            argv += ["--model", self.model]
        return argv

    def ask(self, system: str, prompt: str, schema: type[T]) -> T:
        if not shutil.which(self.binary):
            raise LLMError(f"`{self.binary}` is not installed or not on PATH (npm install -g @anthropic-ai/claude-code)")
        try:
            p = subprocess.run(self.argv(system, schema), input=prompt, capture_output=True, text=True, timeout=self.timeout_s)
        except subprocess.TimeoutExpired as e:
            raise LLMError(f"claude did not answer in {self.timeout_s}s") from e
        return self.parse(p.returncode, p.stdout, p.stderr, schema)

    @staticmethod
    def parse(code: int, stdout: str, stderr: str, schema: type[T]) -> T:
        try:
            out = json.loads(stdout)
        except json.JSONDecodeError as e:
            raise LLMError(f"claude exited {code}: {(stderr or stdout)[-1500:]}") from e
        if code or out.get("is_error"):
            raise LLMError(f"claude failed ({out.get('subtype', code)}): {str(out.get('result', stderr))[-1500:]}")
        data = out.get("structured_output")
        if data is None:
            try:
                data = _json_in(out.get("result", ""))
            except (ValueError, TypeError) as e:
                raise LLMError(f"no structured output in the answer: {str(out.get('result'))[:1500]}") from e
        return _validate(schema, data, json.dumps(data) if not isinstance(data, str) else data)


class AnthropicAPI:
    FALLBACK_BETA = "server-side-fallback-2026-07-01"

    def __init__(self, model: str = "claude-opus-5", effort: str = "high", max_tokens: int = 16000, client=None):
        self.model, self.effort, self.max_tokens = model, effort, max_tokens
        self._client = client

    @property
    def client(self):
        if self._client is None:
            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise LLMError("ANTHROPIC_API_KEY is not set: add it to the environment, or use --backend cli")
            try:
                import anthropic
            except ImportError as e:
                raise LLMError("the API backend needs: pip install 'kids-studio[api]'") from e
            self._client = anthropic.Anthropic()
        return self._client

    def ask(self, system: str, prompt: str, schema: type[T]) -> T:
        r = self.client.beta.messages.parse(
            model=self.model,
            max_tokens=self.max_tokens,
            # the bible brief is long and the same for every call of an episode: cache it
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": prompt}],
            output_format=schema,
            thinking={"type": "adaptive"},
            output_config={"effort": self.effort},
            betas=[self.FALLBACK_BETA],
            fallbacks="default",  # a declined request is re-run on the recommended model, server-side
        )
        if r.stop_reason == "refusal":
            raise LLMError(f"the model declined: {getattr(r, 'stop_details', None)}")
        if r.stop_reason == "max_tokens":
            raise LLMError(f"the answer was cut at max_tokens={self.max_tokens}")
        if r.parsed_output is None:
            raise LLMError("no parsed output in the answer")
        return r.parsed_output


class FakeLLM:
    """Answers from a script: models, dicts, or functions of (system, prompt, schema)."""

    def __init__(self, answers: list[object]):
        self.answers = list(answers)
        self.calls: list[tuple[str, str, str]] = []

    def ask(self, system: str, prompt: str, schema: type[T]) -> T:
        self.calls.append((system, prompt, schema.__name__))
        if not self.answers:
            raise LLMError(f"FakeLLM has no answer left for {schema.__name__}")
        a = self.answers.pop(0)
        if isinstance(a, Callable) and not isinstance(a, type):
            a = a(system, prompt, schema)
        if isinstance(a, Exception):
            raise a
        return a if isinstance(a, schema) else _validate(schema, a if not isinstance(a, BaseModel) else a.model_dump(), str(a))


def backend(name: str, model: str | None = None) -> LLM:
    if name == "cli":
        return ClaudeCLI(model)
    if name == "api":
        return AnthropicAPI(model or "claude-opus-5")
    raise ValueError(f"unknown backend {name!r} (cli or api)")
