from logtool.parser import parse_log
from logtool.report import build_report

LOG = """\
127.0.0.1 - - [10/Oct/2024:13:55:36 +0000] "GET /a HTTP/1.1" 200 100
127.0.0.1 - - [10/Oct/2024:13:55:37 +0000] "GET /a HTTP/1.1" 200 100
127.0.0.1 - - [10/Oct/2024:13:55:38 +0000] "GET /b HTTP/1.1" 404 0
127.0.0.1 - - [10/Oct/2024:13:55:39 +0000] "GET /c HTTP/1.1" 500 -
"""


def report(top=3):
    return build_report(parse_log(LOG), top=top)


def test_counts_every_request():
    assert report().total == 4


def test_groups_by_status():
    assert report().by_status == {200: 2, 404: 1, 500: 1}


def test_adds_up_the_bytes():
    assert report().bytes_sent == 200


def test_ranks_the_busiest_path_first():
    assert report().top_paths[0] == ("/a", 2)


def test_top_limits_how_many_paths_come_back():
    assert len(report(top=2).top_paths) == 2


def test_an_empty_log_reports_nothing_rather_than_failing():
    empty = build_report(parse_log(""))
    assert empty.total == 0
    assert empty.by_status == {}
    assert empty.bytes_sent == 0
