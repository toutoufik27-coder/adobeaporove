"""The HTML report (Arabic, right-to-left, one self-contained file) plus CSV and JSON exports."""

from __future__ import annotations

import base64
import csv
import json
from collections import Counter
from dataclasses import asdict
from datetime import datetime
from html import escape
from pathlib import Path

from .config import Config
from .findings import GROUPS, FileReport, Level, Verdict
from .scanner import ScanResult

# Approximate list prices per million tokens (input, output) for the cost line; see anthropic.com/pricing.
PRICES = {
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

UNCHECKED_WITHOUT_VISION = (
    "عيوب الذكاء الاصطناعي (الأيدي، النصوص الذائبة)، الشعارات والعلامات التجارية، الأشخاص والقاصرون، "
    "المعالم والأعمال الفنية، العلامات المائية والتواريخ المطبوعة، المحتوى المحظور، والأفق المائل"
)

CSS = """
:root{--bg:#F2F4F6;--surface:#FFFFFF;--surface-2:#E8ECF0;--ink:#15202B;--muted:#586674;--line:#D5DCE3;
--accent:#2350C8;--pass:#1B7F52;--pass-bg:#E3F3EA;--review:#9A6412;--review-bg:#FBF0DC;--reject:#B63A28;
--reject-bg:#FBE6E2;--info:#586674;--info-bg:#E8ECF0;
--body:"IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;--display:"Reem Kufi","IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif;
--mono:"IBM Plex Mono",ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0F1419;--surface:#171F28;--surface-2:#1F2934;
--ink:#E5EBF1;--muted:#97A5B3;--line:#2B3744;--accent:#85A6FF;--pass:#57C893;--pass-bg:#15302A;--review:#E2AC52;
--review-bg:#33291A;--reject:#F27D69;--reject-bg:#3A201D;--info:#97A5B3;--info-bg:#1F2934}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.7}
.wrap{max-width:1180px;margin-inline:auto;padding:32px 16px 64px;display:grid;gap:28px}
h1,h2{font-family:var(--display);margin:0;line-height:1.3}
h1{font-size:clamp(1.6rem,4vw,2.3rem)}h2{font-size:1.25rem}
p{margin:0}.muted{color:var(--muted)}
.ltr{direction:ltr;unicode-bidi:isolate;font-family:var(--mono);font-size:.85em}.nowrap{white-space:nowrap}
header{display:grid;gap:8px;border-bottom:1px solid var(--line);padding-bottom:20px}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--c);border-radius:10px;padding:14px 16px}
.tile b{display:block;font-size:2rem;line-height:1.1;color:var(--c);font-variant-numeric:tabular-nums}
.tile span{color:var(--muted);font-size:.9rem}
.pass{--c:var(--pass);--cbg:var(--pass-bg)}.review{--c:var(--review);--cbg:var(--review-bg)}
.reject{--c:var(--reject);--cbg:var(--reject-bg)}.info{--c:var(--info);--cbg:var(--info-bg)}.all{--c:var(--accent)}
.note{background:var(--surface);border:1px solid var(--line);border-inline-start:4px solid var(--c);border-radius:10px;padding:14px 18px;display:grid;gap:4px}
.reasons{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:520px;font-size:.92rem}
th,td{text-align:right;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;color:var(--muted);font-weight:600;background:var(--surface-2)}
tr:last-child td{border-bottom:0}td.n{font-variant-numeric:tabular-nums;width:1%;white-space:nowrap}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:999px;padding:5px 14px;font:inherit;font-size:.9rem;cursor:pointer}
.chip[aria-pressed=true]{background:var(--c);border-color:var(--c);color:var(--surface)}
input[type=search]{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);min-width:220px;flex:1;max-width:320px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--c);border-radius:10px;overflow:hidden;display:grid;align-content:start}
.thumb{background:var(--surface-2);aspect-ratio:3/2;display:grid;place-items:center;overflow:hidden}
.thumb img{width:100%;height:100%;object-fit:contain}
.thumb span{color:var(--muted);font-family:var(--mono);font-size:1.4rem}
.body{padding:12px 14px 14px;display:grid;gap:8px}
.name{font-weight:600;word-break:break-all;direction:ltr;text-align:right;unicode-bidi:plaintext}
.tag{justify-self:start;font-size:.78rem;font-weight:700;padding:2px 10px;border-radius:999px;background:var(--cbg);color:var(--c)}
.facts{color:var(--muted);font-size:.82rem;display:flex;flex-wrap:wrap;gap:4px 12px}
ul.f{list-style:none;margin:0;padding:0;display:grid;gap:8px}
ul.f li{display:grid;grid-template-columns:10px 1fr;gap:8px;font-size:.9rem;line-height:1.55}
ul.f li::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--c);margin-top:.5em}
ul.f small{display:block;color:var(--muted)}
.g{font-size:.75rem;color:var(--muted)}
.ok{color:var(--muted);font-size:.9rem}
details{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
summary{cursor:pointer;font-weight:600}
pre{direction:ltr;text-align:left;font-family:var(--mono);font-size:.8rem;white-space:pre-wrap;margin:10px 0 0}
[hidden]{display:none!important}
@media (max-width:720px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}}
"""

SCRIPT = """
const chips=[...document.querySelectorAll('.chip')],cards=[...document.querySelectorAll('.card')],q=document.getElementById('q');
let pile='all';
function apply(){const t=q.value.trim().toLowerCase();let n=0;
for(const c of cards){const show=(pile==='all'||c.dataset.v===pile)&&(!t||c.dataset.name.includes(t));c.hidden=!show;if(show)n++}
document.getElementById('shown').textContent=n}
chips.forEach(ch=>ch.addEventListener('click',()=>{pile=ch.dataset.p;chips.forEach(x=>x.setAttribute('aria-pressed',x===ch));apply()}));
q.addEventListener('input',apply);apply();
"""

LEVEL_CLASS = {Level.INFO: "info", Level.REVIEW: "review", Level.REJECT: "reject"}
ORDER = {Verdict.REVIEW: 0, Verdict.REJECT: 1, Verdict.PASS: 2}


def _card(r: FileReport) -> str:
    v = r.verdict
    if r.thumbnail:
        src = base64.b64encode(r.thumbnail).decode("ascii")
        thumb = f'<img src="data:image/jpeg;base64,{src}" alt="" loading="lazy">'
    else:
        thumb = f"<span>{escape(Path(r.name).suffix.lstrip('.').upper() or r.kind.upper())}</span>"
    facts = []
    if r.width:
        facts.append(f"{r.width}×{r.height} · {r.megapixels:.1f} ميغابكسل")
    facts.append(f"{r.size_bytes / 1_000_000:.1f} ميغابايت")
    m = r.metrics
    if "sharpness" in m:
        facts.append(f"الحدة {m['sharpness']:.2f}")
    if "noise" in m:
        facts.append(f"الضوضاء {m['noise']:.1f}")
    if "jpeg_quality" in m:
        facts.append(f"جودة JPEG {int(m['jpeg_quality'])}")
    if r.metadata.ai_generated:
        facts.append("مولّدة بالذكاء الاصطناعي")
    if r.vision_checked:
        facts.append("فُحصت بصرياً")
    items = []
    for f in sorted(r.findings, key=lambda f: -f.level):
        detail = f"<small>{escape(f.detail)}</small>" if f.detail else ""
        items.append(
            f'<li class="{LEVEL_CLASS[f.level]}"><div><span class="g">{escape(GROUPS.get(f.group, f.group))}</span><br>'
            f"{escape(f.message)}{detail}</div></li>"
        )
    findings = f'<ul class="f">{"".join(items)}</ul>' if items else '<p class="ok">لم تظهر أي مشكلة في الفحوص.</p>'
    return (
        f'<article class="card {v.folder}" data-v="{v.folder}" data-name="{escape(r.name.lower())}">'
        f'<div class="thumb">{thumb}</div><div class="body"><span class="tag">{v.label}</span>'
        f'<p class="name">{escape(r.name)}</p><p class="facts">{"".join(f"<span>{escape(x)}</span>" for x in facts)}</p>'
        f"{findings}</div></article>"
    )


def _reasons_table(reports: list[FileReport]) -> str:
    counts: Counter[tuple[str, int]] = Counter()
    messages: dict[tuple[str, int], str] = {}
    for r in reports:
        keys = {(f.rule, int(f.level)) for f in r.findings if f.level > Level.INFO}
        for f in r.findings:
            messages.setdefault((f.rule, int(f.level)), f.message)
        counts.update(keys)
    if not counts:
        return ""
    rows = "".join(
        f'<tr><td class="n">{n}</td><td><span class="tag {LEVEL_CLASS[Level(level)]}">'
        f'{"رفض" if level == Level.REJECT else "مراجعة"}</span></td><td>{escape(messages[(rule, level)])}</td></tr>'
        for (rule, level), n in counts.most_common(15)
    )
    return (
        '<section style="display:grid;gap:12px"><h2>أكثر الأسباب تكراراً</h2><div class="reasons"><table>'
        f"<thead><tr><th>صور</th><th>المستوى</th><th>السبب</th></tr></thead><tbody>{rows}</tbody></table></div></section>"
    )


def _vision_note(result: ScanResult) -> str:
    if result.vision == "on":
        cost = ""
        price = PRICES.get(result.vision_model)
        if price and result.vision_calls:
            usd = (result.vision_input_tokens * price[0] + result.vision_output_tokens * price[1]) / 1_000_000
            cost = f" التكلفة التقديرية لهذا التشغيل: {usd:.2f}$ ({result.vision_calls} طلب)."
        return (
            '<div class="note pass"><b>الفحص البصري بواسطة Claude: مفعّل</b>'
            f'<p class="muted">النموذج <span class="ltr nowrap">{escape(result.vision_model)}</span>. '
            "نتائجه تذهب إلى المراجعة فقط ولا ترفض أي صورة وحدها، لأنه قد يخطئ." + escape(cost) + "</p></div>"
        )
    reason = "" if result.vision == "off" else f" السبب: {escape(result.vision)}."
    return (
        '<div class="note review"><b>الفحص البصري غير مفعّل، فكلمة "مقبول" تعني: نجحت في الفحوص الآلية فقط.</b>'
        f'<p class="muted">لم يُفحص: {UNCHECKED_WITHOUT_VISION}. شغّل الأداة مع <span class="ltr nowrap">--vision</span> '
        f"لتفحصها، أو راجعها بعينك.{reason}</p></div>"
    )


def write_html(result: ScanResult, config: Config, path: Path) -> None:
    reports = sorted(result.reports, key=lambda r: (ORDER[r.verdict], r.name.lower()))
    total = len(reports)
    tiles = "".join(
        f'<div class="tile {cls}"><b>{n}</b><span>{label}</span></div>'
        for cls, n, label in (
            ("all", total, "كل الملفات"),
            ("pass", result.count(Verdict.PASS), "مقبول"),
            ("review", result.count(Verdict.REVIEW), "يحتاج مراجعة"),
            ("reject", result.count(Verdict.REJECT), "مرفوض"),
        )
    )
    chips = "".join(
        f'<button class="chip {cls}" data-p="{cls}" aria-pressed="{str(cls == "all").lower()}">{label}</button>'
        for cls, label in (("all", "الكل"), ("review", "مراجعة"), ("reject", "مرفوض"), ("pass", "مقبول"))
    )
    csv_line = (
        f'<p class="muted">البيانات الوصفية من <span class="ltr">{escape(result.csv_path.name)}</span></p>'
        if result.csv_path else ""
    )
    bare = sum(1 for r in reports if r.kind != "other" and not r.metadata.title and not r.metadata.keywords)
    if bare:
        csv_line += (
            f'<p class="muted">{bare} من الملفات بلا عنوان ولا كلمات مفتاحية، فلم تُفحص بياناتها الوصفية؛ '
            "أضفها في بوابة Adobe أو في ملف CSV بجانب الصور.</p>"
        )
    settings = escape(json.dumps({k: v for k, v in asdict(config).items() if k != "base_dir"}, ensure_ascii=False, indent=2))
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    html = f"""<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>تقرير Quality Guard</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&family=Reem+Kufi:wght@700&family=IBM+Plex+Mono&display=swap">
<style>{CSS}</style></head><body><div class="wrap">
<header><span class="muted">Quality Guard · فحص قبل الرفع إلى Adobe Stock</span>
<h1>تقرير الفحص</h1>
<p class="muted"><span class="ltr">{escape(str(result.input_dir))}</span> · {stamp} · {result.seconds:.0f} ثانية</p>{csv_line}</header>
<section class="tiles">{tiles}</section>
{_vision_note(result)}
<div class="note info"><p class="muted"><b>مرفوض</b>: مخالفة مقيسة لقاعدة منشورة. <b>مراجعة</b>: خطر رفض يحتاج نظرك.
<b>مقبول</b>: لم تظهر مشكلة، لكن Adobe قد يرفض لأسباب ذوقية (القيمة التجارية أو التشبع) لا يمكن فحصها مسبقاً.</p></div>
{_reasons_table(reports)}
<section style="display:grid;gap:14px"><h2>الملفات</h2>
<div class="bar">{chips}<input type="search" id="q" placeholder="ابحث باسم الملف" aria-label="ابحث باسم الملف">
<span class="muted">المعروض: <b id="shown">{total}</b></span></div>
<div class="grid">{"".join(_card(r) for r in reports)}</div></section>
<details><summary>الإعدادات المستخدمة في هذا الفحص</summary><pre>{settings}</pre></details>
</div><script>{SCRIPT}</script></body></html>"""
    path.write_text(html, encoding="utf-8")


def write_csv(result: ScanResult, path: Path) -> None:
    # utf-8-sig so Excel on Windows shows Arabic correctly.
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["file", "verdict", "الحكم", "width", "height", "megapixels", "sharpness", "noise",
                    "jpeg_quality", "ai_generated", "vision_checked", "reasons", "rules"])
        for r in result.reports:
            m = r.metrics
            problems = [f for f in r.findings if f.level > Level.INFO]
            w.writerow([
                r.name, r.verdict.folder, r.verdict.label, r.width or "", r.height or "",
                f"{r.megapixels:.1f}" if r.width else "",
                f"{m['sharpness']:.2f}" if "sharpness" in m else "",
                f"{m['noise']:.1f}" if "noise" in m else "",
                int(m["jpeg_quality"]) if "jpeg_quality" in m else "",
                "yes" if r.metadata.ai_generated else "", "yes" if r.vision_checked else "",
                " | ".join(f.message + (f" ({f.detail})" if f.detail else "") for f in problems),
                " ".join(f.rule for f in problems),
            ])


def write_json(result: ScanResult, path: Path) -> None:
    data = {
        "input": str(result.input_dir),
        "counts": {v.folder: result.count(v) for v in Verdict},
        "vision": result.vision,
        "vision_model": result.vision_model,
        "files": [r.to_dict() for r in result.reports],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
