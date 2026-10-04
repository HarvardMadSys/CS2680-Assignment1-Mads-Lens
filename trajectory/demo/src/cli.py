import sys

from .parser import parse, summarize


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: cli <logfile>")
        return 1
    rows = parse(open(argv[0]).read())
    for level, n in sorted(summarize(rows).items()):
        print(f"{level:>7} {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
