"""Read Claude Code's own local transcript store so past sessions can be browsed and resumed.

Claude Code writes every session to ~/.claude/projects/<slug>/<session-id>.jsonl, with subagent
sidechains under <session-id>/subagents/agent-*.jsonl (each with a .meta.json naming the tool call
that spawned it). Because the CLI owns that store, an imported session is resumable: passing its id
to `claude -p --resume` continues the real conversation.
"""
import json
import re
from datetime import datetime
from pathlib import Path

from .config import INLINE_RESULT_CHARS

STORE = Path.home() / ".claude" / "projects"
_cache: dict[str, tuple[int, list]] = {}


def _ts(v) -> float:
    if isinstance(v, (int, float)):
        return float(v) / (1000 if v > 1e11 else 1)
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


# CLI plumbing that ends up in the transcript as user text but is not a prompt
NOISE = re.compile(
    r"<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|"
    r"system-reminder|user-prompt-submit-hook)>.*?</\1>|<[a-z-]+/>",
    re.S,
)


def clean(text: str) -> str:
    return NOISE.sub("", text or "").strip()


def _blocks(rec: dict) -> list[dict]:
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return [b for b in (c or []) if isinstance(b, dict)]


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    return "" if content is None else str(content)


def _read(path: Path) -> list[dict]:
    out = []
    try:
        with path.open(errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except OSError:
        pass
    return out


def _main_files() -> list[Path]:
    return sorted(STORE.glob("*/*.jsonl")) if STORE.is_dir() else []


def _sub_meta(path: Path) -> dict[str, dict]:
    d = path.with_suffix("") / "subagents"
    out = {}
    for meta in sorted(d.glob("*.meta.json")) if d.is_dir() else []:
        try:
            m = json.loads(meta.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if m.get("toolUseId"):
            out[m["toolUseId"]] = {"meta": m, "file": meta.parent / (meta.name[:-len(".meta.json")] + ".jsonl")}
    return out


def summarise(path: Path) -> dict | None:
    recs = _read(path)
    if not recs:
        return None
    cwd = title = model = branch = version = ""
    first = last = 0.0
    prompts, steps = [], []
    tokens = {"input_tokens": 0, "output_tokens": 0,
              "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    assistants = errors = 0
    results: dict[str, bool] = {}

    for r in recs:
        if r.get("type") == "ai-title" and r.get("aiTitle"):
            title = r["aiTitle"]
        t = _ts(r.get("timestamp"))
        if t:
            first = first or t
            last = max(last, t)
        cwd = r.get("cwd") or cwd
        branch = r.get("gitBranch") or branch
        version = r.get("version") or version
        if r.get("isSidechain"):
            continue
        if r.get("type") == "assistant":
            assistants += 1
            model = (r.get("message") or {}).get("model") or model
            for k, v in ((r.get("message") or {}).get("usage") or {}).items():
                if k in tokens and isinstance(v, int):
                    tokens[k] += v
            for b in _blocks(r):
                if b.get("type") == "tool_use":
                    steps.append({"name": b.get("name", "?"), "id": b.get("id")})
        elif r.get("type") == "user":
            bs = _blocks(r)
            for b in bs:
                if b.get("type") == "tool_result":
                    results[b.get("tool_use_id")] = bool(b.get("is_error"))
                    errors += 1 if b.get("is_error") else 0
            if any(b.get("type") == "text" for b in bs):
                c = clean(_text((r.get("message") or {}).get("content")))
                if c:
                    prompts.append(c[:400])

    sub_ids = set(_sub_meta(path))
    return {
        "session_id": path.stem, "cwd": cwd or path.parent.name,
        "title": title or (prompts[0] if prompts else path.stem),
        "started_at": first, "last_at": last or first, "runs": max(1, len(prompts)),
        "cost_usd": None, "duration_ms": int((last - first) * 1000), "turns": assistants,
        "status": "imported", "replay": False, "errors": errors, "imported": True,
        "model": model, "branch": branch, "version": version, "tokens": tokens,
        "prompts": prompts or [title or path.stem],
        "steps": [{"name": s["name"], "err": results.get(s["id"], False), "sub": s["id"] in sub_ids}
                  for s in steps[:60]],
    }


def index(force: bool = False) -> list[dict]:
    files = _main_files()
    stamp = hash(str(sorted((str(f), f.stat().st_mtime) for f in files)))
    hit = _cache.get("index")
    if hit and not force and hit[0] == stamp:
        return hit[1]
    out = [s for s in (summarise(f) for f in files) if s]
    out.sort(key=lambda s: -s["last_at"])
    _cache["index"] = (stamp, out)
    return out


def load(session_id: str):
    """Rebuild one stored session as console turns, subagent sidechains nested under their call."""
    path = next((f for f in _main_files() if f.stem == session_id), None)
    if not path:
        return None
    recs = _read(path)
    cwd = next((r.get("cwd") for r in recs if r.get("cwd")), "")
    turns: list[dict] = []
    seq = 0
    group = 0

    def frame(kind: str, ts: float, **body) -> dict:
        nonlocal seq
        seq += 1
        return {"seq": seq, "ts": ts, "kind": kind, **body}

    def result_frame(b: dict, ts: float, parent):
        raw = _text(b.get("content"))
        return frame("tool.result", ts, id=b.get("tool_use_id"), parent=parent,
                     is_error=bool(b.get("is_error")), text=raw[:INLINE_RESULT_CHARS],
                     chars=len(raw), lines=raw.count("\n") + 1,
                     truncated=len(raw) > INLINE_RESULT_CHARS, duration_ms=None, name=None)

    def new_turn(prompt: str, ts: float) -> dict:
        t = {"id": f"{session_id}--{len(turns)}", "session_id": session_id, "prev_session_id": None,
             "cwd": cwd, "prompt": prompt, "started_at": ts, "ended_at": ts, "status": "finished",
             "error": None, "result": None, "cost_usd": None, "duration_ms": 0,
             "api_duration_ms": None, "num_turns": 0, "usage": {}, "phases": {}, "timing": {},
             "options": {}, "replay": 0, "imported": True, "live": False, "frames": []}
        turns.append(t)
        return t

    cur = None
    for r in recs:
        if r.get("isSidechain"):
            continue
        ts = _ts(r.get("timestamp"))
        if r.get("type") == "user":
            bs = _blocks(r)
            if any(b.get("type") == "text" for b in bs):
                c = clean(_text((r.get("message") or {}).get("content")))
                if c:
                    cur = new_turn(c, ts)
                continue
            if cur is None:
                continue
            for b in bs:
                if b.get("type") == "tool_result":
                    cur["frames"].append(result_frame(b, ts, None))
        elif r.get("type") == "assistant":
            if cur is None:
                cur = new_turn("(session start)", ts)
            cur["num_turns"] += 1
            group += 1
            for k, v in ((r.get("message") or {}).get("usage") or {}).items():
                if isinstance(v, int):
                    cur["usage"][k] = cur["usage"].get(k, 0) + v
            for b in _blocks(r):
                if b.get("type") == "text" and b.get("text", "").strip():
                    cur["frames"].append(frame("text", ts, parent=None, group=group, text=b["text"]))
                elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                    cur["frames"].append(frame("thinking", ts, parent=None, group=group, text=b["thinking"]))
                elif b.get("type") == "tool_use":
                    cur["frames"].append(frame("tool.call", ts, id=b.get("id"), parent=None, group=group,
                                               name=b.get("name", "?"), input=b.get("input") or {}))
        if cur and ts:
            cur["ended_at"] = ts

    for tid, blob in _sub_meta(path).items():
        host = next((t for t in turns if any(f.get("id") == tid for f in t["frames"])), None)
        if not host:
            continue
        for r in _read(blob["file"]):
            ts = _ts(r.get("timestamp"))
            if r.get("type") == "assistant":
                group += 1
                for b in _blocks(r):
                    if b.get("type") == "text" and b.get("text", "").strip():
                        host["frames"].append(frame("text", ts, parent=tid, group=group, text=b["text"]))
                    elif b.get("type") == "tool_use":
                        host["frames"].append(frame("tool.call", ts, id=b.get("id"), parent=tid, group=group,
                                                    name=b.get("name", "?"), input=b.get("input") or {}))
            elif r.get("type") == "user":
                for b in _blocks(r):
                    if b.get("type") == "tool_result":
                        host["frames"].append(result_frame(b, ts, tid))

    for t in turns:
        t["duration_ms"] = int((t["ended_at"] - t["started_at"]) * 1000)
    return {"session_id": session_id, "cwd": cwd, "imported": True, "runs": turns}
