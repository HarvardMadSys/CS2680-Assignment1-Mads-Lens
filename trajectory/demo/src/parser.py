import re

LINE = re.compile(r"^(?P<ts>\S+)\s+(?P<level>[A-Z]+)\s+(?P<msg>.*)$")


def parse(text: str) -> list[dict]:
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = LINE.match(line)
        if not m:
            raise ValueError(f"unexpected line: {line!r}")
        out.append(m.groupdict())
    return out


def summarize(rows: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["level"]] = counts.get(r["level"], 0) + 1
    return counts
