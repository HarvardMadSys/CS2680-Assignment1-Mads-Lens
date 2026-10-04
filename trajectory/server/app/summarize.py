"""One-line, plain-English recaps of what the agent is doing, from a small local model.

The model is any OpenAI-compatible server — `trajectory model` starts llama.cpp on LFM2.5-2.6B,
which pulls the GGUF from the Hub on first use and caches it outside the repo. Every answer is
cached in SQLite by (tool, input), so a repeated call is free and survives restarts, and when
nothing is serving we fall back to a heuristic rather than blocking the run.
"""
import asyncio
import hashlib
import json
import re
import socket
import time
import urllib.parse
import urllib.request
from pathlib import Path

from . import db
from .config import SUMMARIZER_KEY, SUMMARIZER_MODEL, SUMMARIZER_TIMEOUT, SUMMARIZER_URL

TOOL_SYS = (
    "You label one tool call from a coding agent for a live activity feed. "
    "Reply with the label only: 3 to 8 words, plain English, present tense, lower case, "
    "no tool name, no quotes, no final period. Say what the call is FOR, not what it literally is. "
    'Examples: "install the pinned dependencies", "look for the retry helper", '
    '"add a guard for empty input".'
)
EDIT_SYS = (
    "Summarise a code edit in at most 9 words. No preamble, no final period, no filename. "
    "Imperative mood. Be extremely concise."
)

# LFM2.5 always opens with a <think> block; `--reasoning-budget 0` empties it but never removes it.
THINK = re.compile(r"<think>.*?</think>", re.S)

_inflight: dict[str, asyncio.Future] = {}
_down_until = 0.0    # nothing is listening; stop knocking until this passes


def sig(name: str, inp: object) -> str:
    """Cache key for a call: the same tool with the same arguments is the same one line."""
    blob = f"{name}\x00{json.dumps(inp, sort_keys=True, default=str)}"
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def _clean(text: str, limit: int = 72) -> str:
    text = THINK.sub("", text).rsplit("</think>", 1)[-1]
    # a <think> still open ran out of budget mid-thought: there is no answer, only reasoning
    text = text.split("<think>")[0]
    line = next((l.strip(" -*\"'`") for l in text.strip().splitlines() if l.strip()), "")
    return line.rstrip(".")[:limit]


def _chat(sys: str, prompt: str, max_tokens: int) -> str | None:
    global _down_until
    if not SUMMARIZER_URL or time.time() < _down_until:
        return None
    body = json.dumps({
        "model": SUMMARIZER_MODEL, "max_tokens": max_tokens, "temperature": 0.1,
        "messages": [{"role": "system", "content": sys}, {"role": "user", "content": prompt}],
    }).encode()
    headers = {"Content-Type": "application/json"}
    if SUMMARIZER_KEY:
        headers["Authorization"] = f"Bearer {SUMMARIZER_KEY}"
    try:
        req = urllib.request.Request(SUMMARIZER_URL, body, headers)
        with urllib.request.urlopen(req, timeout=SUMMARIZER_TIMEOUT) as r:
            data = json.loads(r.read())
        return _clean(data["choices"][0]["message"]["content"]) or None
    except Exception:
        _down_until = time.time() + 60
        return None


def enabled() -> bool:
    """Worth attempting: configured, and not latched off by a recent failure. No I/O."""
    return bool(SUMMARIZER_URL) and time.time() >= _down_until


def reachable() -> bool:
    """Actually open a socket to the endpoint — `enabled()` only means we have not given up yet."""
    if not SUMMARIZER_URL:
        return False
    u = urllib.parse.urlparse(SUMMARIZER_URL)
    try:
        socket.create_connection((u.hostname, u.port or (443 if u.scheme == "https" else 80)),
                                 timeout=0.5).close()
        return True
    except OSError:
        return False


# ---------------------------------------------------------------- tool calls

SKIP_KEYS = ("content", "new_string", "old_string", "prompt")


def _brief(name: str, inp: object) -> str:
    """Render a call small enough to prompt with — a whole-file Write must not become the prompt."""
    if not isinstance(inp, dict):
        return f"tool: {name}\nargument: {str(inp)[:600]}"
    args = "\n".join(f"{k}: {json.dumps(v, default=str)[:300]}"
                     for k, v in inp.items() if k not in SKIP_KEYS)
    body = inp.get("content") or inp.get("new_string") or inp.get("prompt") or ""
    out = f"tool: {name}\n{args}"
    if body:
        out += f"\ntext:\n{str(body)[:600]}"
    return out[:1400]


def heuristic(name: str, inp: object) -> str:
    """What we show with no model running: the identifying argument, lightly worded."""
    d = inp.get("description") if isinstance(inp, dict) else None
    if isinstance(d, str) and d.strip():
        return d.strip()[:72]
    get = (lambda k: str(inp.get(k, ""))) if isinstance(inp, dict) else (lambda _: "")
    f = lambda k: Path(get(k)).name
    return {
        "Bash": lambda: f"run {get('command').splitlines()[0][:60]}" if get("command") else "run a command",
        "Read": lambda: f"read {f('file_path')}",
        "Write": lambda: f"write {f('file_path')}",
        "Edit": lambda: f"edit {f('file_path')}",
        "MultiEdit": lambda: f"edit {f('file_path')}",
        "Glob": lambda: f"find files matching {get('pattern')[:40]}",
        "Grep": lambda: f"search for {get('pattern')[:40]}",
        "WebFetch": lambda: f"fetch {get('url')[:50]}",
        "WebSearch": lambda: f"search the web for {get('query')[:40]}",
        "TodoWrite": lambda: "update the task list",
    }.get(name, lambda: name.lower())()[:72]


def cached(key: str) -> str | None:
    row = db.one("SELECT text FROM summaries WHERE key=?", (key,))
    return row["text"] if row else None


async def tool_summary(name: str, inp: dict, key: str) -> str | None:
    """The one-liner for a call: cached, or joined to the generation already running for it."""
    hit = cached(key)
    if hit:
        return hit
    if key in _inflight:                      # two identical calls in flight share one generation
        return await _inflight[key]
    fut = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    out = None
    try:
        out = await asyncio.to_thread(_chat, TOOL_SYS, _brief(name, inp), 192)
        if out:
            db.run("INSERT OR REPLACE INTO summaries(key,text,ts) VALUES(?,?,?)",
                   (key, out, time.time()))
    finally:
        _inflight.pop(key, None)
        fut.set_result(out)   # waiters must never hang, even if the generation raised
    return out


def eta_ms(name: str, key: str) -> int | None:
    """How long this call took last time. The tool's own history is the fallback; three samples
    minimum, so a progress bar is never drawn from a single lucky observation. Replays are left
    out — a fixture ticks at its own rate, so its durations never happened."""
    for where, arg in (("c.sig=?", key), ("c.name=?", name)):
        rows = db.q(f"SELECT (c.ended_at - c.started_at) * 1000 AS d FROM tool_calls c "
                    f"JOIN runs r ON r.id = c.run_id "
                    f"WHERE {where} AND c.ended_at IS NOT NULL AND r.replay = 0 "
                    f"ORDER BY c.started_at DESC LIMIT 20", (arg,))
        if len(rows) >= 3:
            ds = sorted(r["d"] for r in rows)
            return round(ds[len(ds) // 2])
    return None


# ---------------------------------------------------------------- edits

def summarize(edit: dict, snippet: str) -> str:
    """Small-model recap of one edit; falls back to a local heuristic when no model is served."""
    name = Path(edit["path"]).name
    out = _chat(EDIT_SYS, f"tool={edit['tool']} file={name}\n---\n{snippet[:1200]}", 192)
    if out:
        return out
    verb = {"Write": "wrote", "Edit": "patched", "MultiEdit": "patched",
            "NotebookEdit": "patched"}.get(edit["tool"], "touched")
    head = next((l.strip() for l in snippet.splitlines()
                 if l.strip() and not l.strip().startswith(("#", "//"))), "")
    return f"{verb} {name} · {edit.get('bytes', 0)}B" + (f" · {head[:44]}" if head else "")
