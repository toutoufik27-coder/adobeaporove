"""The app: a small web server on this computer only, and the page it serves.

Only 127.0.0.1 is bound, the Host header must be local (no DNS rebinding), and every API call must
carry the random token the browser was opened with, so other websites cannot drive it.
"""

from __future__ import annotations

import json
import mimetypes
import os
import secrets
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__, hardware
from . import settings as app_settings
from .checks.local_ai import available as local_ai_available
from .config import Config, ConfigError
from .findings import GROUPS, Level, Verdict
from .metadata_io import CsvFormatError
from .pipeline import analyse, default_out_dir, publish
from .report import PRICES
from .scanner import Cancelled, ProgressEvent, ScanResult

UI = resources.files("quality_guard").joinpath("ui")
FILE_TYPES = {"jpeg": "image/jpeg", "png": "image/png", "svg": "image/svg+xml"}
# Rough tokens per image for the cost hint: two views (~3,000 input tokens) and the reply with thinking.
VISION_TOKENS = (4_500, 1_500)

PICK_FOLDER = r"""
import sys, tkinter as tk
from tkinter import filedialog
root = tk.Tk(); root.withdraw()
try: root.attributes("-topmost", True)
except Exception: pass
path = filedialog.askdirectory(title=sys.argv[1], initialdir=sys.argv[2] or None, mustexist=True)
sys.stdout.write(path or "")
"""


class App:
    def __init__(self, config: Config, config_from_file: bool):
        self.lock = threading.Lock()
        self.config = config
        self.settings = app_settings.load()
        if not config_from_file:
            app_settings.apply_thresholds(self.config, self.settings.get("thresholds", {}))
        if self.settings.get("vision_model"):
            self.config.vision.model = self.settings["vision_model"]
        if self.settings.get("api_key") and not os.environ.get("ANTHROPIC_API_KEY"):
            os.environ["ANTHROPIC_API_KEY"] = self.settings["api_key"]
        self.token = secrets.token_urlsafe(24)
        self.reset()

    def reset(self) -> None:
        self.status = "idle"  # idle, running, done, error, cancelled
        self.error = ""
        self.input_dir: Path | None = None
        self.out_dir: Path | None = None
        self.stage = ""
        self.done = 0
        self.total = 0
        self.current = ""
        self.started = 0.0
        self.partial: dict[int, object] = {}
        self.recent: list[int] = []
        self.result: ScanResult | None = None
        self.applied: dict | None = None
        self.cancel = threading.Event()

    # --- scanning -------------------------------------------------------------------------

    def start(self, body: dict) -> dict:
        folder = Path(str(body.get("input", ""))).expanduser()
        if not folder.is_dir():
            raise ValueError("المجلد غير موجود")
        with self.lock:
            if self.status == "running":
                raise ValueError("هناك فحص يعمل الآن")
            self.reset()
            self.status = "running"
            self.input_dir = folder.resolve()
            self.out_dir = default_out_dir(self.input_dir)
            self.started = time.monotonic()
            for key in ("recursive", "local_ai", "vision"):
                self.settings[key] = bool(body.get(key))
            app_settings.remember_folder(self.settings, str(self.input_dir))
            app_settings.save(self.settings)
        threading.Thread(target=self._run, args=(body,), daemon=True).start()
        return {"ok": True}

    def _on_progress(self, event: ProgressEvent) -> None:
        with self.lock:
            self.stage, self.done, self.total, self.current = event.stage, event.done, event.total, event.name
            if event.report is not None:
                self.partial[event.report.id] = event.report
                self.recent.append(event.report.id)
                del self.recent[:-36]

    def _run(self, body: dict) -> None:
        try:
            assert self.input_dir is not None and self.out_dir is not None
            result = analyse(
                self.input_dir, self.out_dir, self.config, vision=bool(body.get("vision")),
                local_ai=bool(body.get("local_ai")), recursive=bool(body.get("recursive")),
                progress=self._on_progress, cancel=self.cancel,
            )
            with self.lock:
                self.result = result
                self.status = "done"
        except Cancelled:
            with self.lock:
                self.status = "cancelled"
        except (ConfigError, CsvFormatError, ValueError, OSError) as e:
            with self.lock:
                self.status, self.error = "error", str(e)
        except Exception as e:  # show it in the app instead of dying silently in a thread
            traceback.print_exc()
            with self.lock:
                self.status, self.error = "error", f"{type(e).__name__}: {e}"

    def progress(self) -> dict:
        with self.lock:
            counts = {v.folder: 0 for v in Verdict}
            for report in self.partial.values():
                counts[report.verdict.folder] += 1  # type: ignore[attr-defined]
            if self.result is not None:
                counts = {v.folder: self.result.count(v) for v in Verdict}
            elapsed = time.monotonic() - self.started if self.started else 0
            return {
                "status": self.status, "error": self.error, "stage": self.stage, "done": self.done,
                "total": self.total, "current": self.current, "elapsed": elapsed, "counts": counts,
                "recent": [{"id": i, "verdict": r.verdict.folder, "thumb": bool(r.thumbnail),
                            "ext": Path(r.name).suffix.lstrip(".").upper()}
                           for i in self.recent if (r := self.partial.get(i)) is not None],
            }

    # --- results --------------------------------------------------------------------------

    def report_by_id(self, file_id: int):
        with self.lock:
            if self.result is not None and 0 <= file_id < len(self.result.reports):
                return self.result.reports[file_id]
            return self.partial.get(file_id)

    def results(self) -> dict:
        with self.lock:
            result = self.result
            if result is None:
                raise ValueError("لا توجد نتائج بعد")
            reasons: dict[tuple[str, int], dict] = {}
            for r in result.reports:
                for rule, level in {(f.rule, int(f.level)) for f in r.findings if f.level > Level.INFO}:
                    entry = reasons.setdefault((rule, level), {"rule": rule, "level": level, "count": 0, "message": ""})
                    entry["count"] += 1
                for f in r.findings:
                    key = (f.rule, int(f.level))
                    if key in reasons and not reasons[key]["message"]:
                        reasons[key]["message"] = f.message
                        reasons[key]["group"] = f.group
            cost = None
            price = PRICES.get(result.vision_model)
            if price and result.vision_calls:
                cost = (result.vision_input_tokens * price[0] + result.vision_output_tokens * price[1]) / 1_000_000
            return {
                "input": str(result.input_dir), "out": str(self.out_dir), "seconds": result.seconds,
                "jobs": result.jobs, "local_ai": result.local_ai, "vision": result.vision,
                "vision_model": result.vision_model, "vision_calls": result.vision_calls, "cost": cost,
                "csv": result.csv_path.name if result.csv_path else "", "csv_warnings": result.csv_warnings,
                "counts": {v.folder: result.count(v) for v in Verdict}, "applied": self.applied,
                "reasons": sorted(reasons.values(), key=lambda e: (-e["level"], -e["count"])),
                "groups": GROUPS, "files": [r.to_dict() for r in result.reports],
            }

    def override(self, body: dict) -> dict:
        report = self.report_by_id(int(body.get("id", -1)))
        if report is None or self.result is None:
            raise ValueError("ملف غير معروف")
        value = body.get("verdict")
        with self.lock:
            report.override = None if value in (None, "", "auto") else Verdict[str(value).upper()]
            if report.override == report.computed_verdict:
                report.override = None
            self.applied = None
            return {"id": report.id, "verdict": report.verdict.folder, "overridden": report.override is not None,
                    "counts": {v.folder: self.result.count(v) for v in Verdict}}

    def apply(self) -> dict:
        with self.lock:
            if self.result is None or self.out_dir is None:
                raise ValueError("لا توجد نتائج بعد")
            result, out_dir = self.result, self.out_dir
        report = publish(result, self.config, out_dir, copy=True)
        with self.lock:
            self.applied = {"out": str(out_dir), "report": str(report),
                            "counts": {v.folder: result.count(v) for v in Verdict}}
            return self.applied

    # --- settings -------------------------------------------------------------------------

    def state(self) -> dict:
        hw = hardware.detect()
        have = local_ai_available()
        price = PRICES.get(self.config.vision.model)
        per_100 = (VISION_TOKENS[0] * price[0] + VISION_TOKENS[1] * price[1]) / 10_000 if price else None
        return {
            "version": __version__, "hardware": hw.to_dict(),
            "local_ai": {"ocr": have["ocr"], "faces": have["faces"]},
            "vision": {"key": bool(os.environ.get("ANTHROPIC_API_KEY")), "model": self.config.vision.model,
                       "models": list(PRICES), "per_100": per_100,
                       "remembered": bool(self.settings.get("api_key"))},
            "options": {k: self.settings.get(k, k == "local_ai") for k in ("recursive", "local_ai", "vision")},
            "recent": [f for f in self.settings.get("recent", []) if Path(f).is_dir()],
            "thresholds": app_settings.thresholds(self.config), "defaults": app_settings.defaults(),
            "status": self.status,
        }

    def update_settings(self, body: dict) -> dict:
        with self.lock:
            if "thresholds" in body and isinstance(body["thresholds"], dict):
                app_settings.apply_thresholds(self.config, body["thresholds"])
                self.settings["thresholds"] = {k: v["value"] for k, v in app_settings.thresholds(self.config).items()}
            model = body.get("vision_model")
            if model in PRICES:
                self.config.vision.model = self.settings["vision_model"] = model
            key = str(body.get("api_key") or "").strip()
            if key:
                os.environ["ANTHROPIC_API_KEY"] = key
            if "remember" in body:
                if not body["remember"]:
                    self.settings.pop("api_key", None)
                elif key or os.environ.get("ANTHROPIC_API_KEY"):
                    self.settings["api_key"] = key or os.environ["ANTHROPIC_API_KEY"]
            app_settings.save(self.settings)
        return self.state()


def pick_folder(initial: str) -> str:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    try:
        out = subprocess.run([sys.executable, "-c", PICK_FOLDER, "اختر مجلد الصور", initial],
                             capture_output=True, timeout=600, env=env, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.decode("utf-8", "replace").strip()


def reveal(path: Path, select: bool = False) -> None:
    if sys.platform == "win32":
        if select:
            subprocess.Popen(["explorer", f"/select,{path}"])
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if select else ["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent if select else path)])


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "QualityGuard"

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - keep the console quiet
            pass

        # --- plumbing ---------------------------------------------------------------------

        def _local_host(self) -> bool:
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
            return host in ("127.0.0.1", "localhost", "[::1]")

        def _authorized(self, query: dict) -> bool:
            token = self.headers.get("X-QG-Token") or (query.get("t") or [""])[0]
            return secrets.compare_digest(token, app.token)

        def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, data, status: int = 200) -> None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8", {"Cache-Control": "no-store"})

        def _error(self, message: str, status: int = 400) -> None:
            self._json({"error": message}, status)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_000_000:
                raise ValueError("طلب كبير جداً")
            data = json.loads(self.rfile.read(length) or b"{}")
            return data if isinstance(data, dict) else {}

        def _static(self, rel: str) -> None:
            rel = rel or "index.html"
            target = UI
            for part in rel.split("/"):
                if part in ("", ".", ".."):
                    return self._error("غير موجود", 404)
                target = target.joinpath(part)
            if not target.is_file():
                return self._error("غير موجود", 404)
            ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
            if rel.endswith(".woff2"):
                ctype = "font/woff2"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            cache = "no-cache" if rel.endswith((".html", ".js", ".css")) else "max-age=86400"
            headers = {"Cache-Control": cache}
            if rel == "index.html":
                headers["Content-Security-Policy"] = (
                    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'")
            self._send(200, target.read_bytes(), ctype, headers)

        # --- routes -----------------------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_HEAD(self) -> None:  # noqa: N802
            self._handle("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._handle("POST")

        def _handle(self, method: str) -> None:
            if not self._local_host():
                return self._error("forbidden", 403)
            url = urlparse(self.path)
            query = parse_qs(url.query)
            path = url.path
            if not path.startswith("/api/"):
                if method != "GET":
                    return self._error("غير موجود", 404)
                return self._static(path.lstrip("/"))
            if not self._authorized(query):
                return self._error("unauthorized", 401)
            try:
                self._api(method, path[5:], query)
            except (ValueError, KeyError) as e:
                self._error(str(e) or "طلب غير صالح")
            except Exception as e:  # never kill the server thread
                traceback.print_exc()
                self._error(f"{type(e).__name__}: {e}", 500)

        def _api(self, method: str, route: str, query: dict) -> None:
            if method == "GET" and route == "state":
                return self._json(app.state())
            if method == "GET" and route == "progress":
                return self._json(app.progress())
            if method == "GET" and route == "results":
                return self._json(app.results())
            if method == "GET" and route.startswith(("thumb/", "file/")):
                kind, _, raw_id = route.partition("/")
                report = app.report_by_id(int(raw_id))
                if report is None:
                    return self._error("غير موجود", 404)
                if kind == "thumb":
                    if not report.thumbnail:
                        return self._error("لا توجد معاينة", 404)
                    return self._send(200, report.thumbnail, "image/jpeg", {"Cache-Control": "max-age=3600"})
                if report.kind not in FILE_TYPES:
                    return self._error("لا يمكن عرض هذا النوع", 415)
                data = Path(report.path).read_bytes()
                headers = {"Cache-Control": "max-age=3600", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"}
                return self._send(200, data, FILE_TYPES[report.kind], headers)
            if method != "POST":
                return self._error("غير موجود", 404)
            body = self._body()
            if route == "pick":
                return self._json({"path": pick_folder(str(body.get("initial") or ""))})
            if route == "scan":
                return self._json(app.start(body))
            if route == "cancel":
                app.cancel.set()
                return self._json({"ok": True})
            if route == "reset":
                with app.lock:
                    if app.status == "running":
                        raise ValueError("هناك فحص يعمل الآن")
                    app.reset()
                return self._json({"ok": True})
            if route == "override":
                return self._json(app.override(body))
            if route == "apply":
                return self._json(app.apply())
            if route == "settings":
                return self._json(app.update_settings(body))
            if route == "open":
                return self._json(self._open(body))
            return self._error("غير موجود", 404)

        def _open(self, body: dict) -> dict:
            what = body.get("what")
            if what == "file":
                report = app.report_by_id(int(body.get("id", -1)))
                if report is None:
                    raise ValueError("ملف غير معروف")
                reveal(Path(report.path), select=True)
            elif what == "input" and app.input_dir:
                reveal(app.input_dir)
            elif what == "out" and app.out_dir and app.out_dir.exists():
                reveal(app.out_dir)
            elif what == "report" and app.applied:
                webbrowser.open(Path(app.applied["report"]).as_uri())
            else:
                raise ValueError("لا يوجد ما يُفتح بعد")
            return {"ok": True}

    return Handler


def serve(config: Config, *, port: int = 0, open_browser: bool = True, config_from_file: bool = False) -> int:
    app = App(config, config_from_file)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_address[1]}/?t={app.token}"
    print("Quality Guard يعمل الآن على جهازك:")
    print(f"  {url}")
    print("أغلق هذه النافذة لإيقافه.")
    if open_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        app.cancel.set()
        server.server_close()
    return 0

