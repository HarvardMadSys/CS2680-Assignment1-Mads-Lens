from logtool.cli import main


def test_reports_a_log_file(tmp_path, capsys):
    log = tmp_path / "access.log"
    log.write_text(
        '127.0.0.1 - - [10/Oct/2024:13:55:36 +0000] "GET /a HTTP/1.1" 200 100\n',
        encoding="utf-8",
    )

    assert main([str(log)]) == 0
    out = capsys.readouterr().out
    assert "1 requests" in out
    assert "/a" in out


def test_a_missing_file_is_an_error_not_a_traceback(tmp_path, capsys):
    assert main([str(tmp_path / "nope.log")]) == 1
    assert "logtool:" in capsys.readouterr().err
