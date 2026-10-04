"""The command line entry point."""

from __future__ import annotations

import argparse
import sys

from .parser import parse_log
from .report import build_report


def render(report) -> str:
    lines = [f"{report.total} requests, {report.bytes_sent} bytes"]

    lines.append("")
    lines.append("by status")
    for status, count in report.by_status.items():
        lines.append(f"  {status}  {count}")

    lines.append("")
    lines.append("top paths")
    for path, count in report.top_paths:
        lines.append(f"  {count:>4}  {path}")

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="logtool", description=__doc__)
    ap.add_argument("logfile", help="access log to summarise")
    ap.add_argument("--top", type=int, default=3, help="how many paths to list")
    args = ap.parse_args(argv)

    try:
        with open(args.logfile, encoding="utf-8") as handle:
            text = handle.read()
    except OSError as err:
        print(f"logtool: {err}", file=sys.stderr)
        return 1

    print(render(build_report(parse_log(text), top=args.top)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
