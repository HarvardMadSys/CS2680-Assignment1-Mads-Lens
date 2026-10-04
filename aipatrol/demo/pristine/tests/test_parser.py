from logtool.parser import parse_line, parse_log

SAMPLE = '127.0.0.1 - - [10/Oct/2024:13:55:36 +0000] "GET /index.html HTTP/1.1" 200 2326'


def test_parses_a_common_log_line():
    line = parse_line(SAMPLE)
    assert line is not None
    assert line.method == "GET"
    assert line.path == "/index.html"
    assert line.status == 200
    assert line.size == 2326


def test_a_dash_size_counts_as_zero():
    raw = SAMPLE.replace(" 2326", " -")
    line = parse_line(raw)
    assert line is not None
    assert line.size == 0


def test_rubbish_is_not_a_log_line():
    assert parse_line("this is not a log line") is None


def test_parse_log_skips_what_it_cannot_read():
    text = "\n".join([SAMPLE, "", "garbage", SAMPLE])
    assert len(parse_log(text)) == 2


def test_a_path_with_a_query_string_survives():
    raw = SAMPLE.replace("/index.html", "/search?q=logs&page=2")
    line = parse_line(raw)
    assert line is not None
    assert line.path == "/search?q=logs&page=2"
