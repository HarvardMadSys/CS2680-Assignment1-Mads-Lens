import unittest

from src.parser import parse, summarize

SAMPLE = """2024-01-01T00:00:00Z INFO booted
2024-01-01T00:00:01Z WARN slow query (312ms)
2024-01-01T00:00:02Z ERROR crash
"""


class TestParse(unittest.TestCase):
    def test_parse(self):
        rows = parse(SAMPLE)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[1]["level"], "WARN")
        self.assertEqual(parse(SAMPLE + "\n\n"), rows)

    def test_summarize(self):
        self.assertEqual(summarize(parse(SAMPLE)), {"INFO": 1, "WARN": 1, "ERROR": 1})

    def test_multiline_message(self):
        rows = parse("2024-01-01T00:00:00Z INFO first\n    continued\n")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["msg"], "first continued")


if __name__ == "__main__":
    unittest.main()
