# Quality Guard

Pre-upload checker for Adobe Stock: sorts a folder of images into pass / review / reject, with a local web app.
See README.md (Arabic).

- Checks: `pytest` and `ruff check src tests`. Run both before committing. `tests/test_local_ai.py` runs the real
  OCR and face models when `.[gpu]` is installed and skips otherwise.
- Core runtime is Pillow and numpy only. `anthropic` (vision) and EasyOCR/OpenCV (`.[gpu]`, local AI) are optional
  and imported lazily; the tool must keep working without them.
- `REJECT` is only for measured violations of a published Adobe rule. Heuristics, OCR/face detections and everything
  Claude reports go to `REVIEW`, so the reject pile stays trustworthy. `INFO` never changes the verdict.
- User-facing messages are Arabic; code, comments and identifiers are English. In the UI, wrap numbers and
  Latin runs inside Arabic text with `iso()` so they keep their order.
- Thresholds live in `config.py`; regenerate `config.example.toml` from it when adding one. The app's sliders are
  the `TUNABLE` list in `settings.py`.
- The app (`server.py`, `ui/`) binds 127.0.0.1 only and every `/api/` call needs the per-run token. Keep it that
  way; `ui/` has no build step and no inline scripts (the page has a CSP).
- Tests build synthetic photos with `tests/imagegen.py`; there are no binary fixtures in the repo.
