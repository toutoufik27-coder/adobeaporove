"""The saved report (Arabic, right-to-left, opens in any browser) plus CSV and JSON exports.

Thumbnails are written next to it in thumbs/ and the fonts in assets/, so a report of thousands of
images stays small and looks the same offline.
"""

from __future__ import annotations

import csv
import json
import shutil
from dataclasses import asdict
from datetime import datetime
from html import escape
from importlib import resources
from pathlib import Path

from .config import Config
from .findings import GROUPS, FileReport, Level, Verdict
from .scanner import ScanResult

# Approximate list prices per million tokens (input, output) for cost lines; see anthropic.com/pricing.
PRICES = {
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

UNCHECKED_WITHOUT_VISION = (
    "عيوب الأيدي والأجسام، الشعارات غير النصية، الأعمال الفنية والمعالم، المحتوى المحظور، والقيمة التجارية"
)
LEVEL_CLASS = {Level.INFO: "info", Level.REVIEW: "review", Level.REJECT: "reject"}
LEVEL_LABEL = {Level.INFO: "ملاحظة", Level.REVIEW: "مراجعة", Level.REJECT: "رفض"}
ORDER = {Verdict.REVIEW: 0, Verdict.REJECT: 1, Verdict.PASS: 2}
LRI, PDI = "⁦", "⁩"

CSS = """
:root{--bg:#090c13;--surface:#141a28;--surface-2:#1a2133;--surface-3:#232b40;--line:rgba(148,163,184,.14);--ink:#eef2f8;--ink-2:#c5cedc;
--muted:#8a96aa;--accent-2:#3dd6f5;--grad:linear-gradient(135deg,#9b7cff,#5b9dff 52%,#3dd6f5);--pass:#3ddc97;--review:#ffc857;--reject:#ff6b6b;
--info:#8a96aa;--pass-bg:rgba(61,220,151,.13);--review-bg:rgba(255,200,87,.13);--reject-bg:rgba(255,107,107,.13);--info-bg:rgba(138,150,170,.13);
--body:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;--display:"Reem Kufi","IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;
--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f3f5fa;--surface:#fff;--surface-2:#eef1f7;--surface-3:#e3e8f2;--line:rgba(15,23,42,.1);
--ink:#0f172a;--ink-2:#334155;--muted:#5d6a7e;--accent-2:#0ea5c6;--pass:#0c9a6a;--review:#b7740a;--reject:#d83a3a;--info:#5d6a7e;
--pass-bg:rgba(12,154,106,.1);--review-bg:rgba(183,116,10,.1);--reject-bg:rgba(216,58,58,.09);--info-bg:rgba(93,106,126,.1);color-scheme:light}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.65}
.wrap{max-width:1320px;margin-inline:auto;padding:32px 16px 64px;display:grid;gap:22px}
h1,h2{font-family:var(--display);margin:0;line-height:1.25}h1{font-size:clamp(1.7rem,4vw,2.5rem)}h2{font-size:1.15rem}p{margin:0}
.muted{color:var(--muted)}.ltr{direction:ltr;unicode-bidi:isolate;font-family:var(--mono);font-size:.84em;overflow-wrap:anywhere}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.86rem}.brand b{color:var(--ink);font-family:var(--display);font-size:1rem}
.grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
header{display:grid;gap:8px;padding-bottom:18px;border-bottom:1px solid var(--line)}
.facts{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--muted);font-size:.84rem}
.pass{--c:var(--pass);--c-bg:var(--pass-bg)}.review{--c:var(--review);--c-bg:var(--review-bg)}.reject{--c:var(--reject);--c-bg:var(--reject-bg)}.info{--c:var(--info);--c-bg:var(--info-bg)}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 18px;position:relative;overflow:hidden}
.tile::before{content:"";position:absolute;inset:0 0 auto;height:3px;background:var(--c)}
.tile b{display:block;font-family:var(--display);font-size:2.2rem;line-height:1.1;color:var(--c)}.tile span{color:var(--ink-2);font-size:.9rem}
.bar{height:6px;border-radius:99px;background:var(--surface-3);margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;background:var(--c)}
.note{display:flex;gap:10px;padding:12px 16px;border-radius:14px;background:var(--c-bg);border:1px solid var(--line);font-size:.9rem}
.cols{display:grid;grid-template-columns:280px minmax(0,1fr);gap:18px;align-items:start}
.reasons{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px;position:sticky;top:12px}
.reasons ol{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:10px}.reasons li{display:grid;grid-template-columns:1fr auto;gap:4px 10px;font-size:.85rem}
.reasons li b{color:var(--c);font-family:var(--display)}.reasons .bar{grid-column:1/-1;margin:0;height:4px}
.bar-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.chip{border:1px solid var(--line);background:var(--surface-2);color:var(--muted);border-radius:10px;padding:6px 12px;font:inherit;font-size:.86rem;cursor:pointer}
.chip[aria-pressed=true]{background:var(--surface);color:var(--ink);box-shadow:0 0 0 1px var(--c,var(--accent-2)) inset}
input[type=search]{font:inherit;flex:1;min-width:180px;max-width:340px;padding:7px 12px;border-radius:10px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;position:relative}
.card::after{content:"";position:absolute;inset:auto 0 0;height:3px;background:var(--c)}
.thumb{aspect-ratio:4/3;background:var(--surface-2);display:grid;place-items:center;position:relative}
.thumb img{width:100%;height:100%;object-fit:cover}.thumb .ext{font-family:var(--mono);color:var(--muted);font-size:1.2rem}
.pill{position:absolute;top:10px;right:10px;font-size:.74rem;font-weight:700;padding:3px 10px;border-radius:99px;background:var(--surface);color:var(--c);border:1px solid var(--c)}
.man{position:absolute;top:10px;left:10px;font-size:.7rem;padding:3px 9px;border-radius:99px;background:#7c5cff;color:#fff}
.body{padding:12px 14px 16px;display:grid;gap:8px}.name{font-weight:600;direction:ltr;text-align:right;overflow-wrap:anywhere;font-size:.9rem}
.sub{font-size:.78rem;color:var(--muted)}
ul.f{list-style:none;margin:0;padding:0;display:grid;gap:7px}ul.f li{display:grid;grid-template-columns:4px 1fr;gap:10px;font-size:.86rem;line-height:1.5}
ul.f li::before{content:"";border-radius:4px;background:var(--c)}ul.f small{display:block;color:var(--muted);font-size:.78rem;overflow-wrap:anywhere}
.g{font-size:.72rem;color:var(--muted)}.ok{color:var(--muted);font-size:.86rem}
details{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 16px}summary{cursor:pointer;font-weight:600}
pre{direction:ltr;text-align:left;font-family:var(--mono);font-size:.78rem;white-space:pre-wrap}
[hidden]{display:none!important}
@media (max-width:900px){.cols{grid-template-columns:minmax(0,1fr)}.reasons{position:static}}
@media (max-width:620px){.tiles{grid-template-columns:1fr}.grid{grid-template-columns:minmax(0,1fr)}}
@media print{.bar-row,details{display:none}.card{break-inside:avoid}}
"""

SCRIPT = """
const chips=[...document.querySelectorAll('.chip')],cards=[...document.querySelectorAll('.card')],q=document.getElementById('q');let pile='all';
function apply(){const t=q.value.trim().toLowerCase();let n=0;for(const c of cards){const s=(pile==='all'||c.dataset.v===pile)&&(!t||c.dataset.s.includes(t));c.hidden=!s;if(s)n++}document.getElementById('shown').textContent=n}
chips.forEach(ch=>ch.addEventListener('click',()=>{pile=ch.dataset.p;chips.forEach(x=>x.setAttribute('aria-pressed',x===ch));apply()}));q.addEventListener('input',apply);apply();
"""


def _iso(text: object) -> str:
    return f"{LRI}{text}{PDI}"


def _duration(seconds: float) -> str:
    """Arabic counted noun: ثانية، ثانيتين، 3 ثوانٍ، 11 ثانية."""
    minutes = seconds >= 90
    n = max(1, round(seconds / 60 if minutes else seconds))
    one, two, few = ("دقيقة", "دقيقتين", "دقائق") if minutes else ("ثانية", "ثانيتين", "ثوانٍ")
    if n == 1:
        return one
    if n == 2:
        return two
    return f"{_iso(n)} {few if n <= 10 else one}"


def _thumb_name(r: FileReport) -> str:
    return f"thumbs/{r.id:05d}.jpg"


def _write_assets(result: ScanResult, out_dir: Path) -> None:
    thumbs = out_dir / "thumbs"
    if thumbs.exists():
        shutil.rmtree(thumbs)
    thumbs.mkdir(parents=True)
    for r in result.reports:
        if r.thumbnail:
            (out_dir / _thumb_name(r)).write_bytes(r.thumbnail)
    assets = out_dir / "assets"
    (assets / "fonts").mkdir(parents=True, exist_ok=True)
    ui = resources.files("quality_guard").joinpath("ui")
    (assets / "fonts.css").write_bytes(ui.joinpath("fonts.css").read_bytes())
    for font in ui.joinpath("fonts").iterdir():
        if font.name.endswith(".woff2"):
            (assets / "fonts" / font.name).write_bytes(font.read_bytes())


def _card(r: FileReport) -> str:
    v = r.verdict
    if r.thumbnail:
        thumb = f'<img src="{_thumb_name(r)}" alt="" loading="lazy">'
    else:
        thumb = f'<span class="ext">{escape(Path(r.name).suffix.lstrip(".").upper() or r.kind.upper())}</span>'
    facts = []
    if r.width:
        facts.append(_iso(f"{r.width}×{r.height}"))
        facts.append(_iso(f"{r.megapixels:.1f} MP"))
    facts.append(_iso(f"{r.size_bytes / 1_000_000:.1f} MB"))
    if "sharpness" in r.metrics:
        facts.append(f"حدة {_iso(format(r.metrics['sharpness'], '.2f'))}")
    if r.metadata.ai_generated:
        facts.append("AI")
    items = []
    for f in sorted(r.findings, key=lambda f: -f.level):
        detail = f"<small>{escape(f.detail)}</small>" if f.detail else ""
        items.append(
            f'<li class="{LEVEL_CLASS[f.level]}"><div><span class="g">{LEVEL_LABEL[f.level]} · '
            f"{escape(GROUPS.get(f.group, f.group))}</span><br>{escape(f.message)}{detail}</div></li>"
        )
    body = f'<ul class="f">{"".join(items)}</ul>' if items else '<p class="ok">لم تظهر أي مشكلة في الفحوص.</p>'
    search = escape(" ".join([r.name.lower(), *(f.message.lower() for f in r.findings)]))
    manual = '<span class="man">يدوي</span>' if r.override is not None else ""
    return (
        f'<article class="card {v.folder}" data-v="{v.folder}" data-s="{search}">'
        f'<div class="thumb">{thumb}<span class="pill">{v.label}</span>{manual}</div><div class="body">'
        f'<p class="name">{escape(r.name)}</p><p class="sub">{" · ".join(facts)}</p>{body}</div></article>'
    )


def _reasons(reports: list[FileReport]) -> str:
    counts: dict[tuple[str, int], list] = {}
    for r in reports:
        for f in r.findings:
            if f.level == Level.INFO:
                continue
            entry = counts.setdefault((f.rule, int(f.level)), [f.message, set()])
            entry[1].add(r.id)
    if not counts:
        return '<p class="muted">لا توجد أسباب رفض أو مراجعة.</p>'
    rows = sorted(((k, v[0], len(v[1])) for k, v in counts.items()), key=lambda x: (-x[0][1], -x[2]))[:14]
    top = max(n for *_, n in rows)
    return "<ol>" + "".join(
        f'<li class="{LEVEL_CLASS[Level(level)]}"><span>{escape(msg)}</span><b>{n}</b>'
        f'<span class="bar"><i style="width:{n / top * 100:.0f}%"></i></span></li>'
        for (_, level), msg, n in rows
    ) + "</ol>"


def _notes(result: ScanResult) -> str:
    notes = []
    if result.vision == "on":
        price = PRICES.get(result.vision_model)
        cost = ""
        if price and result.vision_calls:
            usd = (result.vision_input_tokens * price[0] + result.vision_output_tokens * price[1]) / 1_000_000
            cost = f" · التكلفة التقديرية {_iso(f'${usd:.2f}')}"
        notes.append(("pass", f"راجع Claude الصور بصرياً ({escape(result.vision_model)}، {result.vision_calls} طلب{cost}). "
                              "نتائجه تذهب إلى المراجعة فقط لأنه قد يخطئ."))
    else:
        why = "" if result.vision == "off" else f" ({escape(result.vision)})"
        notes.append(("review", f"لم تعمل مراجعة Claude البصرية{why}، فهذه لم تُفحص إلا بعينك: {UNCHECKED_WITHOUT_VISION}."))
    if result.local_ai.startswith("on"):
        notes.append(("info", f"الذكاء المحلي: {escape(result.local_ai[4:])}"))
    for warning in result.csv_warnings:
        notes.append(("review", f"CSV: {escape(warning)}"))
    notes.append(("info", "<b>مرفوض</b>: مخالفة مقيسة لقاعدة منشورة. <b>مراجعة</b>: خطر يحتاج نظرك. "
                          "<b>مقبول</b>: لم تظهر مشكلة، لكن Adobe قد يرفض لأسباب ذوقية لا تُقاس مسبقاً."))
    return "".join(f'<div class="note {c}"><p>{t}</p></div>' for c, t in notes)


def write_html(result: ScanResult, config: Config, path: Path) -> None:
    out_dir = path.parent
    _write_assets(result, out_dir)
    reports = sorted(result.reports, key=lambda r: (ORDER[r.verdict], r.name.lower()))
    total = max(1, len(reports))
    tiles = "".join(
        f'<div class="tile {v.folder}"><b>{result.count(v)}</b><span>{label}</span>'
        f'<div class="bar"><i style="width:{result.count(v) / total * 100:.0f}%"></i></div></div>'
        for v, label in ((Verdict.PASS, "مقبول، جاهز للرفع"), (Verdict.REVIEW, "يحتاج نظرك"), (Verdict.REJECT, "مرفوض"))
    )
    chips = "".join(
        f'<button class="chip {cls}" data-p="{cls}" aria-pressed="{str(cls == "all").lower()}">{label}</button>'
        for cls, label in (("all", "الكل"), ("review", "مراجعة"), ("reject", "مرفوض"), ("pass", "مقبول"))
    )
    facts = [f'<span class="ltr">{escape(str(result.input_dir))}</span>', datetime.now().strftime("%Y-%m-%d %H:%M"),
             f"في {_duration(result.seconds)}", f"{_iso(result.jobs)} صور تُفحص معاً"]
    if result.csv_path:
        facts.append(f'البيانات من <span class="ltr">{escape(result.csv_path.name)}</span>')
    settings = escape(json.dumps({k: v for k, v in asdict(config).items() if k != "base_dir"}, ensure_ascii=False, indent=2))
    pct = round(result.count(Verdict.PASS) / total * 100)
    html = f"""<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تقرير Quality Guard</title><link rel="stylesheet" href="assets/fonts.css"><style>{CSS}</style></head><body><div class="wrap">
<header><p class="brand"><b>Quality Guard</b> · فحص قبل الرفع إلى Adobe Stock</p>
<h1>{len(reports)} ملف · <span class="grad">{_iso(f"{pct}%")}</span> جاهزة للرفع</h1><p class="facts">{"".join(f"<span>{f}</span>" for f in facts)}</p></header>
<section class="tiles">{tiles}</section>
{_notes(result)}
<div class="cols"><aside class="reasons"><h2>أكثر الأسباب</h2>{_reasons(reports)}</aside>
<section><div class="bar-row">{chips}<input type="search" id="q" placeholder="ابحث باسم الملف أو السبب" aria-label="بحث">
<span class="muted">المعروض: <b id="shown">{len(reports)}</b></span></div>
<div class="grid">{"".join(_card(r) for r in reports)}</div></section></div>
<details><summary>الإعدادات المستخدمة في هذا الفحص</summary><pre>{settings}</pre></details>
</div><script>{SCRIPT}</script></body></html>"""
    path.write_text(html, encoding="utf-8")


def write_csv(result: ScanResult, path: Path) -> None:
    # utf-8-sig so Excel on Windows shows Arabic correctly.
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["file", "verdict", "الحكم", "overridden", "width", "height", "megapixels", "sharpness", "noise",
                    "jpeg_quality", "faces", "ai_generated", "vision_checked", "local_checked", "reasons", "rules"])
        for r in result.reports:
            m = r.metrics
            problems = [f for f in r.findings if f.level > Level.INFO]
            w.writerow([
                r.name, r.verdict.folder, r.verdict.label, "yes" if r.override is not None else "",
                r.width or "", r.height or "", f"{r.megapixels:.1f}" if r.width else "",
                f"{m['sharpness']:.2f}" if "sharpness" in m else "",
                f"{m['noise']:.1f}" if "noise" in m else "",
                int(m["jpeg_quality"]) if "jpeg_quality" in m else "",
                int(m["faces"]) if "faces" in m else "",
                "yes" if r.metadata.ai_generated else "", "yes" if r.vision_checked else "",
                "yes" if r.local_checked else "",
                " | ".join(f.message + (f" ({f.detail})" if f.detail else "") for f in problems),
                " ".join(f.rule for f in problems),
            ])


def write_json(result: ScanResult, path: Path) -> None:
    data = {
        "input": str(result.input_dir),
        "counts": {v.folder: result.count(v) for v in Verdict},
        "vision": result.vision,
        "vision_model": result.vision_model,
        "local_ai": result.local_ai,
        "csv_warnings": result.csv_warnings,
        "files": [r.to_dict() for r in result.reports],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
