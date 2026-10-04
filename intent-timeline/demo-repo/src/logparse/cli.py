import argparse
import sys
from collections import Counter

from .parser import parse_lines


def main(argv=None):
    ap = argparse.ArgumentParser(prog="logparse", description="Summarize a simple log file.")
    ap.add_argument("path", help="log file to read")
    ap.add_argument("--level", help="only count lines at this level")
    args = ap.parse_args(argv)

    with open(args.path) as f:
        lines = parse_lines(f)
    if args.level:
        lines = [l for l in lines if l.level == args.level]
    counts = Counter(l.level for l in lines)
    for level, n in sorted(counts.items()):
        print(f"{level}\t{n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
