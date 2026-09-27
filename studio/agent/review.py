"""The review page, on this computer only (http://127.0.0.1:8765): where the agent waits
for a person, as the training lab asks.

- Voice: blind. Letters, shuffled, no file names or numbers; keep 3, then the page makes
  you wait 10 minutes (the plan's pause), shuffles the 3 again and asks for one.
- Dub reference: listen next to the English reference; similarity and WER are shown.
- Mother image: pick one. Rounds 1 and 2: tick the pictures to keep (12-18, then 25-40);
  round 2 shows the dataset mix as you tick.
- LoRA: the evaluation grid of every saved epoch; pick one and count the pictures drawn
  right (28 of 32 is the plan's bar).
Every form carries a token made at start, so another web page cannot answer for you."""
from __future__ import annotations

import html
import json
import mimetypes
import random
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from ..lora import check_mix
from .plan import Task
from .store import Store


class Invalid(ValueError):
    """The answer does not fit the question (wrong count, unknown item, too early)."""


def _seed_of(rel: str) -> int:
    m = re.search(r"cand_(\d+)", rel)
    return int(m.group(1)) if m else -1


def resolve(store: Store, task_id: str, form: dict[str, list[str]], clock=time.time) -> str:
    """Applies an answer. Returns a message; raises Invalid when it cannot be taken."""
    row = store.get(task_id)
    if row["status"] != "waiting":
        raise Invalid(f"{task_id} is not waiting for a choice ({row['status']})")
    r = row["review"]
    picks = form.get("pick", [])
    kind = r["kind"]
    if kind == "blind_audio":
        if r["stage"] == 1:
            if len(set(picks)) != r["keep"] or any(p not in r["labels"] for p in picks):
                raise Invalid(f"keep exactly {r['keep']}")
            short = [r["labels"][p] for p in dict.fromkeys(picks)]
            random.Random(secrets.randbits(64)).shuffle(short)
            store.set(task_id, review={**r, "stage": 2, "shortlist": {str(i + 1): p for i, p in enumerate(short)},
                                       "open_at": clock() + r["pause_s"]})
            store.event(task_id, "info", "3 voices kept; the last choice opens in 10 minutes")
            return "rest your ears for 10 minutes, then choose one of the three"
        if clock() < r["open_at"]:
            raise Invalid(f"{int(r['open_at'] - clock()) // 60 + 1} more minutes: listen again with rested ears")
        if len(picks) != 1 or picks[0] not in r["shortlist"]:
            raise Invalid("choose one")
        chosen = r["shortlist"][picks[0]]
        store.finish(task_id, {"chosen": chosen, "seed": _seed_of(chosen), "shortlist": list(r["shortlist"].values())})
    elif kind in ("audio_pick", "image_pick"):
        item = _one(r["items"], picks)
        store.finish(task_id, {"chosen": item["path"]})
    elif kind == "image_select":
        idx = sorted({int(p) for p in picks if p.isdigit() and int(p) < len(r["items"])})
        if not r["min"] <= len(idx) <= r["max"]:
            raise Invalid(f"keep {r['min']}-{r['max']} pictures; {len(idx)} are ticked")
        chosen = [r["items"][i] for i in idx]
        warnings = check_mix([i["shot"] for i in chosen], [i["background"] for i in chosen], r["round"]) if r["round"] == 2 else []
        store.finish(task_id, {"selected": chosen, "mix_warnings": warnings})
    elif kind == "eval_pick":
        grid = _one(r["grids"], picks)
        try:
            correct = int(form.get("correct", [""])[0])
        except ValueError as e:
            raise Invalid("count the pictures drawn right (0-32)") from e
        if not 0 <= correct <= r["cells"]:
            raise Invalid(f"between 0 and {r['cells']}")
        store.finish(task_id, {"epoch": grid["epoch"], "correct": correct})
    else:
        raise Invalid(f"unknown review {kind}")
    store.event(task_id, "info", "chosen by you")
    return "saved"


def _one(items: list[dict], picks: list[str]) -> dict:
    if len(picks) != 1 or not picks[0].isdigit() or int(picks[0]) >= len(items):
        raise Invalid("choose one")
    return items[int(picks[0])]


# ---------------------------------------------------------------- pages
CSS = """
:root{--bg:#fffdf7;--fg:#222;--muted:#666;--card:#fff;--line:#e6e0d4;--accent:#e0671f}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a17;--fg:#eee;--muted:#aaa;--card:#26241f;--line:#3a372f;--accent:#ff9a4d}}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0 auto;max-width:1100px;padding:16px}
a{color:var(--accent)} h1{font-size:1.4rem} .muted{color:var(--muted)} .card{background:var(--card);border:1px solid var(--line);
border-radius:10px;padding:12px;margin:10px 0} table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid var(--line);
padding:6px;text-align:start} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.grid label{display:block;border:2px solid var(--line);border-radius:8px;padding:4px;cursor:pointer} .grid img{width:100%;border-radius:6px}
.grid input:checked+img{outline:4px solid var(--accent)} button{background:var(--accent);color:#fff;border:0;border-radius:8px;
padding:10px 18px;font-size:1rem;cursor:pointer} .err{color:#c0392b} pre{white-space:pre-wrap;direction:ltr;text-align:left}
audio{width:100%} .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
"""
STATUS_AR = {"pending": "في الانتظار", "running": "يعمل", "waiting": "بانتظارك", "done": "تم", "skipped": "تُخطّي",
             "failed": "فشل", "blocked": "يحتاجك"}


def page(title: str, body: str) -> bytes:
    return (f'<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>'
            f"<style>{CSS}</style></head><body>{body}</body></html>").encode()


class App:
    def __init__(self, root: Path, store: Store, plan: list[Task], names: dict[str, str], clock=time.time, retry=None):
        self.root, self.store, self.plan, self.names, self.clock, self.retry = root, store, plan, names, clock, retry
        self.token = secrets.token_urlsafe(16)

    def form(self, action: str, inner: str, button: str) -> str:
        return (f'<form method="post" action="{html.escape(action)}"><input type="hidden" name="token" value="{self.token}">'
                f"{inner}<p><button>{html.escape(button)}</button></p></form>")

    def index(self) -> bytes:
        rows = self.store.all()
        prog: dict[str, dict[str, list[int]]] = {}
        for t in self.plan:
            part = t.id.split("/")[1]
            c = prog.setdefault(t.character, {}).setdefault(part, [0, 0])
            c[1] += 1
            c[0] += rows[t.id]["status"] in ("done", "skipped")
        table = "".join(f"<tr><td>{html.escape(self.names.get(ch, ch))}</td><td>{p.get('voice', [0, 0])[0]}/{p.get('voice', [0, 0])[1]}</td>"
                        f"<td>{p.get('look', [0, 0])[0]}/{p.get('look', [0, 0])[1]}</td></tr>" for ch, p in prog.items())
        out = [f"<h1>وكيل التدريب · Kiko &amp; Friends</h1><div class='card'><table><tr><th>الشخصية</th><th>الصوت</th>"
               f"<th>الشكل</th></tr>{table}</table></div>"]

        def section(title, status, extra=lambda r: ""):
            items = [r for r in rows.values() if r["status"] == status]
            if items:
                out.append(f"<h2>{title}</h2>" + "".join(
                    f"<div class='card'><b>{html.escape(r['id'])}</b> {extra(r)}</div>" for r in items))

        section("بانتظار اختيارك", "waiting", lambda r: f" — <a href='/review/{r['id']}'>افتح</a>")
        section("متوقفة وتحتاج منك شيئًا", "blocked",
                lambda r: f"<p>{html.escape(r['error'] or '')}</p>" + self.form(f"/retry/{r['id']}", "", "أعد المحاولة"))
        section("فشلت", "failed",
                lambda r: f"<pre>{html.escape((r['error'] or '')[-1500:])}</pre>" + self.form(f"/retry/{r['id']}", "", "أعد المحاولة"))
        section("تعمل الآن", "running", lambda r: f"<span class='muted'>GPU {r['card']}</span>" if r["card"] is not None else "")
        ev = self.store.events(self.clock() - 86400)[-30:]
        if ev:
            out.append("<h2>آخر الأحداث</h2><div class='card'><pre>" + html.escape("\n".join(
                f"{time.strftime('%H:%M', time.localtime(e['ts']))} {e['level']:9} {e['task'] or ''} {e['message']}"
                for e in reversed(ev))) + "</pre></div>")
        return page("وكيل التدريب", "".join(out))

    def review(self, task_id: str, message: str = "", error: str = "") -> bytes:
        row = self.store.get(task_id)
        head = f"<p><a href='/'>← الرئيسية</a></p><h1>{html.escape(task_id)}</h1>"
        if message:
            head += f"<p class='card'>{html.escape(message)}</p>"
        if error:
            head += f"<p class='err'>{html.escape(error)}</p>"
        if row["status"] != "waiting":
            return page(task_id, head + f"<p>{STATUS_AR.get(row['status'], row['status'])}</p>")
        r = row["review"]
        action = f"/review/{task_id}"
        kind = r["kind"]
        if kind == "blind_audio" and r["stage"] == 1:
            items = "".join(f"<div class='card row'><label><input type='checkbox' name='pick' value='{k}'> {k}</label>"
                            f"<audio controls preload='none' src='/blind/{task_id}/{k}'></audio></div>" for k in r["labels"])
            note = f"<p class='muted'>{r['hidden']} مرشحًا لم يُفهم كلامها أُخفيت.</p>" if r.get("hidden") else ""
            body = (f"<p>استمع دون أن تعرف أرقامها، واحتفظ بـ{r['keep']}. المعيار: هل تتحمّله طفلة في الرابعة لسبع دقائق؟</p>"
                    f"{note}" + self.form(action, items, "احتفظ بهذه الثلاثة"))
        elif kind == "blind_audio":
            wait = r["open_at"] - self.clock()
            if wait > 0:
                body = f"<p>استرح. الاختيار الأخير يُفتح بعد {int(wait) // 60 + 1} دقيقة، بأذن مرتاحة.</p>"
            else:
                items = "".join(f"<div class='card row'><label><input type='radio' name='pick' value='{k}'> {k}</label>"
                                f"<audio controls preload='none' src='/blind/{task_id}/{k}'></audio></div>" for k in r["shortlist"])
                body = "<p>الثلاثة من جديد، بترتيب آخر. اختر واحدًا.</p>" + self.form(action, items, "هذا هو الصوت")
        elif kind == "audio_pick":
            ref = f"<div class='card'>المرجع الإنجليزي<audio controls src='/file/{r['reference']}'></audio></div>"
            items = "".join(f"<div class='card row'><label><input type='radio' name='pick' value='{i}'> {i + 1}</label>"
                            f"<audio controls preload='none' src='/file/{it['path']}'></audio>"
                            f"<span class='muted'>تشابه {it['similarity']} · أخطاء الكلمات {it['wer']}</span></div>"
                            for i, it in enumerate(r["items"]))
            body = f"<p>مرجع {html.escape(r['lang'])}: اختر الأقرب لصوت الشخصية وبأوضح لكنة.</p>{ref}" + self.form(action, items, "اعتمد")
        elif kind == "image_pick":
            items = "".join(f"<label><input type='radio' name='pick' value='{i}' hidden><img src='/file/{it['path']}'>"
                            f"<span class='muted'>ألوان {it['score']}</span></label>" for i, it in enumerate(r["items"]))
            body = ("<p>الصورة الأم: كل ما بعدها يُقاس عليها. الزي والألوان والعلامة المميزة صحيحة.</p>"
                    + self.form(action, f"<div class='grid'>{items}</div>", "هذه هي الصورة الأم"))
        elif kind == "image_select":
            items = "".join(f"<label><input type='checkbox' name='pick' value='{i}' hidden data-shot='{it['shot']}' "
                            f"data-bg='{it['background']}'><img src='/file/{it['path']}' loading='lazy'>"
                            f"<span class='muted'>{html.escape(it['shot'])} · {html.escape(it['background'])} · {it['score']}</span></label>"
                            for i, it in enumerate(r["items"]))
            counter = ("<p id='count' class='card'></p><script>const b=[...document.querySelectorAll('input[name=pick]')];"
                       "function u(){const c=b.filter(x=>x.checked);const t={};c.forEach(x=>{t[x.dataset.shot]=(t[x.dataset.shot]||0)+1});"
                       "const w=c.filter(x=>x.dataset.bg=='white').length;document.getElementById('count').textContent="
                       f"c.length+' من {r['min']}–{r['max']} · '+Object.entries(t).map(([k,v])=>k+': '+v).join(' · ')+' · بيضاء: '+w}}"
                       "b.forEach(x=>x.addEventListener('change',u));u()</script>")
            aim = "الهدف: 40% جسم كامل، 30% نصف جسم، 20% وجه قريب، 10% مع آخرين؛ ونصفها بخلفية بيضاء." if r["round"] == 2 else \
                "أبقِ الصحيح فقط: الزي والألوان صحيحة، العلامة المميزة موجودة، لا أصابع زائدة. الانتقاء أهم من العدد."
            body = (f"<p>الجولة {r['round']}: احتفظ بـ{r['min']}–{r['max']} صورة. {aim}</p>"
                    + self.form(action, f"<div class='grid'>{items}</div>{counter}", "احفظ الاختيار"))
        elif kind == "eval_pick":
            items = "".join(f"<div class='card'><label><input type='radio' name='pick' value='{i}'> {html.escape(Path(g['epoch']).name)}"
                            f"</label><img style='width:100%' src='/file/{g['grid']}' loading='lazy'></div>" for i, g in enumerate(r["grids"]))
            inner = items + (f"<p>كم صورة من {r['cells']} رُسمت فيها الشخصية صحيحة وأطاعت البرومبت؟ "
                             f"<input name='correct' type='number' min='0' max='{r['cells']}' required> (المطلوب {r['min_correct']})</p>")
            body = "<p>اختر نقطة الحفظ التي ترسم الشخصية صحيحة وتطيع الخلفية والوضعية، لا التي تكرر وضعية واحدة.</p>" + \
                self.form(action, inner, "اعتمد")
        else:
            body = "<p>?</p>"
        return page(task_id, head + body)

    def file_for(self, path: str) -> Path | None:
        p = (self.root / unquote(path)).resolve()
        for base in ("training", "assets"):
            b = (self.root / base).resolve()
            if p.is_relative_to(b) and p.is_file():
                return p
        return None

    def blind_file(self, task_id: str, label: str) -> Path | None:
        r = self.store.get(task_id)["review"] or {}
        rel = (r.get("shortlist") if r.get("stage") == 2 else r.get("labels") or {}).get(label)
        return self.file_for(rel) if rel else None


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def send(self, body: bytes, ctype="text/html; charset=utf-8", code=200):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def send_file(self, p: Path | None):
            if not p:
                return self.send(b"not found", "text/plain", 404)
            self.send(p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream")

        def do_GET(self):
            path = urlparse(self.path).path
            try:
                if path == "/":
                    return self.send(app.index())
                if path.startswith("/review/"):
                    return self.send(app.review(path[len("/review/"):]))
                if path.startswith("/file/"):
                    return self.send_file(app.file_for(path[len("/file/"):]))
                if path.startswith("/blind/"):
                    task_id, _, label = path[len("/blind/"):].rpartition("/")
                    return self.send_file(app.blind_file(task_id, label))
                if path == "/state.json":
                    return self.send(json.dumps({k: v["status"] for k, v in app.store.all().items()}).encode(), "application/json")
            except KeyError:
                pass
            self.send(b"not found", "text/plain", 404)

        def do_POST(self):
            path = urlparse(self.path).path
            n = int(self.headers.get("Content-Length") or 0)
            form = parse_qs(self.rfile.read(n).decode())
            if form.get("token", [""])[0] != app.token:
                return self.send(b"bad token: reload the page", "text/plain", 403)
            try:
                if path.startswith("/review/"):
                    task_id = path[len("/review/"):]
                    try:
                        msg = resolve(app.store, task_id, form, app.clock)
                    except Invalid as e:
                        return self.send(app.review(task_id, error=str(e)), code=400)
                    return self.send(app.review(task_id, message=msg))
                if path.startswith("/retry/") and app.retry:
                    app.retry(path[len("/retry/"):])
                    return self.send(app.index())
            except KeyError:
                pass
            self.send(b"not found", "text/plain", 404)

    return Handler


def serve(app: App, port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    """Starts the page in a background thread; returns the server (server_address has the port)."""
    srv = ThreadingHTTPServer((host, port), make_handler(app))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv
