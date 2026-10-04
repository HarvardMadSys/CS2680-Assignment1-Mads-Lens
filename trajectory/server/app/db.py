import json
import sqlite3
import threading
import time
from typing import Any

from .config import DB_PATH

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  path TEXT PRIMARY KEY, name TEXT, last_opened REAL, runs INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT, prev_session_id TEXT, cwd TEXT, prompt TEXT,
  started_at REAL, ended_at REAL, status TEXT, error TEXT, result TEXT,
  cost_usd REAL, duration_ms INTEGER, api_duration_ms INTEGER, num_turns INTEGER,
  usage TEXT, phases TEXT, timing TEXT, options TEXT, model TEXT, replay INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS frames (
  run_id TEXT, seq INTEGER, ts REAL, body TEXT, PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  run_id TEXT, tool_use_id TEXT, name TEXT, input TEXT, parent TEXT,
  started_at REAL, ended_at REAL, is_error INTEGER, result TEXT, result_chars INTEGER, sig TEXT,
  PRIMARY KEY (run_id, tool_use_id)
);
CREATE TABLE IF NOT EXISTS summaries (
  key TEXT PRIMARY KEY, text TEXT, ts REAL
);
CREATE TABLE IF NOT EXISTS edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, cwd TEXT, path TEXT,
  tool TEXT, ts REAL, bytes INTEGER, summary TEXT
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, tool_use_id TEXT, cwd TEXT, path TEXT,
  kind TEXT, tool TEXT, ts REAL, chars INTEGER, text TEXT
);
CREATE INDEX IF NOT EXISTS idx_versions_path ON versions(path, ts);
CREATE TABLE IF NOT EXISTS bg_procs (
  pid INTEGER PRIMARY KEY, run_id TEXT, cmd TEXT, first_seen REAL
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_cwd ON runs(cwd, started_at);
CREATE INDEX IF NOT EXISTS idx_edits_cwd ON edits(cwd, ts);
"""
_conn.executescript(SCHEMA)
for _tbl, _col, _type in (("runs", "timing", "TEXT"), ("tool_calls", "sig", "TEXT")):
    try:  # widen older databases in place
        _conn.execute(f"ALTER TABLE {_tbl} ADD COLUMN {_col} {_type}")
    except sqlite3.OperationalError:
        pass
# after the widening, so an older tool_calls has `sig` by the time we index it
_conn.executescript(
    "CREATE INDEX IF NOT EXISTS idx_calls_sig ON tool_calls(sig, started_at);"
    "CREATE INDEX IF NOT EXISTS idx_calls_name ON tool_calls(name, started_at);"
)
_conn.commit()


def q(sql: str, args: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args: tuple = ()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def run(sql: str, args: tuple = ()) -> None:
    with _lock:
        _conn.execute(sql, args)
        _conn.commit()


def js(v: Any) -> str:
    return json.dumps(v, default=str)


def unjs(v: str | None, fallback: Any = None) -> Any:
    if not v:
        return fallback
    try:
        return json.loads(v)
    except Exception:
        return fallback


def touch_project(path: str, name: str) -> None:
    run(
        "INSERT INTO projects(path,name,last_opened,runs) VALUES(?,?,?,0) "
        "ON CONFLICT(path) DO UPDATE SET last_opened=excluded.last_opened, name=excluded.name",
        (path, name, time.time()),
    )
