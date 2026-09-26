"""Command line: `qguard FOLDER`, `qguard calibrate`, or no arguments for a folder picker."""

from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from collections import Counter
from pathlib import Path

from . import __version__
from .config import Config, ConfigError, load_config
from .findings import Level, Verdict
from .metadata_io import CsvFormatError, find_adobe_csv
from .report import write_csv, write_html, write_json
from .scanner import ScanResult, scan
from .sorter import sort_files

EPILOG = """أمثلة:
  qguard "D:\\Stock\\batch-12"
  qguard "D:\\Stock\\batch-12" --vision --open
  qguard calibrate --accepted "D:\\Stock\\accepted" --rejected "D:\\Stock\\rejected"
"""


def _console_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _progress(stage: str, done: int, total: int, name: str) -> None:
    label = "فحص" if stage == "analyze" else "فحص بصري"
    sys.stderr.write(f"\r{label}: {done}/{total}  {name[:50]:<50}")
    if done == total:
        sys.stderr.write("\n")
    sys.stderr.flush()


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--vision", action="store_true", help="فحص بصري بواسطة Claude (يحتاج ANTHROPIC_API_KEY، وله تكلفة)")
    p.add_argument("--model", help="نموذج Claude للفحص البصري (الافتراضي claude-opus-5)")
    p.add_argument("--config", help="ملف إعدادات TOML لتغيير الحدود")
    p.add_argument("--recursive", action="store_true", help="افحص المجلدات الفرعية أيضاً")
    p.add_argument("--jobs", type=int, default=0, help="عدد الصور التي تُفحص في وقت واحد")


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
    return parser


def _config(args: argparse.Namespace) -> Config:
    config = load_config(args.config)
    if args.model:
        config.vision.model = args.model
    return config


def run_scan(
    input_dir: Path, out_dir: Path, config: Config, *, csv: Path | None = None, vision: bool = False,
    recursive: bool = False, jobs: int = 0, copy: bool = True, quiet: bool = False,
) -> ScanResult:
    if csv is None:
        csv = find_adobe_csv(input_dir)
        if csv and not quiet:
            print(f"ملف البيانات الوصفية: {csv.name}")
    out_dir.mkdir(parents=True, exist_ok=True)
    result = scan(
        input_dir, config, recursive=recursive, csv_path=csv, vision=vision, jobs=jobs,
        exclude=out_dir, cache_dir=out_dir, progress=None if quiet else _progress,
    )
    if copy:
        sort_files(result, out_dir)
    write_html(result, config, out_dir / "report.html")
    write_csv(result, out_dir / "results.csv")
    write_json(result, out_dir / "results.json")
    return result


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
    out_dir = Path(args.out).expanduser().resolve() if args.out else input_dir.parent / f"{input_dir.name}-quality-guard"
    csv = Path(args.csv).expanduser().resolve() if args.csv else None
    result = run_scan(input_dir, out_dir, _config(args), csv=csv, vision=args.vision,
                      recursive=args.recursive, jobs=args.jobs, copy=not args.no_copy)
    if not result.reports:
        print("لا توجد صور في هذا المجلد.")
        return 1
    print(_summary(result))
    if args.vision and result.vision != "on":
        print(f"تنبيه: الفحص البصري لم يعمل: {result.vision}", file=sys.stderr)
    print(f"التقرير: {out_dir / 'report.html'}")
    if args.open:
        webbrowser.open((out_dir / "report.html").as_uri())
    return 0


def calibration_text(accepted: ScanResult, rejected: ScanResult) -> str:
    def shares(r: ScanResult) -> tuple[float, float, float]:
        n = max(1, len(r.reports))
        return tuple(r.count(v) / n for v in (Verdict.PASS, Verdict.REVIEW, Verdict.REJECT))  # type: ignore[return-value]

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
        for f in {(f.rule, f.message) for f in rep.findings if f.level == Level.REJECT}:
            false_alarms[f[1]] += 1
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
        results.append(run_scan(folder, out / name, config, vision=args.vision, recursive=args.recursive,
                                jobs=args.jobs, copy=False))
    text = calibration_text(*results)
    (out / "calibration.txt").write_text(text + "\n", encoding="utf-8")
    print(text)
    print(f"التقارير: {out / 'accepted' / 'report.html'} و {out / 'rejected' / 'report.html'}")
    return 0


def gui() -> int:
    """Double-click mode: pick a folder, scan it, open the report."""
    try:
        import tkinter as tk
        from tkinter import filedialog, messagebox
    except ImportError:
        build_parser().print_help()
        return 2
    root = tk.Tk()
    root.withdraw()
    folder = filedialog.askdirectory(title="اختر مجلد الصور المراد فحصها")
    if not folder:
        return 0
    vision = bool(os.environ.get("ANTHROPIC_API_KEY")) and messagebox.askyesno(
        "Quality Guard", "هل تريد الفحص البصري بواسطة Claude؟\nيكتشف الشعارات والأشخاص وعيوب الذكاء الاصطناعي، وله تكلفة لكل صورة."
    )
    input_dir = Path(folder)
    out_dir = input_dir.parent / f"{input_dir.name}-quality-guard"
    print(f"أفحص: {input_dir}")
    result = run_scan(input_dir, out_dir, Config(), vision=vision)
    webbrowser.open((out_dir / "report.html").as_uri())
    messagebox.showinfo("Quality Guard", f"{_summary(result)}\n\nالنتائج في:\n{out_dir}")
    root.destroy()
    return 0


def main(argv: list[str] | None = None) -> int:
    _console_utf8()
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        return gui()
    if argv[0] not in ("scan", "calibrate") and not argv[0].startswith("-"):
        argv.insert(0, "scan")
    args = build_parser().parse_args(argv)
    try:
        return cmd_scan(args) if args.command == "scan" else cmd_calibrate(args)
    except (ConfigError, CsvFormatError) as e:
        print(e, file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nأُوقف الفحص.", file=sys.stderr)
        return 130
