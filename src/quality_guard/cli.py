"""Command line: `qguard FOLDER`, `qguard calibrate`, and `qguard ui` (also what runs with no arguments)."""

from __future__ import annotations

import argparse
import sys
import webbrowser
from collections import Counter
from pathlib import Path

from . import __version__
from .config import Config, ConfigError, load_config
from .findings import Level, Verdict
from .metadata_io import CsvFormatError
from .pipeline import analyse, default_out_dir, publish
from .scanner import Cancelled, ProgressEvent, ScanResult

EPILOG = """أمثلة:
  qguard                                     # يفتح التطبيق في المتصفح
  qguard "D:\\Stock\\batch-12"
  qguard "D:\\Stock\\batch-12" --vision --open
  qguard calibrate --accepted "D:\\Stock\\accepted" --rejected "D:\\Stock\\rejected"
"""

STAGES = {"analyze": "فحص", "similar": "تشابه", "local": "فحص محلي", "vision": "فحص بصري", "done": "انتهى"}


def _console_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _progress(event: ProgressEvent) -> None:
    if event.stage in ("similar", "done"):
        return
    sys.stderr.write(f"\r{STAGES[event.stage]}: {event.done}/{event.total}  {event.name[:50]:<50}")
    if event.done == event.total:
        sys.stderr.write("\n")
    sys.stderr.flush()


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--vision", action="store_true", help="فحص بصري بواسطة Claude (يحتاج ANTHROPIC_API_KEY، وله تكلفة)")
    p.add_argument("--model", help="نموذج Claude للفحص البصري (الافتراضي claude-opus-5)")
    p.add_argument("--local-ai", action=argparse.BooleanOptionalAction, default=None,
                   help="قراءة النصوص وكشف الوجوه على جهازك (يعمل تلقائياً إن كان مثبتاً)")
    p.add_argument("--config", help="ملف إعدادات TOML لتغيير الحدود")
    p.add_argument("--recursive", action="store_true", help="افحص المجلدات الفرعية أيضاً")
    p.add_argument("--jobs", type=int, default=0, help="عدد الصور التي تُفحص في وقت واحد (الافتراضي حسب جهازك)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qguard", description="يفحص الصور قبل رفعها إلى Adobe Stock ويوزعها على: مقبول، مراجعة، مرفوض.",
        epilog=EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"quality-guard {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="افحص مجلداً ووزّع صوره")
    s.add_argument("input", help="مجلد الصور")
    s.add_argument("--out", help="مجلد النتائج (الافتراضي: بجانب مجلد الصور)")
    s.add_argument("--csv", help="ملف CSV بصيغة Adobe Stock (Filename, Title, Keywords...)")
    s.add_argument("--no-copy", action="store_true", help="التقرير فقط، بدون نسخ الملفات إلى المجلدات")
    s.add_argument("--open", action="store_true", help="افتح التقرير في المتصفح بعد الانتهاء")
    _common(s)

    c = sub.add_parser("calibrate", help="قِس دقة الأداة على صور سبق أن قبلها Adobe أو رفضها")
    c.add_argument("--accepted", required=True, help="مجلد صور قبلها Adobe")
    c.add_argument("--rejected", required=True, help="مجلد صور رفضها Adobe")
    c.add_argument("--out", help="مجلد النتائج")
    _common(c)

    u = sub.add_parser("ui", help="افتح التطبيق في المتصفح")
    u.add_argument("--port", type=int, default=0, help="المنفذ (الافتراضي: أي منفذ متاح)")
    u.add_argument("--no-browser", action="store_true", help="لا تفتح المتصفح تلقائياً")
    u.add_argument("--config", help="ملف إعدادات TOML")
    return parser


def _config(args: argparse.Namespace) -> Config:
    config = load_config(args.config)
    if getattr(args, "model", None):
        config.vision.model = args.model
    return config


def _summary(result: ScanResult) -> str:
    return (
        f"مقبول {result.count(Verdict.PASS)} · مراجعة {result.count(Verdict.REVIEW)} · "
        f"مرفوض {result.count(Verdict.REJECT)} (من {len(result.reports)})"
    )


def cmd_scan(args: argparse.Namespace) -> int:
    input_dir = Path(args.input).expanduser().resolve()
    if not input_dir.is_dir():
        print(f"المجلد غير موجود: {input_dir}", file=sys.stderr)
        return 2
    out_dir = Path(args.out).expanduser().resolve() if args.out else default_out_dir(input_dir)
    csv = Path(args.csv).expanduser().resolve() if args.csv else None
    config = _config(args)
    result = analyse(input_dir, out_dir, config, csv=csv, vision=args.vision, local_ai=args.local_ai,
                     recursive=args.recursive, jobs=args.jobs, progress=_progress)
    if not result.reports:
        print("لا توجد صور في هذا المجلد.")
        return 1
    report = publish(result, config, out_dir, copy=not args.no_copy)
    if result.csv_path:
        print(f"ملف البيانات الوصفية: {result.csv_path.name}")
    for warning in result.csv_warnings:
        print(f"تنبيه CSV: {warning}", file=sys.stderr)
    print(_summary(result))
    if args.vision and result.vision != "on":
        print(f"تنبيه: الفحص البصري لم يعمل: {result.vision}", file=sys.stderr)
    print(f"التقرير: {report}")
    if args.open:
        webbrowser.open(report.as_uri())
    return 0


def calibration_text(accepted: ScanResult, rejected: ScanResult) -> str:
    def shares(r: ScanResult) -> tuple[float, float, float]:
        n = max(1, len(r.reports))
        return (r.count(Verdict.PASS) / n, r.count(Verdict.REVIEW) / n, r.count(Verdict.REJECT) / n)

    a, r = shares(accepted), shares(rejected)
    na, nr = len(accepted.reports), len(rejected.reports)
    lines = [
        f"صور قبلها Adobe ({na}): مقبول {a[0]:.0%} · مراجعة {a[1]:.0%} · مرفوض {a[2]:.0%}",
        "  المرفوض هنا إنذارات خاطئة، والمراجعة وقت إضافي تقضيه في النظر.",
        f"صور رفضها Adobe ({nr}): التقطتها الأداة {r[1] + r[2]:.0%} (مرفوض {r[2]:.0%} + مراجعة {r[1]:.0%}) "
        f"· فاتتها {r[0]:.0%} وذهبت إلى مقبول",
    ]
    passed = a[0] * na + r[0] * nr
    if passed:
        precision = a[0] * na / passed
        lines.append(
            f"لو كانت دفعاتك بنفس نسبة هذه العينة، فمن كل 100 صورة في \"مقبول\" سيقبل Adobe نحو {precision * 100:.0f}."
        )
    false_alarms: Counter[str] = Counter()
    for rep in accepted.reports:
        for _, message in {(f.rule, f.message) for f in rep.findings if f.level == Level.REJECT}:
            false_alarms[message] += 1
    if false_alarms:
        lines.append("أكثر أسباب الرفض الخاطئ على الصور المقبولة (فكّر في تعديل حدودها في ملف الإعدادات):")
        lines += [f"  {n} × {msg}" for msg, n in false_alarms.most_common(5)]
    missed = [rep.name for rep in rejected.reports if rep.verdict == Verdict.PASS]
    if missed:
        lines.append("صور مرفوضة لم تلتقطها الأداة (راجع سبب رفض Adobe لها):")
        lines += [f"  {name}" for name in missed[:20]]
    return "\n".join(lines)


def cmd_calibrate(args: argparse.Namespace) -> int:
    acc, rej = Path(args.accepted).expanduser().resolve(), Path(args.rejected).expanduser().resolve()
    for d in (acc, rej):
        if not d.is_dir():
            print(f"المجلد غير موجود: {d}", file=sys.stderr)
            return 2
    out = Path(args.out).expanduser().resolve() if args.out else acc.parent / "quality-guard-calibration"
    config = _config(args)
    results = []
    for name, folder in (("accepted", acc), ("rejected", rej)):
        result = analyse(folder, out / name, config, vision=args.vision, local_ai=args.local_ai,
                         recursive=args.recursive, jobs=args.jobs, progress=_progress)
        publish(result, config, out / name, copy=False)
        results.append(result)
    text = calibration_text(*results)
    (out / "calibration.txt").write_text(text + "\n", encoding="utf-8")
    print(text)
    print(f"التقارير: {out / 'accepted' / 'report.html'} و {out / 'rejected' / 'report.html'}")
    return 0


def cmd_ui(args: argparse.Namespace) -> int:
    from .server import serve  # noqa: PLC0415 - only the app needs the web server

    return serve(_config(args), port=args.port, open_browser=not args.no_browser, config_from_file=bool(args.config))


def main(argv: list[str] | None = None) -> int:
    _console_utf8()
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        argv = ["ui"]
    elif argv[0] not in ("scan", "calibrate", "ui") and not argv[0].startswith("-"):
        argv.insert(0, "scan")
    args = build_parser().parse_args(argv)
    commands = {"scan": cmd_scan, "calibrate": cmd_calibrate, "ui": cmd_ui}
    try:
        return commands[args.command](args)
    except (ConfigError, CsvFormatError) as e:
        print(e, file=sys.stderr)
        return 2
    except (KeyboardInterrupt, Cancelled):
        print("\nأُوقف الفحص.", file=sys.stderr)
        return 130
