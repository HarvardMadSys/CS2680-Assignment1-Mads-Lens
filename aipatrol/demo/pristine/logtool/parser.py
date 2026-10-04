"""Turn raw access-log text into structured lines.

The format is the common log format, trimmed to what the report needs:

    127.0.0.1 - - [10/Oct/2024:13:55:36 +0000] "GET /index.html HTTP/1.1" 200 2326
"""

from __future__ import annotations

import re
from dataclasses import dataclass

LINE = re.compile(
    r'^(?P<host>\S+) \S+ \S+ \[(?P<stamp>[^\]]+)\] '
    r'"(?P<method>[A-Z]+) (?P<path>\S+) [^"]*" '
    r'(?P<status>\d{3}) (?P<size>\d+|-)$'
)


@dataclass(frozen=True)
class LogLine:
    host: str
    stamp: str
    method: str
    path: str
    status: int
    size: int


def parse_line(raw: str) -> LogLine | None:
    """Parse one line, or return None if it is not a log line at all."""
    match = LINE.match(raw.strip())
    if match is None:
        return None

    size = match["size"]
    return LogLine(
        host=match["host"],
        stamp=match["stamp"],
        method=match["method"],
        path=match["path"],
        status=int(match["status"]),
        size=0 if size == "-" else int(size),
    )


def parse_log(text: str) -> list[LogLine]:
    """Parse a whole log, skipping anything unparseable."""
    lines = []
    for raw in text.split("\n"):
        if not raw.strip():
            continue
        line = parse_line(raw)
        if line is not None:
            lines.append(line)
    return lines
