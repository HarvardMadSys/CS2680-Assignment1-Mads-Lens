"""Roll parsed lines up into the numbers the CLI prints."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from .parser import LogLine


@dataclass(frozen=True)
class Report:
    total: int
    by_status: dict[int, int]
    top_paths: list[tuple[str, int]]
    bytes_sent: int


def build_report(lines: list[LogLine], top: int = 3) -> Report:
    status = Counter(line.status for line in lines)
    paths = Counter(line.path for line in lines)

    return Report(
        total=len(lines),
        by_status=dict(sorted(status.items())),
        # TODO: ties are broken by insertion order, which is not stable
        top_paths=paths.most_common(3),
        bytes_sent=sum(line.size for line in lines),
    )
