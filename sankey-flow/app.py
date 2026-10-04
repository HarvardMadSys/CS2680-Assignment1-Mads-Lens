#!/usr/bin/env python3
"""Flask frontend for headless Claude Code.

For every prompt the server runs

    claude -p "<prompt>" --output-format stream-json --verbose --dangerously-skip-permissions \
        --include-partial-messages

as a subprocess with the chosen working directory as ``cwd``. It reads the
process's JSONL event stream line by line and relays each event to the browser
over Server-Sent Events the moment it arrives, so the page updates while Claude
is still working. ``--include-partial-messages`` adds token-level
``stream_event`` lines (message_start, content_block_delta, message_delta,
message_stop, ...) which the browser uses for its pace metrics (TTFT, TPOT,
latency); they pass through untouched like every other event. Follow-up
prompts pass ``--resume <session_id>`` so they continue the same Claude
session.

An optional per-run *policy* adds ``--max-budget-usd <amount>``, ``--tools
<comma-joined names>`` and ``--disallowedTools <pattern>...`` (see
``validate_policy`` and ``build_command``).

Run with ``python3 app.py`` and open http://localhost:8000 (it listens on 0.0.0.0:8000;
override with the ``HOST`` / ``PORT`` environment variables or ``--host`` / ``--port``).
``python3 app.py --demo`` reads the bundled demo session in ``demo/claude-projects``
instead of ``~/.claude/projects``.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, abort, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent  # the folder this app lives in
# Where the directory picker starts on first launch: a scratch folder next to the app (created on start-up),
# so a live run with --dangerously-skip-permissions does not default to somewhere that matters.
START_DIR = Path(os.environ.get("CLAUDE_FRONTEND_WORKDIR", str(BASE_DIR / "workspace"))).expanduser()
DEMO_PROJECTS = BASE_DIR / "demo" / "claude-projects"
try:
    START_DIR.mkdir(parents=True, exist_ok=True)
except OSError as exc:
    print(f"Could not create the scratch workspace {START_DIR}: {exc}")

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
# Extra quick-jump roots for the directory picker (os.pathsep-separated).
EXTRA_DIRS = os.environ.get("CLAUDE_FRONTEND_DIRS", "")
HOME = Path.home()
# Claude Code's transcript store: one <project>/<session-id>.jsonl per session.
CLAUDE_PROJECTS = Path(os.environ.get("CLAUDE_PROJECTS_DIR", str(HOME / ".claude" / "projects"))).expanduser()
# A nested Claude Code refuses to start when it thinks it is already inside one.
STRIP_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT")

app = Flask(__name__, static_folder="static", template_folder="templates")


# --------------------------------------------------------------------------- #
# Working directories: the whole machine, browsed one level at a time
# --------------------------------------------------------------------------- #
def resolve_dir(raw: str | None) -> Path | None:
    """Any existing directory on this machine, or None if the path is missing or not a directory."""
    if not raw:
        return None
    try:
        p = Path(raw).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    return p if p.is_dir() else None


def quick_roots() -> list[dict]:
    """Entry points for the picker: the usual user folders that exist, this repo, and the disk root."""
    candidates: list[tuple[str, Path]] = [
        ("Home", HOME),
        ("Desktop", HOME / "Desktop"),
        ("Documents", HOME / "Documents"),
        ("Downloads", HOME / "Downloads"),
        ("Developer", HOME / "Developer"),
        ("Scratch workspace", START_DIR),
        ("Disk root", Path(Path.home().anchor)),
    ]
    for raw in EXTRA_DIRS.split(os.pathsep):
        if raw:
            p = Path(raw).expanduser()
            candidates.append((p.name or raw, p))
    out: list[dict] = []
    seen: set[Path] = set()
    for label, p in candidates:
        d = resolve_dir(str(p))
        if d is None or d in seen:
            continue
        seen.add(d)
        out.append({"label": label, "path": str(d)})
    return out


def list_subdirs(d: Path, show_hidden: bool = False) -> list[dict]:
    """Visible subdirectories of ``d``; unreadable folders simply list as empty."""
    try:
        entries = list(d.iterdir())
    except OSError:  # permission denied, vanished, etc.
        return []
    out: list[dict] = []
    for c in entries:
        if not show_hidden and c.name.startswith("."):
            continue
        try:
            if not c.is_dir():
                continue
        except OSError:
            continue
        out.append({"name": c.name, "path": str(c)})
    out.sort(key=lambda x: x["name"].lower())
    return out


# --------------------------------------------------------------------------- #
# Previous sessions: read Claude Code's own transcripts
# --------------------------------------------------------------------------- #
# Transcript lines look like {"type": "user"|"assistant", "message": {...}, "timestamp", "uuid",
# "cwd", "sessionId", "isSidechain", "toolUseResult", ...} plus housekeeping lines
# ("ai-title", "cost-state", "attachment", ...). Subagent transcripts live in
# <project>/<session-id>/subagents/agent-<id>.jsonl, and the matching .meta.json names the
# Agent tool call that spawned them.

_SESSION_CACHE: dict[str, tuple[tuple[int, int], dict]] = {}
AGENT_TOOLS = ("Agent", "Task")


def _iter_jsonl(path: Path):
    with path.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def _prompt_text(content) -> str | None:
    """Human prompt text from a user message; None for tool results or empty content."""
    if isinstance(content, str):
        return content.strip() or None
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        text = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text").strip()
        return text or None
    return None


def summarize_session(path: Path) -> dict:
    """Cheap per-file summary for the session list, cached by (mtime, size)."""
    st = path.stat()
    key = (st.st_mtime_ns, st.st_size)
    cached = _SESSION_CACHE.get(str(path))
    if cached and cached[0] == key:
        return cached[1]
    info: dict = {
        "session_id": path.stem,
        "cwd": None,
        "title": None,
        "first_prompt": None,
        "prompts": 0,
        "assistant_messages": 0,
        "subagents": 0,
        "started": None,
        "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
        "size": st.st_size,
        "cost_usd": None,
        "version": None,
        "continued_in": None,
    }
    msg_ids: set[str] = set()
    for e in _iter_jsonl(path):
        t = e.get("type")
        if info["cwd"] is None and e.get("cwd"):
            info["cwd"] = e["cwd"]
        if info["version"] is None and e.get("version"):
            info["version"] = e["version"]
        if info["started"] is None and e.get("timestamp"):
            info["started"] = e["timestamp"]
        message = e.get("message") or {}
        if t == "ai-title" and e.get("aiTitle"):
            info["title"] = e["aiTitle"]
        elif t == "user" and not e.get("isSidechain") and not e.get("isMeta"):  # isMeta: injected harness text
            text = _prompt_text(message.get("content"))
            if text:
                info["prompts"] += 1
                if info["first_prompt"] is None:
                    info["first_prompt"] = text
        elif t == "assistant":
            if message.get("id"):
                msg_ids.add(message["id"])
            for b in message.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in AGENT_TOOLS:
                    info["subagents"] += 1
        elif t == "cost-state" and e.get("totalCostUSD") is not None:
            info["cost_usd"] = e["totalCostUSD"]
        elif t == "continued-in":
            info["continued_in"] = e.get("continuedInSessionId")
    info["assistant_messages"] = len(msg_ids)
    if not info["title"]:
        info["title"] = (info["first_prompt"] or "").split("\n")[0][:100] or None
    _SESSION_CACHE[str(path)] = (key, info)
    return info


def list_sessions(cwd: Path | None, limit: int = 300) -> list[dict]:
    """Sessions for one working directory (or all of them when cwd is None), newest first."""
    out: list[dict] = []
    if not CLAUDE_PROJECTS.is_dir():
        return out
    wanted = os.path.realpath(cwd) if cwd is not None else None
    for project in CLAUDE_PROJECTS.iterdir():
        if not project.is_dir():
            continue
        for f in project.glob("*.jsonl"):
            try:
                info = summarize_session(f)
            except OSError:
                continue
            if not info["prompts"]:
                continue  # title-only stubs and aborted starts
            if wanted is not None and (not info["cwd"] or os.path.realpath(info["cwd"]) != wanted):
                continue
            out.append(info)
    out.sort(key=lambda s: s["modified"], reverse=True)
    return out[:limit]


def find_session_file(session_id: str) -> Path | None:
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", session_id) or not CLAUDE_PROJECTS.is_dir():
        return None
    for project in CLAUDE_PROJECTS.iterdir():
        f = project / f"{session_id}.jsonl"
        if f.is_file():
            return f
    return None


def _subagent_files(session_file: Path) -> dict[str, Path]:
    """Agent tool_use id -> that subagent's transcript, via the .meta.json next to it."""
    out: dict[str, Path] = {}
    d = session_file.with_suffix("") / "subagents"
    if not d.is_dir():
        return out
    for meta in d.glob("agent-*.meta.json"):
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        jl = meta.with_name(meta.name[: -len(".meta.json")] + ".jsonl")
        if m.get("toolUseId") and jl.is_file():
            out[m["toolUseId"]] = jl
    return out


def _to_stream_event(e: dict, parent_tool_use_id: str | None) -> dict | None:
    """Transcript line -> the stream-json shape the browser already knows how to render."""
    t = e.get("type")
    if t in ("assistant", "user"):
        ev = {
            "type": t,
            "message": e.get("message") or {},
            "parent_tool_use_id": parent_tool_use_id,
            "timestamp": e.get("timestamp"),
            "uuid": e.get("uuid"),
            "session_id": e.get("sessionId"),
        }
        if e.get("toolUseResult") is not None:
            ev["tool_use_result"] = e["toolUseResult"]
        return ev
    if t == "system" and e.get("subtype") in ("compact_boundary", "api_error", "permission_denied"):
        return {"type": "system", "subtype": e["subtype"], "parent_tool_use_id": parent_tool_use_id, "timestamp": e.get("timestamp")}
    return None


def session_events(session_file: Path) -> dict:
    """Replay a transcript as stream-json events, one 'replay_prompt' per human turn."""
    subagents = _subagent_files(session_file)
    events: list[dict] = []
    meta: dict = {"session_id": session_file.stem, "cwd": None, "title": None, "model": None, "cost_usd": None, "version": None}
    turn: dict | None = None
    seen_msgs: set[str] = set()

    def account(t: dict, e: dict) -> None:
        if e.get("timestamp"):
            t["ended"] = e["timestamp"]
        if e.get("type") != "assistant":
            return
        message = e.get("message") or {}
        mid = message.get("id")
        if not mid or mid in seen_msgs:
            return
        seen_msgs.add(mid)
        if not e.get("isSidechain"):
            t["assistant_messages"] += 1
        usage = message.get("usage") or {}
        t["output_tokens"] += usage.get("output_tokens") or 0
        t["thinking_tokens"] += (usage.get("output_tokens_details") or {}).get("thinking_tokens") or 0
        context = (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
        t["context_tokens"] = max(t["context_tokens"], context)
        if meta["model"] is None and message.get("model"):
            meta["model"] = message["model"]

    def open_turn(text: str, ts: str | None) -> dict:
        events.append({"type": "replay_prompt", "text": text, "timestamp": ts})
        return {"assistant_messages": 0, "output_tokens": 0, "thinking_tokens": 0, "context_tokens": 0, "started": ts, "ended": ts}

    def close_turn() -> None:
        nonlocal turn
        if turn is None:
            return
        duration = None
        try:
            if turn["started"] and turn["ended"]:
                a = datetime.fromisoformat(turn["started"].replace("Z", "+00:00"))
                b = datetime.fromisoformat(turn["ended"].replace("Z", "+00:00"))
                duration = int((b - a).total_seconds() * 1000)
        except ValueError:
            pass
        events.append({"type": "replay_turn_end", **turn, "duration_ms": duration})
        turn = None

    for e in _iter_jsonl(session_file):
        t = e.get("type")
        if meta["cwd"] is None and e.get("cwd"):
            meta["cwd"] = e["cwd"]
        if meta["version"] is None and e.get("version"):
            meta["version"] = e["version"]
        if t == "ai-title":
            meta["title"] = e.get("aiTitle") or meta["title"]
            continue
        if t == "cost-state":
            meta["cost_usd"] = e.get("totalCostUSD")
            continue
        if t == "user" and not e.get("isSidechain") and not e.get("isMeta"):  # isMeta: injected harness text
            text = _prompt_text((e.get("message") or {}).get("content"))
            if text is not None:
                close_turn()
                turn = open_turn(text, e.get("timestamp"))
                continue
        ev = _to_stream_event(e, None)
        if ev is None:
            continue
        if turn is None:
            turn = open_turn("(continued from an earlier context)", e.get("timestamp"))
        account(turn, e)
        events.append(ev)
        if t == "assistant":
            for b in (e.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id") in subagents:
                    for se in _iter_jsonl(subagents[b["id"]]):
                        sev = _to_stream_event(se, b["id"])
                        if sev is not None:
                            account(turn, se)
                            events.append(sev)
    close_turn()
    if not meta["title"]:
        first = next((ev["text"] for ev in events if ev["type"] == "replay_prompt"), "")
        meta["title"] = first.split("\n")[0][:100] or None
    return {**meta, "events": events}


# --------------------------------------------------------------------------- #
# Policy: per-run budget cap, allowed built-in tools and deny patterns
# --------------------------------------------------------------------------- #
# The browser sends {"max_budget_usd": number|null, "tools": [names]|null, "deny": [patterns]}.
#   max_budget_usd -> --max-budget-usd <amount>      (Claude stops the run once the cap is exceeded)
#   tools          -> --tools <comma-joined names>    (null = flag omitted = every built-in tool;
#                                                      [] = --tools "" = no built-in tools at all)
#   deny           -> --disallowedTools <p1> <p2> ... (permission patterns such as "Bash(git push *)")
POLICY_TOOL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
POLICY_MAX_BUDGET_USD = 1000.0
POLICY_MAX_DENY_RULES = 50
POLICY_MAX_DENY_LEN = 200
EMPTY_POLICY: dict = {"max_budget_usd": None, "tools": None, "deny": []}


# Bounds for policy.tools, mirroring the deny-rule limits, so a crafted request cannot build an
# oversized argv (which would surface as a misleading "could not start claude" instead of a 400).
POLICY_MAX_TOOLS = 100
POLICY_MAX_TOOLS_LEN = 4000


def validate_policy(raw) -> tuple[dict | None, str | None]:
    """Normalize the optional policy object from POST /api/run.

    Returns ``(policy, None)`` with every key present, or ``(None, message)`` when the input is
    malformed so the route can answer 400 with a clear reason.
    """
    if raw is None:
        return dict(EMPTY_POLICY), None
    if not isinstance(raw, dict):
        return None, "policy must be an object."

    budget = raw.get("max_budget_usd")
    if budget is not None:
        if isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget):
            return None, "policy.max_budget_usd must be a finite number of US dollars (or null for no cap)."
        if not 0 < budget <= POLICY_MAX_BUDGET_USD:
            return None, f"policy.max_budget_usd must be greater than 0 and at most {POLICY_MAX_BUDGET_USD:g}."
        budget = float(budget)

    tools = raw.get("tools")
    if tools is not None:
        if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
            return None, "policy.tools must be null (no restriction) or a list of tool names."
        if len(tools) > POLICY_MAX_TOOLS:
            return None, f"policy.tools may list at most {POLICY_MAX_TOOLS} tool names."
        if sum(len(t) for t in tools) > POLICY_MAX_TOOLS_LEN:
            return None, f"policy.tools is too long: at most {POLICY_MAX_TOOLS_LEN} characters of tool names in total."
        cleaned_tools: list[str] = []
        for t in tools:
            t = t.strip()
            if not POLICY_TOOL_NAME.fullmatch(t):
                return None, f"policy.tools contains an invalid tool name {t!r}: use letters, digits and underscores, starting with a letter."
            if t not in cleaned_tools:
                cleaned_tools.append(t)
        tools = cleaned_tools

    deny = raw.get("deny")
    if deny is None:
        deny = []
    if not isinstance(deny, list) or not all(isinstance(d, str) for d in deny):
        return None, "policy.deny must be a list of pattern strings."
    if len(deny) > POLICY_MAX_DENY_RULES:
        return None, f"policy.deny may hold at most {POLICY_MAX_DENY_RULES} patterns."
    cleaned_deny: list[str] = []
    for d in deny:
        d = d.strip()
        if not d:
            return None, "policy.deny patterns must not be empty."
        if "\n" in d or "\r" in d:
            return None, "policy.deny patterns must be single-line."
        if len(d) > POLICY_MAX_DENY_LEN:
            return None, f"policy.deny patterns must be at most {POLICY_MAX_DENY_LEN} characters each."
        if d.startswith("-"):
            return None, f"policy.deny pattern {d!r} must not start with '-'."
        if d not in cleaned_deny:
            cleaned_deny.append(d)
    return {"max_budget_usd": budget, "tools": tools, "deny": cleaned_deny}, None


def format_usd(amount: float) -> str:
    """A plain decimal for the CLI: 1 -> '1', 0.25 -> '0.25' (no exponent notation for normal values)."""
    s = f"{amount:.6f}".rstrip("0").rstrip(".")
    return s if s and s != "0" else repr(amount)


# --------------------------------------------------------------------------- #
# Runs: one headless claude subprocess per prompt
# --------------------------------------------------------------------------- #
class Run:
    def __init__(self, run_id: str, prompt: str, cwd: Path, resume: str | None, policy: dict | None = None):
        self.id = run_id
        self.prompt = prompt
        self.cwd = cwd
        self.resume = resume
        self.policy = policy if policy is not None else dict(EMPTY_POLICY)
        self.session_id = resume
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.done = False
        self.stopped = False
        self.exit_code: int | None = None
        self.proc: subprocess.Popen | None = None
        self.started = time.time()

    def push(self, event: dict) -> None:
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    def finish(self) -> None:
        with self.cond:
            self.done = True
            self.cond.notify_all()


RUNS: dict[str, Run] = {}
RUNS_LOCK = threading.Lock()


def build_command(prompt: str, resume: str | None, policy: dict | None = None) -> list[str]:
    """The claude argv. Always a list (never a shell string) so prompts and patterns need no quoting."""
    cmd = [
        CLAUDE_BIN,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--include-partial-messages",  # token-level stream_event lines for the pace metrics
    ]
    if resume:
        cmd += ["--resume", resume]
    policy = policy or EMPTY_POLICY
    if policy.get("max_budget_usd") is not None:
        cmd += ["--max-budget-usd", format_usd(policy["max_budget_usd"])]
    if policy.get("tools") is not None:  # [] gives --tools "" which disables every built-in tool
        cmd += ["--tools", ",".join(policy["tools"])]
    if policy.get("deny"):
        # --disallowedTools is variadic: one argv element per pattern, and last so it swallows nothing else.
        cmd += ["--disallowedTools", *policy["deny"]]
    return cmd


def run_claude(run: Run) -> None:
    """Spawn claude, stream its stdout JSONL into run.events, then mark the run done."""
    cmd = build_command(run.prompt, run.resume, run.policy)
    env = {k: v for k, v in os.environ.items() if k not in STRIP_ENV}
    run.push(
        {
            "type": "run_started",
            "run_id": run.id,
            "cwd": str(run.cwd),
            "resume": run.resume,
            "policy": run.policy,
            "command": cmd[:1] + ["-p", "<prompt>"] + cmd[3:],
            "timestamp": time.time(),
        }
    )
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(run.cwd),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        run.exit_code = 127
        run.push({"type": "run_exit", "exit_code": 127, "error": f"Could not start '{CLAUDE_BIN}': {exc}"})
        run.finish()
        return

    run.proc = proc
    stderr_lines: list[str] = []

    def pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.rstrip("\n")
            if line:
                stderr_lines.append(line)
                run.push({"type": "stderr", "text": line})

    stderr_thread = threading.Thread(target=pump_stderr, daemon=True)
    stderr_thread.start()

    assert proc.stdout is not None
    for line in proc.stdout:  # line-buffered: each line is one JSON event
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            run.push({"type": "stdout", "text": line})
            continue
        if not isinstance(event, dict):
            run.push({"type": "stdout", "text": line})
            continue
        if event.get("session_id"):
            run.session_id = event["session_id"]
        run.push(event)

    exit_code = proc.wait()
    stderr_thread.join(timeout=2)
    run.exit_code = exit_code
    run.push(
        {
            "type": "run_exit",
            "exit_code": exit_code,
            "stopped": run.stopped,
            "session_id": run.session_id,
            "stderr_tail": stderr_lines[-15:],
            "elapsed_ms": int((time.time() - run.started) * 1000),
        }
    )
    run.finish()


def sse_stream(run: Run, index: int):
    """Yield run.events[index:] as SSE frames, waiting for new ones until the run is done."""
    while True:
        timed_out = False
        with run.cond:
            while index >= len(run.events) and not run.done:
                if not run.cond.wait(timeout=15):
                    timed_out = True
                    break
            batch = run.events[index:]
            done = run.done
        for offset, event in enumerate(batch):
            yield f"id: {index + offset}\ndata: {json.dumps(event)}\n\n"
        index += len(batch)
        if done and index >= len(run.events):
            yield "event: end\ndata: {}\n\n"
            return
        if timed_out and not batch:
            yield ": keep-alive\n\n"


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/dirs")
def api_dirs():
    """One level of the file system: ``?path=<dir>`` (defaults to the scratch workspace), ``&hidden=1`` to include dotfolders."""
    raw = request.args.get("path") or str(START_DIR)
    d = resolve_dir(raw)
    if d is None:
        # 200 with an error field: probing a missing folder (e.g. a reopened session's old cwd) is not a failure
        return jsonify({"error": f"Not a directory: {raw}", "missing": True})
    show_hidden = request.args.get("hidden") in ("1", "true")
    return jsonify(
        {
            "path": str(d),
            "parent": str(d.parent) if d.parent != d else None,
            "children": list_subdirs(d, show_hidden),
            "roots": quick_roots(),
        }
    )


@app.get("/api/sessions")
def api_sessions():
    """Previous sessions for ``?path=<dir>`` (default: the scratch workspace), or every session with ``?all=1``."""
    everything = request.args.get("all") in ("1", "true")
    cwd = None
    if not everything:
        raw = request.args.get("path") or str(START_DIR)
        cwd = resolve_dir(raw)
        if cwd is None:
            return jsonify({"error": f"Not a directory: {raw}"}), 404
    return jsonify({"sessions": list_sessions(cwd), "scope": None if cwd is None else str(cwd), "store": str(CLAUDE_PROJECTS)})


@app.get("/api/sessions/<session_id>")
def api_session_events(session_id: str):
    """A past session replayed as stream-json events (see session_events)."""
    f = find_session_file(session_id)
    if f is None:
        return jsonify({"error": "Session not found in the transcript store."}), 404
    return jsonify(session_events(f))


@app.post("/api/run")
def api_run():
    body = request.get_json(silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "Prompt is empty."}), 400
    cwd = resolve_dir(body.get("cwd"))
    if cwd is None:
        return jsonify({"error": "Working directory does not exist or is not a directory."}), 400
    resume = (body.get("session_id") or "").strip() or None
    policy, policy_error = validate_policy(body.get("policy"))
    if policy_error:
        return jsonify({"error": policy_error}), 400

    run = Run(uuid.uuid4().hex[:12], prompt, cwd, resume, policy)
    with RUNS_LOCK:
        RUNS[run.id] = run
    threading.Thread(target=run_claude, args=(run,), daemon=True).start()
    return jsonify({"run_id": run.id})


@app.get("/api/stream/<run_id>")
def api_stream(run_id: str):
    run = RUNS.get(run_id)
    if run is None:
        abort(404)
    start = 0
    last_id = request.headers.get("Last-Event-ID")
    if last_id and last_id.isdigit():
        start = int(last_id) + 1
    return Response(
        sse_stream(run, start),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/api/stop/<run_id>")
def api_stop(run_id: str):
    run = RUNS.get(run_id)
    if run is None:
        abort(404)
    proc = run.proc
    if proc is not None and proc.poll() is None:
        run.stopped = True
        proc.terminate()

        def hard_kill() -> None:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()

        threading.Thread(target=hard_kill, daemon=True).start()
    return jsonify({"ok": True})


@app.get("/api/runs/<run_id>")
def api_run_status(run_id: str):
    run = RUNS.get(run_id)
    if run is None:
        abort(404)
    return jsonify(
        {
            "run_id": run.id,
            "cwd": str(run.cwd),
            "session_id": run.session_id,
            "policy": run.policy,
            "done": run.done,
            "stopped": run.stopped,
            "exit_code": run.exit_code,
            "events": len(run.events),
        }
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sankey Flow: a web frontend for headless Claude Code.")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="interface to bind (env HOST, default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")), help="port to listen on (env PORT, default 8000)")
    parser.add_argument("--demo", action="store_true", help=f"list the bundled demo session ({DEMO_PROJECTS}) instead of ~/.claude/projects")
    args = parser.parse_args()
    if args.demo:
        CLAUDE_PROJECTS = DEMO_PROJECTS
    shown = "localhost" if args.host in ("0.0.0.0", "::", "") else args.host
    print(f"Claude Code frontend: http://{shown}:{args.port}  (listening on {args.host}:{args.port})")
    print(f"  working directory picker starts in {START_DIR}; any directory can be chosen")
    print(f"  sessions are read from {CLAUDE_PROJECTS}")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)
