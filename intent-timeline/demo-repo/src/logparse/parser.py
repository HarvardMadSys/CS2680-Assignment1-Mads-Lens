from dataclasses import dataclass

LEVELS = ("DEBUG", "INFO", "WARN", "ERROR")


@dataclass
class LogLine:
    level: str
    message: str


def parse_line(line: str) -> LogLine:
    """Parse one line of the form `LEVEL message`."""
    level, _, message = line.partition(" ")
    if level not in LEVELS:
        raise ValueError(f"unknown level: {level!r}")
    return LogLine(level=level, message=message)


def parse_lines(lines):
    """Parse an iterable of lines, skipping blank ones."""
    out = []
    for line in lines:
        if not line.strip():
            continue
        out.append(parse_line(line))
    return out
