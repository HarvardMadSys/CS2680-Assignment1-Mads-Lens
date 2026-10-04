import pytest

from logparse.parser import LogLine, parse_line, parse_lines


def test_parse():
    assert parse_line("INFO server started\n") == LogLine("INFO", "server started")


def test_parse_no_newline():
    assert parse_line("ERROR disk full") == LogLine("ERROR", "disk full")


def test_unknown_level():
    with pytest.raises(ValueError):
        parse_line("TRACE something")


def test_parse_lines_skips_blank():
    assert len(parse_lines(["INFO a\n", "\n", "WARN b\n"])) == 2
