# Quality Guard

Pre-upload checker for Adobe Stock: sorts a folder of images into pass / review / reject. See README.md (Arabic).

- Checks: `pytest` and `ruff check src tests`. Run both before committing.
- Only Pillow and numpy at runtime; `anthropic` is optional (vision). Do not add scipy or OpenCV.
- `REJECT` is only for measured violations of a published Adobe rule. Heuristics and everything Claude reports
  visually go to `REVIEW`, so the reject pile stays trustworthy. `INFO` never changes the verdict.
- User-facing messages are Arabic; code, comments and identifiers are English.
- Thresholds live in `config.py`; regenerate `config.example.toml` from it when adding one.
- Tests build synthetic photos with `tests/imagegen.py`; there are no binary fixtures in the repo.
